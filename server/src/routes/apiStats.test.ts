import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

interface CallRecord {
  id: string;
  apiId: string;
  payerAddress: string;
  amount: string;
  charged: boolean;
  txHash: string | null;
  method: string;
  path: string;
  responseStatus: number;
  durationMs: number;
  refundStatus: "pending" | "refunded" | null;
  refundAmount: string | null;
  refundTxHash: string | null;
  refundedAt: Date | null;
  createdAt: Date;
}

const { state } = vi.hoisted(() => ({
  state: {
    api: {
      id: "api-143",
      publisherId: "pub-1",
      name: "Analytics API",
      archivedAt: null as Date | null,
    },
    calls: [] as CallRecord[],
    lastStatsRange: null as { from?: Date; to?: Date } | null,
    lastRecentCallsOpts: null as {
      from?: Date;
      to?: Date;
      limit?: number;
      offset?: number;
    } | null,
  },
}));

vi.mock("../config.js", () => ({
  config: {
    BASE_URL: "http://gateway.test",
    UPSTREAM_SECRET_KEY: "11".repeat(32),
    PROXY_MAX_REQUEST_BODY: "1mb",
    PROXY_MAX_RESPONSE_BYTES: 1024,
    PROXY_DEFAULT_TIMEOUT_MS: 500,
    PROXY_MAX_TIMEOUT_MS: 1000,
    PROXY_ALLOW_PRIVATE_UPSTREAMS: true,
  },
}));
vi.mock("../db/client.js", () => ({ db: {} }));
vi.mock("../middleware/apiKeyAuth.js", () => ({
  apiKeyAuth: (req: any, _res: unknown, next: () => void) => {
    req.publisher = { id: "pub-1", walletAddress: "G" + "A".repeat(55) };
    next();
  },
}));
vi.mock("../middleware/rateLimiters.js", () => ({
  publishIpRateLimit: (_q: unknown, _s: unknown, n: () => void) => n(),
  publishWalletRateLimit: (_q: unknown, _s: unknown, n: () => void) => n(),
}));
vi.mock("../middleware/apiPaywall.js", async () => {
  const actual = await vi.importActual<typeof import("../middleware/apiPaywall.js")>(
    "../middleware/apiPaywall.js",
  );
  return { ...actual, apiPaywall: (_q: unknown, _s: unknown, n: () => void) => n() };
});

function filterCalls(apiId: string, opts: { from?: Date; to?: Date } = {}): CallRecord[] {
  return state.calls
    .filter((c) => {
      if (c.apiId !== apiId) return false;
      if (opts.from && c.createdAt.getTime() < opts.from.getTime()) return false;
      if (opts.to && c.createdAt.getTime() > opts.to.getTime()) return false;
      return true;
    })
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));
}

vi.mock("../services/apiService.js", async () => {
  const actual = await vi.importActual<typeof import("../services/apiService.js")>(
    "../services/apiService.js",
  );
  return {
    ...actual,
    getOwnedApi: async (id: string, publisherId: string) => {
      if (state.api.id !== id || state.api.publisherId !== publisherId) {
        throw new actual.ApiServiceError(404, "API not found");
      }
      return state.api;
    },
    getApiStats: async (apiId: string, opts: { from?: Date; to?: Date } = {}) => {
      state.lastStatsRange = opts;
      const matching = filterCalls(apiId, opts);
      const charged = matching.filter((c) => c.charged);
      const refunded = matching.filter((c) => c.refundStatus === "refunded");
      const revenueNum = charged.reduce((sum, c) => sum + Number(c.amount), 0);
      const refundedNum = refunded.reduce((sum, c) => sum + Number(c.refundAmount ?? 0), 0);
      const avgDurationMs =
        matching.length > 0
          ? Math.round(matching.reduce((sum, c) => sum + c.durationMs, 0) / matching.length)
          : 0;
      const uniquePayers = new Set(charged.map((c) => c.payerAddress)).size;
      return {
        calls: matching.length,
        chargedCalls: charged.length,
        revenue: revenueNum === 0 ? "0" : revenueNum.toFixed(2),
        uniquePayers,
        avgDurationMs,
        refundedCalls: refunded.length,
        refunded: refundedNum === 0 ? "0" : refundedNum.toFixed(2),
        netRevenue: revenueNum - refundedNum === 0 ? "0" : (revenueNum - refundedNum).toFixed(2),
        currency: "USDC" as const,
      };
    },
    listRecentCalls: async (
      apiId: string,
      limitOrOpts: number | { from?: Date; to?: Date; limit?: number; offset?: number } = 50,
    ) => {
      const opts = typeof limitOrOpts === "number" ? { limit: limitOrOpts } : limitOrOpts;
      state.lastRecentCallsOpts = opts;
      const matching = filterCalls(apiId, opts);
      const offset = opts.offset ?? 0;
      const limit = opts.limit ?? 50;
      return matching.slice(offset, offset + limit);
    },
  };
});

