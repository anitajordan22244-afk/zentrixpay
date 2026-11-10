import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";

// Issue #136: readiness responses expose stable error codes only; the raw
// dependency error (which may embed connection strings) goes to server logs.

const { mockExecute, mockGetHealth, mockWarn, mockFetch } = vi.hoisted(() => ({
  mockExecute: vi.fn(),
  mockGetHealth: vi.fn(),
  mockWarn: vi.fn(),
  mockFetch: vi.fn(),
}));

vi.mock("../db/client.js", () => ({ db: { execute: mockExecute } }));
vi.mock("../config.js", () => ({
  config: {
    SOROBAN_RPC_URL: "https://rpc-internal.example:8000/soroban",
    FACILITATOR_URL: "https://facilitator-internal.example:9443/x402",
    HEALTH_CHECK_TIMEOUT_MS: 50,
  },
}));
vi.mock("@stellar/stellar-sdk", () => ({
  rpc: {
    Server: class {
      getHealth = mockGetHealth;
    },
  },
}));
vi.mock("../lib/logger.js", () => ({
  getLogger: () => ({ warn: mockWarn, info: vi.fn(), error: vi.fn() }),
}));
vi.mock("../lib/lifecycle.js", () => ({ isAccepting: () => true }));

import healthRouter from "./health.js";

const DB_ERROR =
  "connect ECONNREFUSED 10.0.12.5:5432 (postgres://zentrix:s3cr3t-pw@db.internal:5432/zentrixpay)";
const RPC_ERROR = "getaddrinfo ENOTFOUND rpc-internal.example (token=abc123)";
const FACILITATOR_ERROR =
  "connect ECONNREFUSED 10.0.99.8:9443 (https://facilitator-internal.example:9443/x402?api_key=fac-secret)";

function app() {
  const a = express();
  a.use(healthRouter);
  return a;
}

describe("GET /health/ready — sanitized errors & facilitator readiness (#133, #136)", () => {
  beforeEach(() => {
    mockExecute.mockReset();
    mockGetHealth.mockReset();
    mockWarn.mockReset();
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          kinds: [{ x402Version: 2, scheme: "exact", network: "stellar:testnet" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", mockFetch);
  });

  it("reports ok with no error fields when database, sorobanRpc, and facilitator are healthy", async () => {
    mockExecute.mockResolvedValue([]);
    mockGetHealth.mockResolvedValue({
      latestLedger: 10,
      oldestLedger: 1,
      ledgerRetentionWindow: 9,
    });

    const res = await request(app()).get("/health/ready");

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.checks.database.error).toBeUndefined();
    expect(res.body.checks.sorobanRpc.error).toBeUndefined();
    expect(res.body.checks.facilitator).toMatchObject({
      status: "ok",
      details: { supportedKinds: 1 },
    });
    expect(res.body.checks.facilitator.error).toBeUndefined();
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it("returns 503 not-ready when the payment facilitator is unhealthy", async () => {
    mockExecute.mockResolvedValue([]);
    mockGetHealth.mockResolvedValue({
      latestLedger: 10,
      oldestLedger: 1,
      ledgerRetentionWindow: 9,
    });
    mockFetch.mockResolvedValueOnce(new Response("Bad Gateway", { status: 502 }));

    const res = await request(app()).get("/health/ready");

    expect(res.status).toBe(503);
    expect(res.body.status).toBe("error");
    expect(res.body.checks.database.status).toBe("ok");
    expect(res.body.checks.sorobanRpc.status).toBe("ok");
    expect(res.body.checks.facilitator).toMatchObject({
      status: "error",
      error: "facilitator_unavailable",
    });
  });

  it("returns 503 not-ready when the payment facilitator check times out", async () => {
    mockExecute.mockResolvedValue([]);
    mockGetHealth.mockResolvedValue({
      latestLedger: 10,
      oldestLedger: 1,
      ledgerRetentionWindow: 9,
    });
    mockFetch.mockImplementationOnce(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(init.signal?.reason ?? new Error("Facilitator timed out"));
          });
        }),
    );

    const res = await request(app()).get("/health/ready");

    expect(res.status).toBe(503);
    expect(res.body.status).toBe("error");
    expect(res.body.checks.facilitator).toMatchObject({
      status: "error",
      error: "facilitator_unavailable",
    });
  });

  it("keeps GET /health liveness endpoint independent of downstream dependency failures", async () => {
    mockExecute.mockRejectedValue(new Error(DB_ERROR));
    mockGetHealth.mockRejectedValue(new Error(RPC_ERROR));
    mockFetch.mockRejectedValue(new Error(FACILITATOR_ERROR));

    const res = await request(app()).get("/health");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "ok",
      service: "zentrixpay",
    });
    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockGetHealth).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns stable error codes instead of raw dependency messages", async () => {
    mockExecute.mockRejectedValue(new Error(DB_ERROR));
    mockGetHealth.mockRejectedValue(new Error(RPC_ERROR));
    mockFetch.mockRejectedValue(new Error(FACILITATOR_ERROR));

    const res = await request(app()).get("/health/ready");

    expect(res.status).toBe(503);
    expect(res.body.status).toBe("error");
    expect(res.body.checks.database).toMatchObject({
      status: "error",
      error: "database_unavailable",
    });
    expect(res.body.checks.sorobanRpc).toMatchObject({
      status: "error",
      error: "soroban_rpc_unavailable",
    });
    expect(res.body.checks.facilitator).toMatchObject({
      status: "error",
      error: "facilitator_unavailable",
    });
  });

  it("never exposes connection details in the response body", async () => {
    mockExecute.mockRejectedValue(new Error(DB_ERROR));
    mockGetHealth.mockRejectedValue(new Error(RPC_ERROR));
    mockFetch.mockRejectedValue(new Error(FACILITATOR_ERROR));

    const res = await request(app()).get("/health/ready");

    for (const leaked of [
      "s3cr3t-pw",
      "postgres://",
      "db.internal",
      "10.0.12.5",
      "5432",
      "ECONNREFUSED",
      "rpc-internal.example",
      "token=abc123",
      "ENOTFOUND",
      "facilitator-internal.example",
      "fac-secret",
    ]) {
      expect(res.text).not.toContain(leaked);
    }
  });

  it("keeps the raw error in server-side logs", async () => {
    const dbErr = new Error(DB_ERROR);
    mockExecute.mockRejectedValue(dbErr);
    mockGetHealth.mockResolvedValue({ latestLedger: 1, oldestLedger: 1, ledgerRetentionWindow: 0 });

    await request(app()).get("/health/ready");

    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "readiness_probe_failed",
        dependency: "database",
        code: "database_unavailable",
        err: dbErr,
      }),
      expect.any(String),
    );
  });

  it("sanitizes non-Error rejections too", async () => {
    mockExecute.mockRejectedValue("FATAL: password authentication failed for user zentrix");
    mockGetHealth.mockResolvedValue({ latestLedger: 1, oldestLedger: 1, ledgerRetentionWindow: 0 });

    const res = await request(app()).get("/health/ready");

    expect(res.body.checks.database.error).toBe("database_unavailable");
    expect(res.text).not.toContain("password authentication");
  });
});
