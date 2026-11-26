-- Benchmark for the API catalog substring search (GET /apis?q=…, issue #148).
--
-- Seeds a throwaway `bench_apis` table with a representative catalog and prints the
-- query plan of the exact query `listPublicApis` runs, with and without the
-- pg_trgm indexes from drizzle/0021_api_catalog_search_trgm.sql.
--
-- Run it against a scratch database only (it drops and recreates `bench_apis`
-- and installs the pg_trgm extension):
--
--   docker run -d --rm --name zp-bench -e POSTGRES_PASSWORD=postgres -p 55432:5432 postgres:16-alpine
--   psql postgres://postgres:postgres@localhost:55432/postgres -f server/scripts/bench-catalog-search.sql
--
-- Set the row count with `-v rows=500000` (default 200000). Results are in
-- docs/performance.md.

\set ON_ERROR_STOP on
\if :{?rows}
\else
  \set rows 200000
\endif
\timing off

DROP TABLE IF EXISTS bench_apis;
CREATE TABLE bench_apis (
  id text PRIMARY KEY,
  publisher_id text NOT NULL,
  name text NOT NULL,
  description text,
  price text NOT NULL,
  listed boolean NOT NULL DEFAULT false,
  tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  archived_at timestamp,
  created_at timestamp NOT NULL DEFAULT now()
);

-- ~85% listed, ~3% archived, names/descriptions drawn from a vocabulary so that
-- some terms are common ("data", "api") and others rare (a numbered product).
WITH words AS (
  SELECT ARRAY[
    'weather','forecast','geocoding','translation','sentiment','image','vision',
    'speech','payments','crypto','price','market','stock','news','search','maps',
    'routing','email','sms','identity','fraud','risk','ocr','pdf','scraper',
    'embedding','llm','chat','summary','classifier','data','analytics','graph',
    'stellar','soroban','ledger','oracle','feed','sports','odds','flight','hotel'
  ] AS w
)
INSERT INTO bench_apis (id, publisher_id, name, description, price, listed, archived_at, created_at)
SELECT
  'api' || lpad(g::text, 10, '0'),
  'pub' || (g % 5000),
  initcap(w[1 + (g * 7) % array_length(w, 1)]) || ' ' ||
    initcap(w[1 + (g * 13) % array_length(w, 1)]) || ' API ' || g,
  'A ' || w[1 + (g * 3) % array_length(w, 1)] || ' and ' ||
    w[1 + (g * 11) % array_length(w, 1)] || ' data API for ' ||
    w[1 + (g * 17) % array_length(w, 1)] || ' workloads, product code P' || g || '.',
  ((g % 100) / 100.0 + 0.01)::text,
  (g % 20) < 17,
  CASE WHEN g % 33 = 0 THEN now() END,
  -- Many rows share a timestamp, like a bulk import would.
  timestamp '2026-01-01' + ((g / 50) || ' seconds')::interval
FROM generate_series(1, :rows) AS g, words;

CREATE INDEX bench_apis_listed_created_at ON bench_apis (listed, created_at);
ANALYZE bench_apis;

\echo
\echo '=== Without trigram indexes ==='
\echo '--- rare term (one product code) ---'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT * FROM bench_apis
WHERE listed = true AND archived_at IS NULL
  AND (name ILIKE '%P123457.%' OR description ILIKE '%P123457.%')
ORDER BY created_at DESC, id ASC LIMIT 20 OFFSET 0;

\echo '--- term with no match ---'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT * FROM bench_apis
WHERE listed = true AND archived_at IS NULL
  AND (name ILIKE '%nonexistent-term%' OR description ILIKE '%nonexistent-term%')
ORDER BY created_at DESC, id ASC LIMIT 20 OFFSET 0;

\echo '--- common term ---'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT * FROM bench_apis
WHERE listed = true AND archived_at IS NULL
  AND (name ILIKE '%weather%' OR description ILIKE '%weather%')
ORDER BY created_at DESC, id ASC LIMIT 20 OFFSET 0;

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX bench_apis_name_trgm ON bench_apis USING gin (name gin_trgm_ops);
CREATE INDEX bench_apis_description_trgm ON bench_apis USING gin (description gin_trgm_ops);
ANALYZE bench_apis;

\echo
\echo '=== With trigram indexes ==='
\echo '--- rare term (one product code) ---'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT * FROM bench_apis
WHERE listed = true AND archived_at IS NULL
  AND (name ILIKE '%P123457.%' OR description ILIKE '%P123457.%')
ORDER BY created_at DESC, id ASC LIMIT 20 OFFSET 0;

\echo '--- term with no match ---'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT * FROM bench_apis
WHERE listed = true AND archived_at IS NULL
  AND (name ILIKE '%nonexistent-term%' OR description ILIKE '%nonexistent-term%')
ORDER BY created_at DESC, id ASC LIMIT 20 OFFSET 0;

\echo '--- common term ---'
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF)
SELECT * FROM bench_apis
WHERE listed = true AND archived_at IS NULL
  AND (name ILIKE '%weather%' OR description ILIKE '%weather%')
ORDER BY created_at DESC, id ASC LIMIT 20 OFFSET 0;

DROP TABLE bench_apis;