import router from "./apis.js";
import {
  apiStatsQuerySchema,
  parseStatsBoundaryDate,
  STATS_DEFAULT_LIMIT,
  STATS_MAX_LIMIT,
} from "../schemas/requests.js";

const app = express();
app.use(router);

function makeCall(
  id: string,
  createdAtIso: string,
  overrides: Partial<CallRecord> = {},
): CallRecord {
  return {
    id,
    apiId: "api-143",
    payerAddress: "G" + "B".repeat(55),
    amount: "0.05",
    charged: true,
    txHash: `tx-${id}`,
    method: "GET",
    path: "/forecast",
    responseStatus: 200,
    durationMs: 120,
    refundStatus: null,
    refundAmount: null,
    refundTxHash: null,
    refundedAt: null,
    createdAt: new Date(createdAtIso),
    ...overrides,
  };
}

describe("apiStatsQuerySchema & parseStatsBoundaryDate (#143)", () => {
  it("expands YYYY-MM-DD from/to boundaries to start and end of UTC day", () => {
    const from = parseStatsBoundaryDate("2026-03-10", "from");
    const to = parseStatsBoundaryDate("2026-03-10", "to");

    expect(from?.toISOString()).toBe("2026-03-10T00:00:00.000Z");
    expect(to?.toISOString()).toBe("2026-03-10T23:59:59.999Z");
  });

  it("accepts full ISO-8601 timestamps and defaults limit/offset", () => {
    const parsed = apiStatsQuerySchema.safeParse({
      from: "2026-03-01T08:30:00Z",
      to: "2026-03-15T18:45:00.500Z",
    });

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.from?.toISOString()).toBe("2026-03-01T08:30:00.000Z");
      expect(parsed.data.to?.toISOString()).toBe("2026-03-15T18:45:00.500Z");
      expect(parsed.data.limit).toBe(STATS_DEFAULT_LIMIT);
      expect(parsed.data.offset).toBe(0);
    }
  });

  it("rejects impossible calendar dates and malformed date strings", () => {
    expect(apiStatsQuerySchema.safeParse({ from: "2026-02-30" }).success).toBe(false);
    expect(apiStatsQuerySchema.safeParse({ to: "2026-13-01" }).success).toBe(false);
    expect(apiStatsQuerySchema.safeParse({ from: "not-a-date" }).success).toBe(false);
  });

  it("rejects ranges where from is later than to", () => {
    const dateRange = apiStatsQuerySchema.safeParse({
      from: "2026-03-15",
      to: "2026-03-10",
    });
    expect(dateRange.success).toBe(false);

    const timestampRange = apiStatsQuerySchema.safeParse({
      from: "2026-03-10T12:00:01Z",
      to: "2026-03-10T12:00:00Z",
    });
    expect(timestampRange.success).toBe(false);
  });

  it("validates limit and offset bounds", () => {
    expect(apiStatsQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(apiStatsQuerySchema.safeParse({ limit: String(STATS_MAX_LIMIT + 1) }).success).toBe(
      false,
    );
    expect(apiStatsQuerySchema.safeParse({ offset: "-1" }).success).toBe(false);
  });
});

