import { describe, expect, it } from "vitest";
import { createApiSchema, updateApiSchema } from "./requests.js";

const createInput = {
  name: "Example API",
  upstreamUrl: "https://api.example.test",
  price: "0.01",
};

describe("API price rule validation", () => {
  it("accepts method/path price overrides on create and update", () => {
    const priceRules = [{ method: "POST", pathPattern: "/generate/*", price: "0.10" }];
    expect(createApiSchema.safeParse({ ...createInput, priceRules }).success).toBe(true);
    expect(updateApiSchema.safeParse({ priceRules }).success).toBe(true);
  });

  it("rejects invalid methods, paths, prices, duplicate rules, and too many rules", () => {
    expect(
      createApiSchema.safeParse({
        ...createInput,
        priceRules: [{ method: "OPTIONS", pathPattern: "/generate", price: "0.10" }],
      }).success,
    ).toBe(false);
    expect(
      createApiSchema.safeParse({
        ...createInput,
        priceRules: [{ method: "POST", pathPattern: "generate", price: "0.10" }],
      }).success,
    ).toBe(false);
    expect(
      updateApiSchema.safeParse({
        priceRules: [
          { method: "POST", pathPattern: "/generate", price: "0.10" },
          { method: "POST", pathPattern: "/generate", price: "0.20" },
        ],
      }).success,
    ).toBe(false);
    expect(
      updateApiSchema.safeParse({
        priceRules: Array.from({ length: 101 }, (_, index) => ({
          method: "POST",
          pathPattern: `/generate/${index}`,
          price: "0.10",
        })),
      }).success,
    ).toBe(false);
  });
});

describe("apiStatsQuerySchema (#143)", () => {
  // Imported lazily to keep this block self-contained.
  const load = () => import("./requests.js");

  it("applies default pagination when nothing is given", async () => {
    const { apiStatsQuerySchema, STATS_DEFAULT_LIMIT } = await load();
    const q = apiStatsQuerySchema.parse({});
    expect(q).toEqual({ limit: STATS_DEFAULT_LIMIT, offset: 0 });
  });

  it("parses ISO dates and date-times and coerces paging params", async () => {
    const { apiStatsQuerySchema } = await load();
    const q = apiStatsQuerySchema.parse({
      from: "2026-01-01",
      to: "2026-01-31T12:00:00Z",
      limit: "25",
      offset: "50",
    });
    expect(q.from?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(q.to?.toISOString()).toBe("2026-01-31T12:00:00.000Z");
    expect(q.limit).toBe(25);
    expect(q.offset).toBe(50);
  });

  it("accepts an empty range where from equals to", async () => {
    const { apiStatsQuerySchema } = await load();
    expect(apiStatsQuerySchema.safeParse({ from: "2026-01-01", to: "2026-01-01" }).success).toBe(
      true,
    );
  });

  it("accepts a range exactly at the maximum length and rejects one day more", async () => {
    const { apiStatsQuerySchema, STATS_MAX_RANGE_DAYS } = await load();
    const from = new Date("2026-01-01T00:00:00Z");
    const atMax = new Date(from.getTime() + STATS_MAX_RANGE_DAYS * 86_400_000);
    const overMax = new Date(atMax.getTime() + 86_400_000);
    expect(
      apiStatsQuerySchema.safeParse({ from: from.toISOString(), to: atMax.toISOString() }).success,
    ).toBe(true);
    expect(
      apiStatsQuerySchema.safeParse({ from: from.toISOString(), to: overMax.toISOString() })
        .success,
    ).toBe(false);
  });

  it("rejects from after to", async () => {
    const { apiStatsQuerySchema } = await load();
    expect(apiStatsQuerySchema.safeParse({ from: "2026-02-01", to: "2026-01-01" }).success).toBe(
      false,
    );
  });

  it("rejects invalid dates and paging values", async () => {
    const { apiStatsQuerySchema, STATS_MAX_LIMIT } = await load();
    for (const bad of [
      { from: "yesterday" },
      { to: "2026-13-45" },
      { from: "1700000000" },
      { limit: "0" },
      { limit: String(STATS_MAX_LIMIT + 1) },
      { limit: "abc" },
      { offset: "-1" },
      { offset: "1.5" },
      { unknown: "x" },
    ]) {
      expect(apiStatsQuerySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("display text safety (#215)", () => {
  const withName = (name: string) => createApiSchema.safeParse({ ...createInput, name });

  it("rejects each unsafe character class in names", () => {
    const bad = {
      "C0 control (BEL)": "Weather\u0007",
      "C1 control": "Weather\u0085",
      DEL: "Weather\u007F",
      "bidi override (RLO)": "Weather‮gnp.exe",
      "bidi isolate": "Weather⁦x",
      "zero-width space": "Wea​ther",
      "zero-width joiner": "Wea‍ther",
      "word joiner": "Wea⁠ther",
      "byte order mark inside": "Wea\uFEFFther",
      "arabic letter mark": "Weather؜",
    };
    for (const [label, name] of Object.entries(bad)) {
      expect(withName(name).success, label).toBe(false);
    }
  });

  it("rejects the same classes in tags", () => {
    expect(createApiSchema.safeParse({ ...createInput, tags: ["fin‮ance"] }).success).toBe(false);
    expect(createApiSchema.safeParse({ ...createInput, tags: ["fi​nance"] }).success).toBe(false);
    expect(createApiSchema.safeParse({ ...createInput, tags: ["finance"] }).success).toBe(true);
  });

  it("rejects unsafe characters in descriptions but allows line breaks and tabs", () => {
    expect(
      createApiSchema.safeParse({ ...createInput, description: "Line one\nLine\ttwo\r\n" }).success,
    ).toBe(true);
    expect(
      createApiSchema.safeParse({ ...createInput, description: "Hidden\u0000null" }).success,
    ).toBe(false);
    expect(
      createApiSchema.safeParse({ ...createInput, description: "Override‪text" }).success,
    ).toBe(false);
  });

  it("applies the same rules on update", () => {
    expect(updateApiSchema.safeParse({ name: "Ok‮" }).success).toBe(false);
    expect(updateApiSchema.safeParse({ description: "ok​" }).success).toBe(false);
    expect(updateApiSchema.safeParse({ name: "Ok name" }).success).toBe(true);
  });

  it("normalizes names to NFC and keeps ordinary Unicode text", () => {
    const decomposed = withName("Café Amélie");
    expect(decomposed.success).toBe(true);
    if (decomposed.success) expect(decomposed.data.name).toBe("Café Amélie");
    expect(withName("天気 API 🌤").success).toBe(true);
  });
});
