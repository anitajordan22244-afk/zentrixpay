import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../db/schema.js";
import {
  selectCatalogPage,
  type ApiCatalogOptions,
  type ApiCatalogSort,
} from "./apiCatalogQuery.js";
import { purgeExpiredApiCalls } from "./apiCallRetention.js";
import { getApiStats } from "./apiService.js";

// Catalog pagination (#147), catalog search and its index (#148) and call
// retention (#144) against a real Postgres. Runs only when TEST_DATABASE_URL
// points at a scratch database, e.g.
//
//   docker run -d --rm -p 55432:5432 -e POSTGRES_PASSWORD=postgres postgres:16-alpine
//   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:55432/postgres pnpm test
//
// Each run works in its own schema, dropped afterwards.

const url = process.env.TEST_DATABASE_URL;
const describePg = url ? describe : describe.skip;

// The tables as built by the migrations (no foreign keys: publishers are not
// needed here). The trigram indexes come from the real migration file.
const TABLES_SQL = `
CREATE TABLE apis (
  id text PRIMARY KEY,
  publisher_id text NOT NULL,
  name text NOT NULL,
  description text,
  upstream_url text NOT NULL,
  price text NOT NULL,
  wallet_address text NOT NULL,
  allowed_methods jsonb NOT NULL DEFAULT '["GET"]'::jsonb,
  upstream_header_name text,
  upstream_header_value_enc text,
  upstream_query_name text,
  upstream_query_value_enc text,
  openapi_spec jsonb,
  timeout_ms integer,
  max_response_bytes integer,
  webhook_url text,
  webhook_secret_enc text,
  health_path text,
  healthy boolean NOT NULL DEFAULT true,
  health_failures integer NOT NULL DEFAULT 0,
  last_health_check_at timestamp,
  ownership_token text NOT NULL,
  ownership_verified_at timestamp,
  listed boolean NOT NULL DEFAULT false,
  tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  archived_at timestamp,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX idx_apis_listed_created_at ON apis (listed, created_at);
CREATE TABLE api_calls (
  id text PRIMARY KEY,
  api_id text NOT NULL REFERENCES apis(id),
  payer_address text NOT NULL,
  amount text NOT NULL,
  charged boolean NOT NULL,
  method text NOT NULL,
  path text NOT NULL,
  response_status integer NOT NULL,
  duration_ms integer NOT NULL,
  tx_hash text,
  refund_status text,
  refund_amount text,
  refund_tx_hash text,
  refunded_at timestamp,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX idx_api_calls_api_id_created_at ON api_calls (api_id, created_at);
CREATE TABLE api_daily_rollups (
  id text PRIMARY KEY,
  api_id text NOT NULL REFERENCES apis(id),
  date text NOT NULL,
  calls integer NOT NULL DEFAULT 0,
  charged_calls integer NOT NULL DEFAULT 0,
  revenue text NOT NULL DEFAULT '0',
  unique_payers integer NOT NULL DEFAULT 0,
  total_duration_ms integer NOT NULL DEFAULT 0,
  refunded_calls integer NOT NULL DEFAULT 0,
  refunded_amount text NOT NULL DEFAULT '0',
  payers jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idx_api_daily_rollups_api_date ON api_daily_rollups (api_id, date);
CREATE TABLE api_call_financial_records (
  id text PRIMARY KEY,
  api_id text NOT NULL REFERENCES apis(id),
  payer_address text NOT NULL,
  amount text NOT NULL,
  tx_hash text,
  refund_status text,
  refund_amount text,
  refund_tx_hash text,
  refunded_at timestamp,
  created_at timestamp NOT NULL
);
CREATE INDEX idx_api_call_financial_records_api_created ON api_call_financial_records (api_id, created_at);
`;

const migration = (name: string) =>
  readFileSync(new URL(`../../drizzle/${name}`, import.meta.url), "utf8");