describe("GET /apis/:id/stats (#143)", () => {
  beforeEach(() => {
    state.calls = [
      makeCall("call-1", "2026-03-01T10:00:00.000Z", {
        amount: "0.10",
        durationMs: 100,
        payerAddress: "G" + "1".repeat(55),
      }),
      makeCall("call-2", "2026-03-05T15:30:00.000Z", {
        amount: "0.20",
        durationMs: 200,
        payerAddress: "G" + "2".repeat(55),
      }),
      makeCall("call-3", "2026-03-10T09:00:00.000Z", {
        amount: "0.30",
        durationMs: 300,
        payerAddress: "G" + "1".repeat(55),
      }),
      makeCall("call-4", "2026-03-15T20:00:00.000Z", {
        amount: "0.40",
        durationMs: 400,
        charged: false,
        responseStatus: 502,
      }),
    ];
    state.lastStatsRange = null;
    state.lastRecentCallsOpts = null;
  });

  it("returns 400 when from > to, dates are invalid, or pagination is out of range", async () => {
    const inverted = await request(app)
      .get("/apis/api-143/stats")
      .query({ from: "2026-03-20", to: "2026-03-01" });
    expect(inverted.status).toBe(400);

    const invalidDate = await request(app).get("/apis/api-143/stats").query({ from: "2026-02-29" });
    expect(invalidDate.status).toBe(400);

    const badLimit = await request(app).get("/apis/api-143/stats").query({ limit: 500 });
    expect(badLimit.status).toBe(400);

    const badOffset = await request(app).get("/apis/api-143/stats").query({ offset: -5 });
    expect(badOffset.status).toBe(400);
  });

  it("returns zeroed stats and an empty call list when the filtered range has no calls", async () => {
    const res = await request(app)
      .get("/apis/api-143/stats")
      .query({ from: "2026-04-01", to: "2026-04-30" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      apiId: "api-143",
      archivedAt: null,
      calls: 0,
      chargedCalls: 0,
      revenue: "0",
      uniquePayers: 0,
      avgDurationMs: 0,
      refundedCalls: 0,
      refunded: "0",
      netRevenue: "0",
      currency: "USDC",
      recentCalls: [],
      range: {
        from: "2026-04-01T00:00:00.000Z",
        to: "2026-04-30T23:59:59.999Z",
      },
      pagination: {
        limit: 50,
        offset: 0,
        total: 0,
        hasMore: false,
        nextOffset: null,
      },
    });
  });

  it("applies identical date range filtering to totals and recentCalls and paginates results", async () => {
    const page1 = await request(app).get("/apis/api-143/stats").query({
      from: "2026-03-05",
      to: "2026-03-15",
      limit: 2,
      offset: 0,
    });

    expect(page1.status).toBe(200);
    expect(state.lastStatsRange?.from?.toISOString()).toBe("2026-03-05T00:00:00.000Z");
    expect(state.lastStatsRange?.to?.toISOString()).toBe("2026-03-15T23:59:59.999Z");
    expect(state.lastRecentCallsOpts?.from?.toISOString()).toBe("2026-03-05T00:00:00.000Z");
    expect(state.lastRecentCallsOpts?.to?.toISOString()).toBe("2026-03-15T23:59:59.999Z");

    // Calls in [2026-03-05 .. 2026-03-15]: call-4, call-3, call-2 (3 total, 2 charged = 0.50 USDC)
    expect(page1.body.calls).toBe(3);
    expect(page1.body.chargedCalls).toBe(2);
    expect(page1.body.revenue).toBe("0.50");
    expect(page1.body.recentCalls.map((c: CallRecord) => c.id)).toEqual(["call-4", "call-3"]);
    expect(page1.body.pagination).toEqual({
      limit: 2,
      offset: 0,
      total: 3,
      hasMore: true,
      nextOffset: 2,
    });

    const page2 = await request(app).get("/apis/api-143/stats").query({
      from: "2026-03-05",
      to: "2026-03-15",
      limit: 2,
      offset: 2,
    });

    expect(page2.status).toBe(200);
    expect(page2.body.calls).toBe(3);
    expect(page2.body.recentCalls.map((c: CallRecord) => c.id)).toEqual(["call-2"]);
    expect(page2.body.pagination).toEqual({
      limit: 2,
      offset: 2,
      total: 3,
      hasMore: false,
      nextOffset: null,
    });
  });
});
