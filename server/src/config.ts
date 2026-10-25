import dotenv from "dotenv";

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(4021),
  BASE_URL: z.string().default("http://localhost:4021"),
  WEB_APP_URL: z.string().url().default("http://localhost:5173"),
  ALLOWED_ORIGINS: z.string().optional(),

  // Stellar / x402 — STELLAR_NETWORK selects preset defaults; individual vars may override.
  STELLAR_NETWORK: z.enum(["testnet", "mainnet"]).default("testnet"),
  NETWORK: z.string().min(1),
  FACILITATOR_URL: z.string().default("https://www.x402.org/facilitator"),
  USDC_CONTRACT_ID: z.string().min(1),

  // Soroban
  SOROBAN_RPC_URL: z.string().url("SOROBAN_RPC_URL must be a valid URL"),

  // Postgres
  DATABASE_URL: z.string().min(1, "DATABASE_URL (Postgres connection string) is required"),

  // Limits
  // Explicit JSON body limit for express.json() (e.g. "1mb", "512kb").
  MAX_JSON_BODY_SIZE: z.string().default("1mb"),

  // Soroban registry
  REGISTRY_CONTRACT_ID: z.string().min(1, "REGISTRY_CONTRACT_ID is required"),
  REGISTRY_SECRET_KEY: z
    .string()
    .min(1, "REGISTRY_SECRET_KEY (deployer / owner secret) is required"),

  // Metrics endpoint token — if set, requests to /metrics must supply it via
  // Bearer auth or ?token=. If unset, the endpoint is disabled.
  METRICS_TOKEN: z.string().optional(),

  // Sentry error tracking — when DSN is set, unhandled errors are reported.
  SENTRY_DSN: z.string().url().optional(),

  // Rate limiting (API registration)
  RATE_LIMIT_PUBLISH_IP_MAX: z.coerce.number().default(20),
  RATE_LIMIT_PUBLISH_IP_WINDOW_MS: z.coerce.number().default(60_000),
  RATE_LIMIT_PUBLISH_WALLET_MAX: z.coerce.number().default(10),
  RATE_LIMIT_PUBLISH_WALLET_WINDOW_MS: z.coerce.number().default(3_600_000),
  // Public publisher registration (POST /publishers), limited per client IP.
  RATE_LIMIT_REGISTER_IP_MAX: z.coerce.number().int().min(1).default(5),
  RATE_LIMIT_REGISTER_IP_WINDOW_MS: z.coerce.number().int().positive().default(3_600_000),

  // Optional Redis URL for a shared sliding-window rate-limit store (multi-instance).
  REDIS_URL: z.string().url().optional(),

  // Optional HMAC-SHA256 request signatures for publisher mutations (off by default).
  REQUIRE_REQUEST_SIGNATURE: envBoolean(false),
  // Max clock skew for X-Timestamp when signatures are required (default 5 minutes).
  SIGNATURE_MAX_SKEW_MS: z.coerce.number().default(300_000),

  // Per-request timeout — slow upstreams (RPC, facilitator) return 503 instead
  // of hanging the connection.
  REQUEST_TIMEOUT_MS: z.coerce.number().default(30_000),
  // Max time to drain in-flight requests on SIGTERM/SIGINT before forcing exit.
  GRACEFUL_SHUTDOWN_TIMEOUT_MS: z.coerce.number().default(10_000),
  // How long a publish Idempotency-Key is remembered so retries return the
  // original result instead of creating a duplicate (default 24h).
  IDEMPOTENCY_TTL_MS: z.coerce.number().default(86_400_000),

  // API proxy (pay-per-call gateway)
  // 32-byte key (64 hex chars) used to encrypt providers' upstream secret
  // headers at rest. Without it, APIs cannot be registered with a secret.
  // Kept for backwards-compatibility; prefer UPSTREAM_SECRET_KEYS for new
  // deployments (see #53).
  UPSTREAM_SECRET_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, "UPSTREAM_SECRET_KEY must be 64 hex characters")
    .optional(),
  // Key ring for secret rotation (#53): comma-separated "id:hex64" pairs.
  // The FIRST entry is the active key used for all new encryptions; older
  // entries remain so existing ciphertexts can still be decrypted.
  // Example: UPSTREAM_SECRET_KEYS=k2:aabbcc...64hex,k1:112233...64hex
  // When set, this takes precedence over UPSTREAM_SECRET_KEY.
  UPSTREAM_SECRET_KEYS: z.string().optional(),
  // Largest request body forwarded to an upstream API (express size string).
  PROXY_MAX_REQUEST_BODY: z.string().default("5mb"),
  // Upstream responses are held in memory until payment settles, so they are capped.
  PROXY_MAX_RESPONSE_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(10 * 1024 * 1024),
  // Default and ceiling for a single upstream call. Kept under REQUEST_TIMEOUT_MS.
  PROXY_DEFAULT_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  PROXY_MAX_TIMEOUT_MS: z.coerce.number().int().positive().default(25_000),
  // Idempotency-Key replay for paid calls: how long a charged response is kept,
  // how many are kept (oldest evicted first) and the largest body kept.
  PROXY_IDEMPOTENCY_TTL_MS: z.coerce.number().int().positive().default(3_600_000),
  PROXY_IDEMPOTENCY_MAX_ENTRIES: z.coerce.number().int().positive().default(1000),
  PROXY_IDEMPOTENCY_MAX_BODY_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(256 * 1024),
  // Issue #132: maximum number of proxy responses that may be buffered in memory
  // concurrently. When the limit is reached new requests receive a 503 with a
  // Retry-After: 1 header so callers (and the x402 client) can retry.
  // 0 disables the limit (unbounded, the pre-#132 behaviour).
  PROXY_BUFFER_CONCURRENCY: z.coerce.number().int().min(0).default(64),
  // Local development only: allow upstreams on loopback/private networks.
  PROXY_ALLOW_PRIVATE_UPSTREAMS: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  // Issue #33: IP rate limiter on /api/:id — rejects 402-spam before DB is touched.
  // Max unpaid requests per IP per window; set to 0 to disable.
  PROXY_402_RATE_LIMIT_MAX: z.coerce.number().int().min(0).default(60),
  PROXY_402_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  // How long a proxied API's row is cached between DB lookups (#34). Edits
  // invalidate the entry, so this only bounds staleness across replicas.
  PROXY_API_CACHE_TTL_MS: z.coerce.number().int().min(0).default(5_000),

  // Upstream health checks (#35): APIs with a healthPath are pinged on this
  // interval and hidden from the catalog after this many consecutive failures.
  HEALTH_CHECK_INTERVAL_MS: z.coerce.number().int().min(0).default(60_000),
  HEALTH_CHECK_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  HEALTH_CHECK_FAILURE_THRESHOLD: z.coerce.number().int().min(1).default(3),

  // Provider webhooks for charged calls (#36). Delays between attempts grow
  // as WEBHOOK_RETRY_BASE_MS * 4^n.
  WEBHOOK_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  WEBHOOK_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5),
  WEBHOOK_RETRY_BASE_MS: z.coerce.number().int().positive().default(1_000),

  // Retention of api_calls rows (#144, docs/api-call-retention.md). Rows older
  // than API_CALL_RETENTION_DAYS are deleted every API_CALL_RETENTION_INTERVAL_MS,
  // at most API_CALL_RETENTION_BATCH_SIZE per statement. 0 days keeps rows
  // forever; otherwise at least 90 days, the reach of the provider time-series.
  API_CALL_RETENTION_DAYS: z.coerce
    .number()
    .int()
    .min(0)
    .refine((days) => days === 0 || days >= 90, {
      message: "API_CALL_RETENTION_DAYS must be 0 (keep forever) or at least 90",
    })
    .default(180),
  API_CALL_RETENTION_INTERVAL_MS: z.coerce.number().int().min(0).default(3_600_000),
  API_CALL_RETENTION_BATCH_SIZE: z.coerce.number().int().min(1).max(10_000).default(1_000),
});

