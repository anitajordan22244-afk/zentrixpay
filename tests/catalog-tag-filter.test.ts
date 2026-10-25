/**
 * Catalog filter parity tests (#139)
 *
 * Verifies that:
 *  1. The server-side SQL query builder (catalogWhere) enforces tag filtering
 *     correctly in its rendered SQL.
 *  2. The MCP client-side filter (applyClientCatalogFilters) matches the same
 *     semantics for tags and text search combinations.
 *  3. The apiCatalogQuerySchema accepts and coerces repeated ?tag= params.
 *
 * These tests intentionally avoid a live Postgres connection by using
 * drizzle.mock() for SQL rendering and a fixture dataset for client-side
 * filtering, so they run in any environment without a database.
 */
import { describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../server/src/db/schema.js";
import { selectCatalogPage } from "../server/src/services/apiCatalogQuery.js";
import { apiCatalogQuerySchema } from "../server/src/schemas/requests.js";
import { applyClientCatalogFilters } from "../mcp/src/catalogFilters.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const APIS = [
  {
    id: "api-ai-nlp",
    name: "AI NLP Service",
    description: "Natural language processing API",
    price: "0.10",
    tags: ["ai", "nlp"],
    listed: true,
    createdAt: "2026-08-01T00:00:00Z",
  },
  {
    id: "api-weather",
    name: "Weather Data",
    description: "Real-time weather forecasts",
    price: "0.05",
    tags: ["weather", "data"],
    listed: true,
    createdAt: "2026-08-02T00:00:00Z",
  },
  {
    id: "api-ai-vision",
    name: "AI Vision",
    description: "Image recognition API",
    price: "0.20",
    tags: ["ai", "vision"],
    listed: true,
    createdAt: "2026-08-03T00:00:00Z",
  },
  {
    id: "api-unlisted",
    name: "Beta AI",
    description: "Unlisted beta service",
    price: "0.01",
    tags: ["ai"],
    listed: false,
    createdAt: "2026-08-04T00:00:00Z",
  },
];

const PUBLIC_APIS = APIS.filter((a) => a.listed);

// ── SQL generation ────────────────────────────────────────────────────────────

const db = drizzle.mock({ schema });

function renderSql(opts: Parameters<typeof selectCatalogPage>[1]) {
  return selectCatalogPage(db, opts).toSQL();
}

describe("catalogWhere — tag filter SQL (#139)", () => {
  it("renders jsonb containment operator when tags are provided", () => {
    const { sql, params } = renderSql({ tag: ["ai"], limit: 20, offset: 0 });
    expect(sql).toContain("@>");
    expect(params).toContain('["ai"]');
  });

  it("includes all requested tags in a single containment check (AND semantics)", () => {
    const { sql, params } = renderSql({ tag: ["ai", "nlp"], limit: 20, offset: 0 });
    expect(sql).toContain("@>");
    expect(params).toContain('["ai","nlp"]');
  });

  it("does not add a jsonb condition when no tags are requested", () => {
    const { sql } = renderSql({ limit: 20, offset: 0 });
    expect(sql).not.toContain("@>");
  });

  it("combines tag filter with text search (AND of both conditions)", () => {
    const { sql, params } = renderSql({ q: "weather", tag: ["data"], limit: 20, offset: 0 });
    expect(sql).toContain("ilike");
    expect(sql).toContain("@>");
    expect(params.some((p) => typeof p === "string" && p.includes("weather"))).toBe(true);
    expect(params).toContain('["data"]');
  });

  it("still enforces listed=true and non-archived regardless of tag filter", () => {
    const { sql } = renderSql({ tag: ["ai"], limit: 20, offset: 0 });
    expect(sql).toContain('"apis"."listed" = $');
    expect(sql).toContain('"apis"."archived_at" is null');
  });
});

// ── Schema coercion ───────────────────────────────────────────────────────────

