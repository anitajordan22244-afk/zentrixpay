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

// API call record recovery (#134)
export const apiCallRecoveryPending = new Gauge({
  name: "api_call_records_pending_recovery",
  help: "Number of API call records awaiting database recovery after write failures",
  registers: [metricsRegistry],
});

export const apiCallRecoveryTotal = new Counter({
  name: "api_call_records_recovery_total",
  help: "Total API call record recovery outcomes",
  labelNames: ["outcome"] as const,
  registers: [metricsRegistry],
});