const parsed = envSchema.safeParse(envWithDefaults);

if (!parsed.success) {
  rootLogger.error(
    { event: "config_invalid", issues: parsed.error.format() },
    "invalid environment variables",
  );
  process.exit(1);
}

const stellarNetwork = resolveStellarNetwork(parsed.data.STELLAR_NETWORK);
const networkIssues = validateNetworkConfig({
  stellarNetwork,
  x402Network: parsed.data.NETWORK,
  sorobanRpcUrl: parsed.data.SOROBAN_RPC_URL,
  usdcSacContractId: parsed.data.USDC_CONTRACT_ID,
  registryContractId: parsed.data.REGISTRY_CONTRACT_ID,
});
if (networkIssues.length > 0) {
  for (const issue of networkIssues) {
    rootLogger.warn({ event: "network_config_issue", field: issue.field }, issue.message);
  }
}

// ── Mainnet safety guard (#51) ────────────────────────────────────────────────
// Refuse to start if the server is configured for mainnet but has settings that
// are only safe on a local/testnet environment.  This prevents a misconfigured
// production deployment from silently accepting SSRF or leaking funds.

/**
 * Returns a list of human-readable violation messages for mainnet-unsafe
 * settings.  An empty array means the config is safe to run on mainnet.
 * Exported so tests can exercise the logic without calling process.exit.
 */