describePg("API catalog and call records (real Postgres)", () => {
  const schemaName = `zp_test_${randomBytes(4).toString("hex")}`;
  let sql: postgres.Sql;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    sql = postgres(url!, {
      max: 1,
      onnotice: () => {},
      connection: { search_path: `${schemaName},public` },
    });
    await sql.unsafe(`CREATE SCHEMA ${schemaName}`);
    await sql.unsafe(TABLES_SQL);
    for (const statement of migration("0021_api_catalog_search_trgm.sql").split(
      "--> statement-breakpoint",
    )) {
      await sql.unsafe(statement);
    }
    db = drizzle(sql, { schema });
  });

  afterAll(async () => {
    if (!sql) return;
    await sql.unsafe(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await sql.end();
  });

  beforeEach(async () => {
    await sql`TRUNCATE api_calls, apis, api_daily_rollups, api_call_financial_records`;
  });

  interface ApiSeed {
    id: string;
    name?: string;
    description?: string | null;
    price?: string;
    listed?: boolean;
    archived?: boolean;
    tags?: string[];
    createdAt?: Date;
  }

  async function insertApis(rows: ApiSeed[]) {
    await db.insert(schema.apis).values(
      rows.map((r) => ({
        id: r.id,
        publisherId: "pub1",
        name: r.name ?? `API ${r.id}`,
        description: r.description === undefined ? null : r.description,
        upstreamUrl: "https://upstream.example.com",
        price: r.price ?? "0.01",
        walletAddress: "GWALLET",
        ownershipToken: "token",
        listed: r.listed ?? true,
        tags: r.tags ?? [],
        archivedAt: r.archived ? new Date() : null,
        createdAt: r.createdAt ?? new Date("2026-01-01T00:00:00Z"),
      })),
    );
  }

  async function page(opts: ApiCatalogOptions): Promise<string[]> {
    return (await selectCatalogPage(db, opts)).map((r) => r.id);
  }

  async function allPages(sort: ApiCatalogSort, limit: number): Promise<string[]> {
    const ids: string[] = [];
    for (let offset = 0; ; offset += limit) {
      const batch = await page({ sort, limit, offset });
      ids.push(...batch);
      if (batch.length < limit) return ids;
    }
  }

  const SORTS: ApiCatalogSort[] = ["newest", "price_asc", "price_desc", "popular"];

  describe("deterministic pagination (#147)", () => {
    it.each(SORTS)("%s: tied rows page without repeats or gaps", async (sort) => {
      // 23 APIs with the same timestamp, price and popularity, inserted in an
      // order unrelated to their ids.
      const ids = Array.from(
        { length: 23 },
        (_, i) => `api${String((i * 7) % 23).padStart(2, "0")}`,
      );
      await insertApis(ids.map((id) => ({ id })));

      const paged = await allPages(sort, 5);

      expect(new Set(paged).size).toBe(paged.length);
      expect(paged).toEqual([...ids].sort());
      // Asking for the same page again returns the same rows.
      expect(await page({ sort, limit: 5, offset: 10 })).toEqual(paged.slice(10, 15));
    });

    it.each(SORTS)("%s: pages concatenate to the full ordering with partial ties", async (sort) => {
      const t1 = new Date("2026-01-01T00:00:00Z");
      const t2 = new Date("2026-02-01T00:00:00Z");
      await insertApis(
        Array.from({ length: 17 }, (_, i) => ({
          id: `mix${String((i * 5) % 17).padStart(2, "0")}`,
          price: i % 3 === 0 ? "0.5" : "0.1",
          createdAt: i % 2 === 0 ? t1 : t2,
        })),
      );
      const full = await page({ sort, limit: 100, offset: 0 });

      expect(full).toHaveLength(17);
      expect(await allPages(sort, 4)).toEqual(full);
    });
  });

  describe("substring search (#148)", () => {
    async function search(q: string, extra: Partial<ApiCatalogOptions> = {}) {
      const rows = await selectCatalogPage(db, { q, limit: 50, offset: 0, ...extra });
      return rows.map((r) => r.name).sort();
    }

    it("matches name or description, case-insensitively", async () => {
      await insertApis([
        { id: "s1", name: "Weather API" },
        { id: "s2", name: "Maps", description: "Includes WEATHER overlays" },
        { id: "s3", name: "Other", description: "Nothing relevant" },
      ]);
      expect(await search("weather")).toEqual(["Maps", "Weather API"]);
    });

    it("treats %, _ and backslash literally", async () => {
      await insertApis([
        { id: "w1", name: "Discount 50% off" },
        { id: "w2", name: "Discount 500 off" },
        { id: "w3", name: "snake_case api" },
        { id: "w4", name: "snakeXcase api" },
        { id: "w5", name: "path\\to\\api" },
        { id: "w6", name: "path to api" },
      ]);
      expect(await search("50%")).toEqual(["Discount 50% off"]);
      expect(await search("snake_case")).toEqual(["snake_case api"]);
      expect(await search("path\\to")).toEqual(["path\\to\\api"]);
      expect(await search("\\")).toEqual(["path\\to\\api"]);
    });

    it("only returns listed, non-archived APIs and combines with tags", async () => {
      await insertApis([
        { id: "l1", name: "Listed weather", tags: ["climate"] },
        { id: "l2", name: "Listed weather two" },
        { id: "l3", name: "Unlisted weather", listed: false },
        { id: "l4", name: "Archived weather", archived: true },
      ]);
      expect(await search("weather")).toEqual(["Listed weather", "Listed weather two"]);
      expect(await search("weather", { tag: ["climate"] })).toEqual(["Listed weather"]);
    });

    it("is served by the trigram indexes instead of a full scan", async () => {
      await sql.unsafe(`
        INSERT INTO apis (id, publisher_id, name, description, upstream_url, price,
                          wallet_address, ownership_token, listed, created_at)
        SELECT 'bulk' || g, 'pub1', 'Generic data API ' || g,
               'Returns data for workload ' || g, 'https://u.example.com', '0.01',
               'GWALLET', 't', g % 10 <> 0,
               timestamp '2026-01-01' + (g || ' seconds')::interval
        FROM generate_series(1, 20000) AS g`);
      await insertApis([{ id: "needle", name: "Quokka telemetry" }]);
      // Flush the GIN pending list and refresh stats, as autovacuum would.
      await sql`VACUUM ANALYZE apis`;

      const query = selectCatalogPage(db, { q: "quokka", limit: 20, offset: 0 }).toSQL();
      const plan = (await sql.unsafe(`EXPLAIN ${query.sql}`, query.params as never[]))
        .map((row) => row["QUERY PLAN"])
        .join("\n");

      expect(plan).toMatch(/idx_apis_(name|description)_trgm/);
      expect(plan).not.toMatch(/Seq Scan on apis/);
      expect(await search("quokka")).toEqual(["Quokka telemetry"]);
    });
  });

  describe("call record retention (#144)", () => {
    const now = new Date("2026-10-22T12:00:00Z");
    const daysAgo = (d: number) => new Date(now.getTime() - d * 24 * 60 * 60 * 1000);

    async function insertCalls(ages: number[]) {
      await insertApis([{ id: "ret" }]);
      await db.insert(schema.apiCalls).values(
        ages.map((age, i) => ({
          id: `call${i}`,
          apiId: "ret",
          payerAddress: "GPAYER",
          amount: "0.01",
          charged: true,
          method: "GET",
          path: "/",
          responseStatus: 200,
          durationMs: 5,
          createdAt: daysAgo(age),
        })),
      );
    }

    async function remainingAges(): Promise<string[]> {
      const rows = await sql<{ id: string }[]>`SELECT id FROM api_calls ORDER BY id`;
      return rows.map((r) => r.id);
    }

    it("deletes rows older than the window in batches and keeps the rest", async () => {
      // call0..call4 are expired; call5 (179 days) and call6 (1 day) are kept.
      await insertCalls([400, 365, 200, 181, 180.01, 179, 1]);

      const deleted = await purgeExpiredApiCalls(db, { retentionDays: 180, batchSize: 2, now });

      expect(deleted).toBe(5);
      expect(await remainingAges()).toEqual(["call5", "call6"]);
      // Nothing left to expire: a second run is a no-op.
      expect(await purgeExpiredApiCalls(db, { retentionDays: 180, batchSize: 2, now })).toBe(0);
    });

    it("stops after maxBatches and finishes on the next run", async () => {
      await insertCalls([400, 300, 200, 10]);

      expect(
        await purgeExpiredApiCalls(db, { retentionDays: 180, batchSize: 1, maxBatches: 2, now }),
      ).toBe(2);
      expect(await remainingAges()).toHaveLength(2);
      expect(await purgeExpiredApiCalls(db, { retentionDays: 180, batchSize: 1, now })).toBe(1);
      expect(await remainingAges()).toEqual(["call3"]);
    });

    it("keeps everything when retention is disabled", async () => {
      await insertCalls([4000, 1]);
      expect(await purgeExpiredApiCalls(db, { retentionDays: 0, batchSize: 10, now })).toBe(0);
      expect(await remainingAges()).toHaveLength(2);
    });

    it("totals are identical before and after a purge (#283)", async () => {
      await insertApis([{ id: "ret-ident" }]);
      await db.insert(schema.apiCalls).values([
        {
          id: "call-exp-1",
          apiId: "ret-ident",
          payerAddress: "GPAYER1",
          amount: "0.10",
          charged: true,
          method: "GET",
          path: "/items",
          responseStatus: 200,
          durationMs: 10,
          createdAt: daysAgo(200),
        },
        {
          id: "call-exp-2",
          apiId: "ret-ident",
          payerAddress: "GPAYER2",
          amount: "0.20",
          charged: true,
          method: "POST",
          path: "/items",
          responseStatus: 200,
          durationMs: 20,
          createdAt: daysAgo(200),
        },
        {
          id: "call-exp-3",
          apiId: "ret-ident",
          payerAddress: "GPAYER1",
          amount: "0.00",
          charged: false,
          method: "GET",
          path: "/free",
          responseStatus: 200,
          durationMs: 15,
          createdAt: daysAgo(210),
        },
        {
          id: "call-rec-1",
          apiId: "ret-ident",
          payerAddress: "GPAYER1",
          amount: "0.05",
          charged: true,
          method: "GET",
          path: "/items",
          responseStatus: 200,
          durationMs: 10,
          createdAt: daysAgo(10),
        },
        {
          id: "call-rec-2",
          apiId: "ret-ident",
          payerAddress: "GPAYER3",
          amount: "0.00",
          charged: false,
          method: "GET",
          path: "/free",
          responseStatus: 200,
          durationMs: 12,
          createdAt: daysAgo(5),
        },
      ]);

      const statsBefore = await getApiStats("ret-ident");
      expect(statsBefore.calls).toBe(5);
      expect(statsBefore.chargedCalls).toBe(3);
      expect(statsBefore.uniquePayers).toBe(2);

      const deleted = await purgeExpiredApiCalls(db, { retentionDays: 180, batchSize: 10, now });
      expect(deleted).toBe(3);

      const statsAfter = await getApiStats("ret-ident");
      expect(statsAfter).toEqual(statsBefore);
    });
  });
});
