import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ rows: [] as unknown[][], payer: "" as string }));

function chain() {
  const c: Record<string, unknown> = {};
  for (const m of ["from", "where", "limit", "select"]) c[m] = vi.fn(() => c);
  c.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve(state.rows.shift() ?? []).then(res, rej);
  return c;
}

vi.mock("../config.js", () => ({ config: { NETWORK: "stellar:testnet" } }));
vi.mock("../db/index.js", () => ({ db: { select: vi.fn(() => chain()) } }));
vi.mock("../lib/logger.js", () => ({
  getLogger: () => ({ debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../lib/x402.js", () => ({ sharedX402ResourceServer: vi.fn() }));
vi.mock("../lib/payer.js", () => ({
  paymentHeader: (req: { headers: Record<string, unknown> }) => req.headers["x-payment"],
  payerFromPayment: (header: string | undefined) => ({
    address: header ? state.payer : undefined,
    signed: Boolean(header),
  }),
}));

import { checkPayerAccess, checkPayerAllowDeny } from "./apiPaywall.js";

function run(api: Record<string, unknown>, headers: Record<string, unknown> = {}) {
  const res = { locals: { api }, status: vi.fn(() => res), json: vi.fn(() => res) } as any;
  const next = vi.fn();
  const req = { headers } as any;
  return Promise.resolve(checkPayerAccess(req, res, next)).then(() => ({ res, next }));
}

function runAllowDeny(api: Record<string, unknown>, headers: Record<string, unknown> = {}) {
  const res = { locals: { api }, status: vi.fn(() => res), json: vi.fn(() => res) } as any;
  const next = vi.fn();
  checkPayerAllowDeny({ headers } as any, res, next);
  return { res, next };
}

describe("time-based access passes", () => {
  beforeEach(() => {
    state.rows = [];
    state.payer = "GPAYER";
  });

  it("free calls while a pass is active: skips the paywall and records the pass", async () => {
    state.rows.push([{ id: "pass-1" }]);
    const { res, next } = await run({ id: "api-1", freeCallsPerDay: 0 }, { "x-payment": "sig" });
    expect(next).toHaveBeenCalledOnce();
    expect(res.locals.passId).toBe("pass-1");
    expect(res.locals.freeCall).toBe(false);
  });

  it("paywall again after expiry: no active pass means the request falls through to x402", async () => {
    state.rows.push([]);
    const { res, next } = await run({ id: "api-1", freeCallsPerDay: 0 }, { "x-payment": "sig" });
    expect(next).toHaveBeenCalledOnce();
    expect(res.locals.passId).toBeUndefined();
    expect(res.locals.freeCall).toBe(false);
  });
});

describe("daily free call quota", () => {
  beforeEach(() => {
    state.rows = [];
    state.payer = "GPAYER";
  });

  it("N free calls per wallet per day: calls under quota skip the paywall", async () => {
    state.rows.push([{ count: 2 }]);
    const { res, next } = await run({ id: "api-1", freeCallsPerDay: 3 }, { "x-payment": "sig" });
    expect(next).toHaveBeenCalledOnce();
    expect(res.locals.freeCall).toBe(true);
  });

  it("then 402: once the quota is used up the request reaches the paywall", async () => {
    state.rows.push([{ count: 3 }]);
    const { res, next } = await run({ id: "api-1", freeCallsPerDay: 3 }, { "x-payment": "sig" });
    expect(next).toHaveBeenCalledOnce();
    expect(res.locals.freeCall).toBe(false);
  });

  it("resets at the UTC day boundary: the count for the new day starts at zero", async () => {
    // The SQL filters on date_trunc('day', now() at time zone 'UTC'), so
    // yesterday's calls drop out of the count and the next call is free again.
    state.rows.push([{ count: 0 }]);
    const { res } = await run({ id: "api-1", freeCallsPerDay: 3 }, { "x-payment": "sig" });
    expect(res.locals.freeCall).toBe(true);
  });
});

describe("payer allow and deny lists", () => {
  beforeEach(() => {
    state.rows = [];
    state.payer = "GDENIED";
  });

  it("denied wallets get 403 before payment is required", async () => {
    const { res, next } = runAllowDeny(
      { id: "api-1", payerDenylist: ["GDENIED"], payerAllowlist: null },
      { "x-payment": "sig" },
    );
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("allowlists restrict access: wallets not on the list get 403", async () => {
    state.payer = "GOTHER";
    const { res, next } = runAllowDeny(
      { id: "api-1", payerDenylist: [], payerAllowlist: ["GALLOWED"] },
      { "x-payment": "sig" },
    );
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it("allowlisted wallets pass through", async () => {
    state.payer = "GALLOWED";
    const { next } = runAllowDeny(
      { id: "api-1", payerDenylist: [], payerAllowlist: ["GALLOWED"] },
      { "x-payment": "sig" },
    );
    expect(next).toHaveBeenCalledOnce();
  });
});
