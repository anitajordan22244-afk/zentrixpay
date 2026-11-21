import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from "prom-client";

export const metricsRegistry = new Registry();

collectDefaultMetrics({ register: metricsRegistry });

// DB pool
export const dbPoolTotal = new Gauge({
  name: "db_pool_connections_total",
  help: "Total open database connections in the pool",
  registers: [metricsRegistry],
});

export const dbPoolIdle = new Gauge({
  name: "db_pool_connections_idle",
  help: "Idle database connections in the pool",
  registers: [metricsRegistry],
});

// HTTP request duration
export const httpRequestDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route", "status_code"] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [metricsRegistry],
});

// Rate-limit rejections
export const rateLimitCounter = new Counter({
  name: "http_rate_limit_rejections_total",
  help: "Total requests rejected by rate limiting",
  labelNames: ["limiter"] as const,
  registers: [metricsRegistry],
});

// Cache hits/misses
export const cacheHits = new Counter({
  name: "cache_hits_total",
  help: "Total cache hits",
  labelNames: ["cache"] as const,
  registers: [metricsRegistry],
});

export const cacheMisses = new Counter({
  name: "cache_misses_total",
  help: "Total cache misses",
  labelNames: ["cache"] as const,
  registers: [metricsRegistry],
});

// API-call records awaiting recovery after a failed insert (#134). Non-zero
// means usage stats are temporarily behind; alert if it stays non-zero.
export const apiCallRecordsPending = new Gauge({
  name: "zentrixpay_api_call_records_pending",
  help: "API-call records spooled after a failed database write and awaiting recovery",
  registers: [metricsRegistry],
});

export const apiCallRecordsRecovered = new Counter({
  name: "zentrixpay_api_call_records_recovered_total",
  help: "API-call records written to the database by the recovery worker",
  registers: [metricsRegistry],
});

// Gateway (#217). Labels stay bounded: no API id label, so cardinality does not
// grow with the number of listed APIs.

// Proxied calls by response status class (2xx, 4xx, 5xx, ...).
export const gatewayProxiedCalls = new Counter({
  name: "zentrixpay_gateway_proxied_calls_total",
  help: "Proxied API calls, by response status class",
  labelNames: ["status_class"] as const,
  registers: [metricsRegistry],
});

// Whether the caller was charged for the proxied call.
export const gatewayChargedCalls = new Counter({
  name: "zentrixpay_gateway_charged_calls_total",
  help: "Proxied API calls, by whether the caller was charged",
  labelNames: ["charged"] as const,
  registers: [metricsRegistry],
});

// Latency of the upstream round trip (buffered path).
export const gatewayUpstreamDuration = new Histogram({
  name: "zentrixpay_gateway_upstream_duration_seconds",
  help: "Latency of upstream API calls in seconds (buffered path)",
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
  registers: [metricsRegistry],
});

// x402 settlements that the facilitator rejected or failed.
export const gatewaySettlementFailures = new Counter({
  name: "zentrixpay_gateway_settlement_failures_total",
  help: "x402 settlements that failed or were rejected by the facilitator",
  registers: [metricsRegistry],
});

// 402 Payment Required challenges served to callers.
export const gatewayPaymentRequired = new Counter({
  name: "zentrixpay_gateway_payment_required_total",
  help: "402 Payment Required responses served",
  registers: [metricsRegistry],
});

// Proxied calls paid from prepaid API credits.
export const gatewayCreditSpends = new Counter({
  name: "zentrixpay_gateway_credit_spends_total",
  help: "Charged proxied calls paid from prepaid API credits",
  registers: [metricsRegistry],
});

// Facilitator calls (#219). `outcome` is ok, rejected (the facilitator answered
// that the payment is invalid) or error (the call itself failed). `reason`
// tells outages apart: unreachable, facilitator_5xx, facilitator_4xx, other.
export const gatewayFacilitatorRequests = new Counter({
  name: "zentrixpay_facilitator_requests_total",
  help: "x402 facilitator calls by operation, outcome and failure reason",
  labelNames: ["operation", "outcome", "reason"] as const,
  registers: [metricsRegistry],
});