describe("apiCatalogQuerySchema — tag param coercion (#139)", () => {
  it("accepts a single ?tag= value as a one-element array", () => {
    const result = apiCatalogQuerySchema.safeParse({ tag: "ai" });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.tag).toEqual(["ai"]);
  });

  it("accepts repeated ?tag= values as an array (Express query-string behaviour)", () => {
    const result = apiCatalogQuerySchema.safeParse({ tag: ["ai", "nlp"] });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.tag).toEqual(["ai", "nlp"]);
  });

  it("lowercases tag values", () => {
    const result = apiCatalogQuerySchema.safeParse({ tag: ["AI", "NLP"] });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.tag).toEqual(["ai", "nlp"]);
  });

  it("rejects more than 10 tags", () => {
    const result = apiCatalogQuerySchema.safeParse({
      tag: ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9", "t10", "t11"],
    });
    expect(result.success).toBe(false);
  });

  it("omitting tag leaves it undefined (no filter)", () => {
    const result = apiCatalogQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.tag).toBeUndefined();
  });
});

// ── MCP client-side filter parity ────────────────────────────────────────────

describe("applyClientCatalogFilters — tag filter parity with server (#139)", () => {
  it("returns only APIs that carry all requested tags (AND semantics)", () => {
    const result = applyClientCatalogFilters(PUBLIC_APIS, { tags: ["ai"] });
    expect(result.map((a) => a.id)).toEqual(["api-ai-nlp", "api-ai-vision"]);
  });

  it("ANDs multiple tags: all must be present", () => {
    const result = applyClientCatalogFilters(PUBLIC_APIS, { tags: ["ai", "nlp"] });
    expect(result.map((a) => a.id)).toEqual(["api-ai-nlp"]);
  });

  it("returns empty when no API matches all required tags", () => {
    const result = applyClientCatalogFilters(PUBLIC_APIS, { tags: ["ai", "weather"] });
    expect(result).toEqual([]);
  });

  it("tag matching is case-insensitive", () => {
    const result = applyClientCatalogFilters(PUBLIC_APIS, { tags: ["AI"] });
    expect(result.map((a) => a.id)).toEqual(["api-ai-nlp", "api-ai-vision"]);
  });

  it("combines tag filter with text search (both must match)", () => {
    const result = applyClientCatalogFilters(PUBLIC_APIS, {
      query: "nlp",
      tags: ["ai"],
    });
    expect(result.map((a) => a.id)).toEqual(["api-ai-nlp"]);
  });

  it("excludes unlisted APIs when filtering by tag (unless listed:false explicitly passed)", () => {
    const result = applyClientCatalogFilters(APIS, { tags: ["ai"] });
    // Unlisted "Beta AI" (api-unlisted) must NOT appear.
    expect(result.map((a) => a.id)).not.toContain("api-unlisted");
    expect(result.map((a) => a.id)).toContain("api-ai-nlp");
  });

  it("text-only search returns APIs whose name or description contains the query", () => {
    const result = applyClientCatalogFilters(PUBLIC_APIS, { query: "weather" });
    expect(result.map((a) => a.id)).toEqual(["api-weather"]);
  });

  it("empty filters return all public APIs unchanged", () => {
    const result = applyClientCatalogFilters(PUBLIC_APIS, {});
    expect(result).toEqual(PUBLIC_APIS);
  });

  it("tag filter with no text returns all APIs carrying the tag", () => {
    const result = applyClientCatalogFilters(PUBLIC_APIS, { tags: ["data"] });
    expect(result.map((a) => a.id)).toEqual(["api-weather"]);
  });

  it("server page + MCP tag refilter yields consistent results (parity)", () => {
    // Simulate what the agent sees: server returned page filtered by q="ai",
    // then MCP refilters the page by tag="nlp".
    const serverPage = PUBLIC_APIS.filter(
      (a) =>
        a.name.toLowerCase().includes("ai") || (a.description ?? "").toLowerCase().includes("ai"),
    );
    const mcpFiltered = applyClientCatalogFilters(serverPage, { tags: ["nlp"] });
    expect(mcpFiltered.map((a) => a.id)).toEqual(["api-ai-nlp"]);
  });
});
