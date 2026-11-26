import { AsyncLocalStorage } from "node:async_hooks";
import pino, { type Logger } from "pino";

/**
 * Names of upstream headers that may carry provider secrets.
 * These are redacted from any logged request/header objects.
 */
const SECRET_HEADER_NAMES = [
  "x-api-key",
  "x-provider-key",
  "x-upstream-secret",
  "authorization",
  "proxy-authorization",
];

/**
 * Build the list of pino redaction paths for the configured secret headers.
 * Covers both `req.headers[...]` and bare `headers[...]` shapes, plus the
 * `upstreamHeader.value` / `upstreamQueryParam.value` fields in request bodies.
 */
function buildRedactPaths(): string[] {
  const paths: string[] = [];

  for (const name of SECRET_HEADER_NAMES) {
    paths.push(`req.headers['${name}']`);
    paths.push(`headers['${name}']`);
    paths.push(`request.headers['${name}']`);
  }

  paths.push("upstreamHeader.value");
  paths.push("upstreamQueryParam.value");
  paths.push("req.body.upstreamHeader.value");
  paths.push("req.body.upstreamQueryParam.value");
  paths.push("body.upstreamHeader.value");
  paths.push("body.upstreamQueryParam.value");

  return paths;
}

// ── Request-scoped context ───────────────────────────────────────────────────

const requestIdStorage = new AsyncLocalStorage<string>();

/**
 * Returns the request ID associated with the current async execution context,
 * or undefined if called outside a request context.
 */
export function getRequestId(): string | undefined {
  return requestIdStorage.getStore();
}

/**
 * Run `fn` with `requestId` bound to the current async context. Any call to
 * `getLogger()` or log statements inside `fn` will include the request ID automatically.
 */
export function runWithRequestContext<T>(requestId: string, fn: () => T): T {
  return requestIdStorage.run(requestId, fn);
}

export const rootLogger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: buildRedactPaths(),
    censor: "[REDACTED]",
  },
  mixin() {
    const requestId = getRequestId();
    return {
      service: "server",
      ...(requestId ? { requestId } : {}),
    };
  },
});

export const logger = rootLogger;

/**
 * Returns a logger instance. If called within an active request context (via
 * `runWithRequestContext`), returns a child logger bound to `{ requestId }`.
 * Otherwise returns the root logger.
 */
export function getLogger(): Logger {
  const requestId = getRequestId();
  return requestId ? rootLogger.child({ requestId }) : rootLogger;
}

export default logger;