export function mainnetSafetyViolations(cfg: typeof parsed.data): string[] {
  if (cfg.STELLAR_NETWORK !== "mainnet") return [];

  const violations: string[] = [];

  if (cfg.PROXY_ALLOW_PRIVATE_UPSTREAMS) {
    violations.push(
      "PROXY_ALLOW_PRIVATE_UPSTREAMS=true is not allowed on mainnet — " +
        "it would permit SSRF attacks via provider-supplied upstream URLs.",
    );
  }

  return violations;
}

if (parsed.data.STELLAR_NETWORK === "mainnet") {
  const violations = mainnetSafetyViolations(parsed.data);
  if (violations.length > 0) {
    rootLogger.error(
      { event: "mainnet_unsafe_config", violations },
      "refusing to start: unsafe settings detected for mainnet deployment",
    );
    for (const v of violations) {
      rootLogger.error(v);
    }
    process.exit(1);
  }
}

export const config = parsed.data;

// ── Key ring (#53) ────────────────────────────────────────────────────────────
// Parse UPSTREAM_SECRET_KEYS into an ordered list of {id, hex} entries.
// The first entry is the active key.  When only UPSTREAM_SECRET_KEY is set we
// wrap it in a single-entry ring so the rest of the codebase can always use the
// ring API.

import { parseKeyRing, type KeyRingEntry } from "./utils/secretBox.js";

function buildEffectiveKeyRing(): KeyRingEntry[] {
  if (config.UPSTREAM_SECRET_KEYS) {
    try {
      return parseKeyRing(config.UPSTREAM_SECRET_KEYS);
    } catch (err) {
      rootLogger.error(
        { event: "config_invalid_key_ring", err },
        "UPSTREAM_SECRET_KEYS is invalid",
      );
      process.exit(1);
    }
  }
  if (config.UPSTREAM_SECRET_KEY) {
    return [{ id: "default", hex: config.UPSTREAM_SECRET_KEY }];
  }
  return [];
}

/**
 * Parsed key ring for encrypting / decrypting upstream secrets.
 * Empty when neither UPSTREAM_SECRET_KEY nor UPSTREAM_SECRET_KEYS is set.
 */
export const upstreamKeyRing: KeyRingEntry[] = buildEffectiveKeyRing();
