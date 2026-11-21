import { config, upstreamKeyRing } from "../config.js";
import { getLogger } from "../lib/logger.js";
import { sendUpstream } from "../lib/upstreamClient.js";
import { decryptSecret } from "../utils/secretBox.js";
import {
  healthCheckUrl,
  listApisForHealthCheck,
  recordHealthCheck,
  type ApiRow,
} from "../services/apiService.js";

// Upstream health checks (#35). Each listed API with a healthPath is pinged on
// an interval; after HEALTH_CHECK_FAILURE_THRESHOLD consecutive failures it is
// marked unhealthy, which hides it from GET /apis and makes the proxy answer
// 503 before asking for payment. One successful check brings it back.
//
// Runs in every replica; checks are idempotent, so duplicates only add load.

const CONCURRENCY = 5;

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let running = false;

export function startHealthCheckWorker(): void {
  if (config.HEALTH_CHECK_INTERVAL_MS <= 0) return;
  getLogger().info(
    { event: "health_worker_start", intervalMs: config.HEALTH_CHECK_INTERVAL_MS },
    "starting upstream health-check worker",
  );
  void tick();
  intervalHandle = setInterval(() => void tick(), config.HEALTH_CHECK_INTERVAL_MS);
}

export function stopHealthCheckWorker(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

/** One check: any 2xx/3xx within the timeout counts as healthy. */
export async function checkApiHealth(api: ApiRow): Promise<boolean> {
  const headers: Record<string, string> = { "user-agent": "ZentrixPay-HealthCheck/1" };
  // Upstreams locked down to the secret header need it on health checks too.
  if (api.upstreamHeaderName && api.upstreamHeaderValueEnc && upstreamKeyRing.length > 0) {
    headers[api.upstreamHeaderName] = decryptSecret(
      api.upstreamHeaderValueEnc,
      upstreamKeyRing,
      config.UPSTREAM_SECRET_KEY,
    );
  }
  try {
    const url = new URL(healthCheckUrl(api));
    // ...and upstreams that authenticate with a secret query parameter (e.g. ?api_key=)
    // need it on the health-check URL, matching what the proxy sends.
    if (api.upstreamQueryName && api.upstreamQueryValueEnc && upstreamKeyRing.length > 0) {
      url.searchParams.set(
        api.upstreamQueryName,
        decryptSecret(api.upstreamQueryValueEnc, upstreamKeyRing, config.UPSTREAM_SECRET_KEY),
      );
    }
    const res = await sendUpstream({
      url: url.toString(),
      method: "GET",
      headers,
      timeoutMs: config.HEALTH_CHECK_TIMEOUT_MS,
      maxResponseBytes: 64 * 1024,
      allowPrivate: config.PROXY_ALLOW_PRIVATE_UPSTREAMS,
    });
    return res.status >= 200 && res.status < 400;
  } catch {
    return false;
  }
}

async function checkOne(api: ApiRow): Promise<void> {
  const ok = await checkApiHealth(api);
  const updated = await recordHealthCheck(api, ok, config.HEALTH_CHECK_FAILURE_THRESHOLD);
  if (updated.healthy !== api.healthy) {
    getLogger().warn(
      {
        event: updated.healthy ? "api_upstream_recovered" : "api_upstream_unhealthy",
        apiId: api.id,
        failures: updated.healthFailures,
      },
      updated.healthy ? "upstream healthy again; API relisted" : "upstream unhealthy; API hidden",
    );
  }
}

async function tick(): Promise<void> {
  // Skip a tick rather than overlap when checks run longer than the interval.
  if (running) return;
  running = true;
  try {
    const queue = await listApisForHealthCheck();
    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (let api = queue.shift(); api; api = queue.shift()) {
        await checkOne(api).catch((err) =>
          getLogger().error(
            { event: "health_check_error", apiId: api!.id, err },
            "health check failed to run",
          ),
        );
      }
    });
    await Promise.all(workers);
  } catch (err) {
    getLogger().error({ event: "health_worker_tick_error", err }, "health worker tick failed");
  } finally {
    running = false;
  }
}
