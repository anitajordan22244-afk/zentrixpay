import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockWarn } = vi.hoisted(() => ({
  mockWarn: vi.fn(),
}));

vi.mock("../db/client.js", () => ({ db: { execute: vi.fn() } }));
vi.mock("../config.js", () => ({
  config: {
    SOROBAN_RPC_URL: "https://rpc.example.test",
    FACILITATOR_URL: "https://facilitator.example.test",
    HEALTH_CHECK_TIMEOUT_MS: 100,
  },
}));
vi.mock("./logger.js", () => ({
  getLogger: () => ({ warn: mockWarn, info: vi.fn(), error: vi.fn() }),
}));

import { overallReadinessStatus } from "./readiness.js";
import { probeFacilitator } from "./probes.js";

describe("overallReadinessStatus", () => {
  it("returns ok when every dependency is healthy", () => {
    expect(
      overallReadinessStatus({
        database: { status: "ok", latencyMs: 1 },
        sorobanRpc: { status: "ok", latencyMs: 2 },
        facilitator: { status: "ok", latencyMs: 3 },
      }),
    ).toBe("ok");
  });

  it("returns error when any dependency fails", () => {
    expect(
      overallReadinessStatus({
        database: { status: "ok", latencyMs: 1 },
        sorobanRpc: {
          status: "error",
          latencyMs: 2,
          error: "soroban_rpc_unavailable",
        },
        facilitator: { status: "ok", latencyMs: 3 },
      }),
    ).toBe("error");

    expect(
      overallReadinessStatus({
        database: { status: "ok", latencyMs: 1 },
        sorobanRpc: { status: "ok", latencyMs: 2 },
        facilitator: {
          status: "error",
          latencyMs: 5,
          error: "facilitator_unavailable",
        },
      }),
    ).toBe("error");
  });
});

describe("probeFacilitator (#133)", () => {
  beforeEach(() => {
    mockWarn.mockReset();
  });

  it("queries GET /supported without initiating a payment and reports ok when healthy", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            kinds: [{ x402Version: 2, scheme: "exact", network: "stellar:testnet" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    const check = await probeFacilitator({
      facilitatorUrl: "https://facilitator.example.test/",
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://facilitator.example.test/supported",
      expect.objectContaining({
        method: "GET",
        headers: { Accept: "application/json" },
      }),
    );
    expect(check).toMatchObject({
      status: "ok",
      details: { supportedKinds: 1 },
    });
    expect(check.error).toBeUndefined();
  });

  it("reports facilitator_unavailable on non-2xx responses", async () => {
    const fetchMock = vi.fn(async () => new Response("Service Unavailable", { status: 503 }));

    const check = await probeFacilitator({
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(check).toMatchObject({
      status: "error",
      error: "facilitator_unavailable",
    });
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "readiness_probe_failed",
        dependency: "facilitator",
        code: "facilitator_unavailable",
      }),
      expect.any(String),
    );
  });

  it("aborts and reports facilitator_unavailable when the facilitator check times out", async () => {
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(init.signal?.reason ?? new Error("Aborted"));
          });
        }),
    );

    const check = await probeFacilitator({
      timeoutMs: 25,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(check).toMatchObject({
      status: "error",
      error: "facilitator_unavailable",
    });
    expect(mockWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "readiness_probe_failed",
        dependency: "facilitator",
        code: "facilitator_unavailable",
      }),
      expect.any(String),
    );
  });
});
