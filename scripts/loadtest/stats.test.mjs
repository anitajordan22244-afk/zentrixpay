import { test } from "node:test";
import assert from "node:assert/strict";
import { percentile, summarise, overhead } from "./stats.mjs";

test("nearest-rank percentiles", () => {
  const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(percentile(xs, 50), 5);
  assert.equal(percentile(xs, 95), 10);
  assert.equal(percentile(xs, 99), 10);
  assert.equal(percentile(xs, 0), 1);
});

test("percentile rejects an empty sample", () => {
  assert.throws(() => percentile([], 50));
});

test("summarise computes rps and percentiles from raw latencies", () => {
  const s = summarise({ latenciesMs: [4, 1, 3, 2], durationSec: 2, errors: 0 });
  assert.equal(s.requests, 4);
  assert.equal(s.rps, 2);
  assert.equal(s.p50, 2);
  assert.equal(s.p95, 4);
});

test("overhead is proxy minus direct, RPS as relative change", () => {
  const direct = { rps: 1000, p50: 0.4, p95: 0.9, p99: 1.5 };
  const proxy = { rps: 800, p50: 0.7, p95: 1.3, p99: 2.2 };
  const o = overhead(direct, proxy);
  assert.equal(o.rpsChangePct, -20);
  assert.ok(Math.abs(o.p50Ms - 0.3) < 1e-9);
  assert.ok(Math.abs(o.p99Ms - 0.7) < 1e-9);
});
