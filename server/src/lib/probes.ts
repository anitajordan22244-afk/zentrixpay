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
  facilitator: "payment_facilitator_unavailable",
  facilitatorTimeout: "payment_facilitator_timeout",
} as const;

export type ReadinessErrorCode = (typeof READINESS_ERROR_CODES)[keyof typeof READINESS_ERROR_CODES];

export interface DependencyCheck {
  status: DependencyStatus;
  latencyMs: number;
  /** When false the check is reported but does not fail readiness. Defaults to true. */
  required?: boolean;
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

/**
 * Read-only health check for the x402 payment facilitator (#133). Fetches the
 * facilitator's `/supported` endpoint, which lists the payment kinds it can
 * verify and settle; nothing is verified or settled, so no payment is ever
 * initiated. The request is aborted after FACILITATOR_HEALTH_TIMEOUT_MS.
 */
export async function probeFacilitator(
  options: {
    url?: string;
    timeoutMs?: number;
    required?: boolean;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<DependencyCheck> {
  const url = options.url ?? config.FACILITATOR_URL;
  const timeoutMs = options.timeoutMs ?? config.FACILITATOR_HEALTH_TIMEOUT_MS;
  const required = options.required ?? config.READINESS_REQUIRE_FACILITATOR ?? true;
  const fetchImpl = options.fetchImpl ?? fetch;
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${url.replace(/\/+$/, "")}/supported`, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`facilitator /supported returned HTTP ${res.status}`);
    const body: unknown = await res.json().catch(() => null);
    const kinds =
      typeof body === "object" &&
      body !== null &&
      "kinds" in body &&
      Array.isArray(body.kinds)
        ? body.kinds.length
        : undefined;
    return {
      status: "ok",
      latencyMs: Date.now() - start,
      required,
      ...(kinds !== undefined ? { details: { supportedKinds: kinds } } : {}),
    };
  } catch (err) {
    const timedOut = controller.signal.aborted;
    return {
      ...failedCheck(timedOut ? "facilitatorTimeout" : "facilitator", start, err),
      required,
    };
  } finally {
    clearTimeout(timer);
  }
}
