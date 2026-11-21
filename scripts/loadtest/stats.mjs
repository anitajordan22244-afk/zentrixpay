/** Pure statistics for the proxy load test. No I/O, so it is unit-testable. */

/** Nearest-rank percentile over an ascending-sorted array of numbers. */
export function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) throw new Error("percentile of empty sample");
  if (p <= 0) return sortedAsc[0];
  if (p >= 100) return sortedAsc[sortedAsc.length - 1];
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  return sortedAsc[Math.max(0, rank - 1)];
}

/** Summarise latencies (ms) and request counts for one run. */
export function summarise({ latenciesMs, durationSec, errors }) {
  const sorted = [...latenciesMs].sort((a, b) => a - b);
  const total = sorted.length;
  return {
    requests: total,
    errors,
    rps: total / durationSec,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
  };
}

/** Overhead of the proxy relative to direct upstream. */
export function overhead(direct, proxy) {
  return {
    rpsChangePct: ((proxy.rps - direct.rps) / direct.rps) * 100,
    p50Ms: proxy.p50 - direct.p50,
    p95Ms: proxy.p95 - direct.p95,
    p99Ms: proxy.p99 - direct.p99,
  };
}
