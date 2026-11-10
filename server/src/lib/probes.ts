import { sql } from "drizzle-orm";
import { rpc as StellarRpc } from "@stellar/stellar-sdk";
import { db } from "../db/client.js";
import { config } from "../config.js";
import { getLogger } from "./logger.js";

export type DependencyStatus = "ok" | "error";

/**
 * Stable, public error identifiers for failed readiness probes. Raw dependency
 * errors can carry connection strings, hostnames or credentials, so they are
 * only written to server logs — callers of /health/ready see these codes.
 */
export const READINESS_ERROR_CODES = {
  database: "database_unavailable",
  sorobanRpc: "soroban_rpc_unavailable",
  facilitator: "facilitator_unavailable",
} as const;

export const DEFAULT_FACILITATOR_PROBE_TIMEOUT_MS = 5_000;

export type ReadinessErrorCode = (typeof READINESS_ERROR_CODES)[keyof typeof READINESS_ERROR_CODES];

export interface DependencyCheck {
  status: DependencyStatus;
  latencyMs: number;
  error?: ReadinessErrorCode;
  details?: Record<string, unknown>;
}

function failedCheck(
  dependency: keyof typeof READINESS_ERROR_CODES,
  start: number,
  err: unknown,
): DependencyCheck {
  const code = READINESS_ERROR_CODES[dependency];
  const latencyMs = Date.now() - start;
  getLogger().warn(
    { event: "readiness_probe_failed", dependency, code, latencyMs, err },
    "readiness probe failed",
  );
  return { status: "error", latencyMs, error: code };
}

export async function probeDatabase(): Promise<DependencyCheck> {
  const start = Date.now();
  try {
    await db.execute(sql`SELECT 1`);
    return { status: "ok", latencyMs: Date.now() - start };
  } catch (err) {
    return failedCheck("database", start, err);
  }
}

export async function probeSorobanRpc(): Promise<DependencyCheck> {
  const start = Date.now();
  try {
    const rpcServer = new StellarRpc.Server(config.SOROBAN_RPC_URL);
    const health = await rpcServer.getHealth();
    return {
      status: "ok",
      latencyMs: Date.now() - start,
      details: {
        latestLedger: health.latestLedger,
        oldestLedger: health.oldestLedger,
        ledgerRetentionWindow: health.ledgerRetentionWindow,
      },
    };
  } catch (err) {
    return failedCheck("sorobanRpc", start, err);
  }
}

export interface FacilitatorProbeOptions {
  facilitatorUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Bounded readiness probe for the x402 payment facilitator (#133).
 *
 * Queries the read-only `GET /supported` capability endpoint so readiness
 * checks never initiate or settle a payment. Enforces a strict abort timeout
 * to prevent a hung facilitator from stalling `/health/ready`.
 */
export async function probeFacilitator(
  options: FacilitatorProbeOptions = {},
): Promise<DependencyCheck> {
  const start = Date.now();
  const baseUrl = (options.facilitatorUrl ?? config.FACILITATOR_URL ?? "").replace(/\/+$/, "");
  if (!baseUrl) {
    return failedCheck("facilitator", start, new Error("FACILITATOR_URL is not configured"));
  }

  const timeoutMs =
    options.timeoutMs ?? config.HEALTH_CHECK_TIMEOUT_MS ?? DEFAULT_FACILITATOR_PROBE_TIMEOUT_MS;
  const fetchFn = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`Facilitator probe timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  try {
    const response = await fetchFn(`${baseUrl}/supported`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`Facilitator /supported returned HTTP ${response.status}`);
    }

    const payload = (await response.json()) as { kinds?: unknown } | null;
    if (!payload || typeof payload !== "object") {
      throw new Error("Facilitator /supported returned an invalid JSON payload");
    }

    const details: Record<string, unknown> = {};
    if (Array.isArray(payload.kinds)) {
      details.supportedKinds = payload.kinds.length;
    }

    return {
      status: "ok",
      latencyMs: Date.now() - start,
      ...(Object.keys(details).length > 0 ? { details } : {}),
    };
  } catch (err) {
    return failedCheck("facilitator", start, err);
  } finally {
    clearTimeout(timer);
  }
}
