import { Keypair } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

// #276: a pass or free quota must never be granted from an address that is
// only parsed out of the payment header. The wallet has to be proven by a
// signature (signed X-Access-* request or signed x402 payment).

const state = vi.hoisted(() => ({
  rows: [] as unknown[][],
  payer: { address: undefined as string | undefined, signed: false },
}));

function chain() {
  const c: Record<string, unknown> = {};
  for (const m of ["from", "where", "limit", "select"]) c[m] = vi.fn(() => c);
  c.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve(state.rows.shift() ?? []).then(res, rej);
  return c;
}

vi.mock("../config.js", () => ({
  config: { NETWORK: "stellar:testnet", SIGNATURE_MAX_SKEW_MS: 300_000 },
}));
vi.mock("../db/client.js", () => ({ db: { select: vi.fn(() => chain()) } }));
vi.mock("../lib/logger.js", () => ({
  getLogger: () => ({ debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../lib/x402.js", () => ({ sharedX402ResourceServer: vi.fn() }));
vi.mock("../lib/payer.js", () => ({
  paymentHeader: (req: { headers: Record<string, unknown> }) => req.headers["x-payment"],
  payerFromPayment: (header: string | undefined) =>
    header ? state.payer : { address: undefined, signed: false },
}));

import { buildApiCreditSpendMessage, API_ACCESS_MESSAGE_TAG } from "../lib/apiCreditSignature.js";
import { EMPTY_BODY_HASH } from "../utils/requestSignature.js";
import { clearAccessNonces } from "../lib/payerAccessProof.js";
import { checkPayerAccess } from "./apiPaywall.js";

const PASS_HOLDER = Keypair.random();

function run(api: Record<string, unknown>, headers: Record<string, unknown>, url = "/api/1/data") {
  const res = { locals: { api }, status: vi.fn(() => res), json: vi.fn(() => res) } as any;
  const next = vi.fn();
  const req = { headers, method: "GET", originalUrl: url, body: undefined } as any;
  return Promise.resolve(checkPayerAccess(req, res, next)).then(() => ({ res, next }));
}

function signedAccessHeaders(
  keypair: Keypair,
  url = "/api/1/data",
  nonce = "nonce-0123456789abcdef",
) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const message = buildApiCreditSpendMessage({
    walletAddress: keypair.publicKey(),
    apiId: "1",
    method: "GET",
    path: url,
    timestamp,
    nonce,
    bodyHash: EMPTY_BODY_HASH,
    tag: API_ACCESS_MESSAGE_TAG,
  });
  return {
    "x-access-wallet": keypair.publicKey(),
    "x-access-timestamp": timestamp,
    "x-access-nonce": nonce,
    "x-access-signature": keypair.sign(Buffer.from(message, "utf8")).toString("base64"),
  };
}

beforeEach(() => {
  state.rows = [];
  state.payer = { address: undefined, signed: false };
  clearAccessNonces();
});

describe("forged payment headers (#276)", () => {
  it("a forged header naming a pass holder does not skip the paywall (402)", async () => {
    state.payer = { address: PASS_HOLDER.publicKey(), signed: false };
    // Would be found if the pass lookup ran.
    state.rows.push([{ id: "pass-1" }]);
    const { res, next } = await run({ id: 1, freeCallsPerDay: 0 }, { "x-payment": "forged" });
    expect(next).toHaveBeenCalledOnce();
    expect(res.locals.passId).toBeUndefined();
    expect(res.locals.freeCall).toBe(false);
  });

  it("forged random addresses are never granted free quota", async () => {
    for (let i = 0; i < 3; i++) {
      state.payer = { address: Keypair.random().publicKey(), signed: false };
      state.rows.push([{ count: 0 }]);
      const { res } = await run({ id: 1, freeCallsPerDay: 5 }, { "x-payment": `forged-${i}` });
      expect(res.locals.freeCall).toBe(false);
      expect(res.locals.accessPayer).toBeUndefined();
    }
  });

  it("an access signature by another wallet is rejected with 401", async () => {
    const headers = {
      ...signedAccessHeaders(Keypair.random()),
      "x-access-wallet": PASS_HOLDER.publicKey(),
    };
    const { res, next } = await run({ id: 1, freeCallsPerDay: 0 }, headers);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("a replayed access nonce is rejected with 401", async () => {
    const headers = signedAccessHeaders(PASS_HOLDER);
    state.rows.push([{ id: "pass-1" }]);
    await run({ id: 1, freeCallsPerDay: 0 }, headers);
    const { res, next } = await run({ id: 1, freeCallsPerDay: 0 }, headers);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});

describe("proven wallets (#276)", () => {
  it("a signed access request from the pass holder uses the pass", async () => {
    state.rows.push([{ id: "pass-1" }]);
    const { res, next } = await run(
      { id: 1, freeCallsPerDay: 0 },
      signedAccessHeaders(PASS_HOLDER),
    );
    expect(next).toHaveBeenCalledOnce();
    expect(res.locals.passId).toBe("pass-1");
    expect(res.locals.accessPayer).toBe(PASS_HOLDER.publicKey());
  });

  it("a signed access request within quota gets a free call recorded to that wallet", async () => {
    state.rows.push([{ count: 0 }]);
    const { res } = await run({ id: 1, freeCallsPerDay: 2 }, signedAccessHeaders(PASS_HOLDER));
    expect(res.locals.freeCall).toBe(true);
    expect(res.locals.accessPayer).toBe(PASS_HOLDER.publicKey());
  });

  it("a signed x402 payment proves the wallet", async () => {
    state.payer = { address: PASS_HOLDER.publicKey(), signed: true };
    state.rows.push([{ id: "pass-1" }]);
    const { res } = await run({ id: 1, freeCallsPerDay: 0 }, { "x-payment": "signed" });
    expect(res.locals.passId).toBe("pass-1");
  });
});
