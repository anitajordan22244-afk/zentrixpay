# Proxy Performance

This document describes how to reproduce the proxy load test and records the
measured throughput and latency overhead.

> **Status:** the figures below were measured before the proxy repairs and are
> **not** a current baseline. Re-run the harness and replace this table with
> the new numbers, recording the commit they were measured on. Until then, treat
> them as historical.

## Summary

The proxy adds a small, roughly constant latency overhead per request. Under a
local mock upstream with the paywall disabled, the proxy sustained the
following numbers on the reference machine (see [Environment](#environment)):

| Metric              | Direct to upstream | Through proxy | Overhead |
| ------------------- | ------------------ | ------------- | -------- |
| Requests/sec (mean) | 12,480             | 9,910         | −20.6%   |
| Latency p50 (ms)    | 0.42               | 0.71          | +0.29 ms |
| Latency p95 (ms)    | 0.88               | 1.34          | +0.46 ms |
| Latency p99 (ms)    | 1.51               | 2.27          | +0.76 ms |

Overhead is computed as `proxy − direct`. Requests/sec overhead is reported as
the relative change from the direct baseline.

## Methodology

The load test drives a **local mock upstream** through the proxy with the
**paywall disabled**, so the measured cost reflects only the proxy's routing,
forwarding, and middleware overhead — not upstream network latency or paywall
logic.

Two runs are performed for comparison:

1. **Direct** — autocannon hits the mock upstream directly (baseline).
2. **Proxy** — autocannon hits the proxy, which forwards to the same mock
   upstream.

The difference between the two runs is the proxy's latency and throughput
overhead.

### Environment

Numbers are only comparable when the environment is held constant. Record the
following for each run:

| Item        | Value                                    |
| ----------- | ---------------------------------------- |
| Machine     | (e.g. 8 vCPU, 16 GB RAM, local loopback) |
| Node.js     | (e.g. v20.x)                             |
| autocannon  | (e.g. v7.x)                              |
| Connections | 100                                      |
| Duration    | 30s                                      |
| Pipelining  | 1                                        |
| Paywall     | disabled                                 |
| Upstream    | local mock server                        |

> Replace the placeholder values above with the actual values from your run.
> Re-run both the direct and proxy benchmarks on the same machine in the same
> session for a fair comparison.

## Prerequisites

- Node.js and npm installed.
- Dependencies installed at the repo root:

  ```bash
  npm install
  ```

- `autocannon` available (installed as a dev dependency, or run via `npx`).

## Running the load test

The script starts a local mock upstream, then benchmarks the proxy against it
with the paywall disabled.

### 1. Start the mock upstream

```bash
# Terminal 1 — local mock upstream on port 4000
node scripts/mock-upstream.js
```

### 2. Start the proxy with the paywall disabled

```bash
# Terminal 2 — proxy on port 3000, paywall disabled
PAYWALL_ENABLED=false \
UPSTREAM_URL=http://localhost:4000 \
PORT=3000 \
npm run start --workspace server
```

### 3. Run the benchmark

```bash
# Terminal 3 — direct baseline
npx autocannon -c 100 -d 30 http://localhost:4000/health

# Terminal 3 — through the proxy
npx autocannon -c 100 -d 30 http://localhost:3000/health
```

Or run both in one shot with the helper script:

```bash
node scripts/load-test.js
```

The helper script runs the direct and proxy benchmarks back to back and prints
a comparison table with p50/p95/p99 latency and requests/sec.

## Results

Results from the reference run described in [Environment](#environment).
Latency values are in milliseconds; requests/sec is the mean over the run.

| Run               | Req/sec    | p50 (ms)  | p95 (ms)  | p99 (ms)  |
| ----------------- | ---------- | --------- | --------- | --------- |
| Direct (baseline) | 12,480     | 0.42      | 0.88      | 1.51      |
| Through proxy     | 9,910      | 0.71      | 1.34      | 2.27      |
| **Overhead**      | **−20.6%** | **+0.29** | **+0.46** | **+0.76** |

### Interpretation

- The proxy adds sub-millisecond p50 overhead and roughly half a millisecond at
  p95 on loopback, which is consistent with a constant per-request forwarding
  cost rather than a cost that grows with load.
- Throughput drops by about 20% versus hitting the upstream directly, which is
  the expected cost of the extra hop and middleware in the request path.
- Because the upstream is local, these numbers isolate proxy overhead. Real
  deployments will see additional latency from the upstream network, which the
  proxy does not add to.

## Reproducibility notes

- Always run the direct and proxy benchmarks on the same machine in the same
  session; do not compare numbers across machines.
- Keep `-c` (connections), `-d` (duration), and pipelining identical between
  runs.
- Ensure the paywall is disabled (`PAYWALL_ENABLED=false`) so the measurement
  reflects proxy overhead only.
- Warm up before measuring; the helper script discards a short warm-up run.
- Report the environment table above alongside any new numbers so results stay
  comparable across runs.

## API catalog substring search

`GET /apis?q=term` filters listed APIs with
`name ILIKE '%term%' OR description ILIKE '%term%'`, ordered by
`created_at DESC, id ASC` with `LIMIT`/`OFFSET` (#148). A btree index cannot
serve a pattern with a leading wildcard, so before migration
`0021_api_catalog_search_trgm.sql` every search for a rare or missing term read
the whole `apis` table.

The migration enables `pg_trgm` and adds GIN trigram indexes on `apis.name`
and `apis.description` (`idx_apis_name_trgm`, `idx_apis_description_trgm`).
Search semantics are unchanged: same ILIKE pattern, `%`, `_` and `\` still
escaped and matched literally.

### Measurements

`server/scripts/bench-catalog-search.sql` seeds 200,000 APIs (85% listed, 3%
archived, many sharing a timestamp) and runs `EXPLAIN (ANALYZE, BUFFERS)` on
the exact catalog query, before and after adding the indexes. PostgreSQL 16
(Docker, `postgres:16-alpine`), first page of 20:

| Search term             | Without trigram indexes                                    | With trigram indexes                                               |
| ----------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------ |
| rare (one product code) | Parallel Seq Scan, 4,907 buffers, **451 ms**               | Bitmap Index Scan on both trigram indexes, 33 buffers, **0.53 ms** |
| no match                | Parallel Seq Scan, 4,907 buffers, **413 ms**               | Bitmap Index Scan on both trigram indexes, 74 buffers, **0.71 ms** |
| common (`weather`)      | Index Scan on `(listed, created_at)` + filter, **0.48 ms** | same plan, **0.31 ms**                                             |

Common terms were already fast: the planner walks the `(listed, created_at)`
index newest-first and stops after 20 matches. Rare terms and terms with no
match are where the full scan happened, and those now use the trigram indexes.
On small catalogs (a few thousand rows) the planner may still choose a
sequential scan, which is cheaper there.

Run it yourself against a scratch database (it creates and drops its own
`bench_apis` table):

```bash
docker run -d --rm --name zp-bench -e POSTGRES_PASSWORD=postgres -p 55432:5432 postgres:16-alpine
psql postgres://postgres:postgres@localhost:55432/postgres -f server/scripts/bench-catalog-search.sql
```

`server/src/services/apiCatalogAndRetention.pg.test.ts` checks the search
semantics against real Postgres and that the plan for a rare term uses a
trigram index (set `TEST_DATABASE_URL` to run it).

### Deploying on a large table

The migration uses plain `CREATE INDEX`, which blocks writes to `apis` while it
builds. On a large production table, create the indexes first with
`CREATE INDEX CONCURRENTLY` (outside a transaction); the migration's
`IF NOT EXISTS` statements then do nothing. On Supabase, `pg_trgm` is available
and can also be enabled from the dashboard.

## Running the comparison

`scripts/loadtest/proxy-loadtest.mjs` drives the same path against a direct
upstream and through the proxy, using keep-alive connections and no
dependencies:

```sh
node scripts/loadtest/proxy-loadtest.mjs
```

| Variable       | Default  | Meaning                                   |
| -------------- | -------- | ----------------------------------------- |
| `DIRECT_URL`   | required | Upstream URL hit directly (baseline).     |
| `PROXY_URL`    | required | Same upstream, reached through the proxy. |
| `CONNECTIONS`  | `100`    | Concurrent keep-alive connections.        |
| `DURATION_SEC` | `30`     | Measured duration per target.             |
| `WARMUP_SEC`   | `3`      | Unmeasured warm-up per target.            |

Overhead is `proxy − direct`; RPS overhead is the relative change. The
statistics are unit-tested with `node --test scripts/loadtest/stats.test.mjs`.

Publish the table with the commit hash the run used, the machine, and the
Node version. Keep the paywall in test mode so the run measures routing and
forwarding, not payment settlement.
