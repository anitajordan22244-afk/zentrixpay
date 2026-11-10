import { AsyncLocalStorage } from "node:async_hooks";
import pino, { type Logger } from "pino";
import { trace } from "@opentelemetry/api";

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

export const logger: Logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  redact: {
    paths: buildRedactPaths(),
    censor: "[REDACTED]",
  },
  mixin() {
    const traceId = trace.getActiveSpan()?.spanContext().traceId;
    return traceId ? { service: "server", traceId } : { service: "server" };
  },
});

export const rootLogger: Logger = logger;

type RequestContext = {
  requestId: string;
  log: Logger;
};

const requestContext = new AsyncLocalStorage<RequestContext>();

/** Request-scoped logger when inside request middleware; otherwise the root logger. */
export function getLogger(): Logger {
  return requestContext.getStore()?.log ?? rootLogger;
}

export function getRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
}

export function runWithRequestContext<T>(requestId: string, fn: () => T): T {
  const log = rootLogger.child({ requestId });
  return requestContext.run({ requestId, log }, fn);
}

export default logger;
