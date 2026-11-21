#!/usr/bin/env node
/**
 * Compares a direct upstream against the proxy under the same load.
 *
 *   DIRECT_URL=http://127.0.0.1:4001/ping PROXY_URL=http://127.0.0.1:3000/apis/1/ping \
 *     node scripts/loadtest/proxy-loadtest.mjs
 *
 * Defaults match docs/performance.md: 100 connections, 30s, 1 request in flight
 * per connection (no pipelining). Run both targets on the same machine in the
 * same session. Prints a Markdown table to stdout.
 */
import http from "node:http";
import https from "node:https";
import { summarise, overhead } from "./stats.mjs";

const CONNECTIONS = Number(process.env.CONNECTIONS ?? 100);
const DURATION_SEC = Number(process.env.DURATION_SEC ?? 30);
const WARMUP_SEC = Number(process.env.WARMUP_SEC ?? 3);

function run(url, durationSec) {
  const target = new URL(url);
  const client = target.protocol === "https:" ? https : http;
  const agent = new (target.protocol === "https:" ? https : http).Agent({
    keepAlive: true,
    maxSockets: CONNECTIONS,
  });
  const latenciesMs = [];
  let errors = 0;
  const deadline = Date.now() + durationSec * 1000;

  return new Promise((resolve) => {
    let active = 0;
    const loop = () => {
      if (Date.now() >= deadline) {
        if (active === 0) {
          agent.destroy();
          resolve({ latenciesMs, errors, durationSec });
        }
        return;
      }
      active++;
      const started = process.hrtime.bigint();
      const req = client.get(target, { agent }, (res) => {
        res.resume();
        res.on("end", () => {
          const ms = Number(process.hrtime.bigint() - started) / 1e6;
          if (res.statusCode >= 500) errors++;
          else latenciesMs.push(ms);
          active--;
          loop();
        });
      });
      req.on("error", () => {
        errors++;
        active--;
        loop();
      });
    };
    for (let i = 0; i < CONNECTIONS; i++) loop();
  });
}

const direct = process.env.DIRECT_URL;
const proxy = process.env.PROXY_URL;
if (!direct || !proxy) {
  console.error("Set DIRECT_URL and PROXY_URL");
  process.exit(2);
}

// Warm up both targets so connection setup is not measured.
await run(direct, WARMUP_SEC);
await run(proxy, WARMUP_SEC);

const d = summarise(await run(direct, DURATION_SEC));
const p = summarise(await run(proxy, DURATION_SEC));
const o = overhead(d, p);
const f = (n) => n.toFixed(2);

console.log(`| Metric | Direct | Proxy | Overhead |`);
console.log(`| --- | --- | --- | --- |`);
console.log(`| Requests/sec | ${f(d.rps)} | ${f(p.rps)} | ${f(o.rpsChangePct)}% |`);
console.log(`| Latency p50 (ms) | ${f(d.p50)} | ${f(p.p50)} | +${f(o.p50Ms)} ms |`);
console.log(`| Latency p95 (ms) | ${f(d.p95)} | ${f(p.p95)} | +${f(o.p95Ms)} ms |`);
console.log(`| Latency p99 (ms) | ${f(d.p99)} | ${f(p.p99)} | +${f(o.p99Ms)} ms |`);
console.log(`\nErrors (5xx/transport): direct=${d.errors} proxy=${p.errors}`);
