import { beforeEach, describe, expect, it, vi } from "vitest";

const queue = vi.hoisted(() => ({ results: [] as unknown[][] }));

function chain() {
  const next = () => queue.results.shift() ?? [];
  const c: Record<string, unknown> = {};
  for (const m of [
    "values",
    "onConflictDoNothing",
    "onConflictDoUpdate",
    "set",
    "where",
    "limit",
    "from",
    "select",
  ]) {
    c[m] = vi.fn(() => c);
  }
  c.returning = vi.fn(() => Promise.resolve(next()));
  c.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
    Promise.resolve(next()).then(res, rej);
  return c;
}

vi.mock("../db/client.js", () => {
  const tx = {
    insert: vi.fn(() => chain()),
    update: vi.fn(() => chain()),
    select: vi.fn(() => chain()),
  };
  return {
    db: {
      transaction: vi.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
      select: vi.fn(() => chain()),
    },
    __tx: tx,
  };
});

import { db } from "../db/client.js";
import { ApiCreditError, purchaseApiCredits, spendApiCredit } from "./apiCredits.js";

const args = { apiId: "api-1", walletAddress: "GWALLET" };

describe("prepaid call credits", () => {
  beforeEach(() => {
    queue.results = [];
    vi.clearAllMocks();
  });

  it("buying credits adds the purchased calls to the balance", async () => {
    queue.results = [[{ id: 1 }], [{ balance: 5 }]];
    await expect(purchaseApiCredits({ ...args, calls: 5, reference: "ref-1" })).resolves.toEqual({
      balance: 5,
      duplicate: false,
    });
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it("a repeated purchase reference does not add credits twice", async () => {
    queue.results = [[], [{ balance: 5 }]];
    await expect(purchaseApiCredits({ ...args, calls: 5, reference: "ref-1" })).resolves.toEqual({
      balance: 5,
      duplicate: true,
    });
  });

  it("spending one credit per signed call returns the remaining balance", async () => {
    queue.results = [[{ id: 2 }], [{ balance: 4 }]];
    await expect(spendApiCredit({ ...args, nonce: "n-1" })).resolves.toBe(4);
  });

  it("rejects a replayed nonce with 409", async () => {
    queue.results = [[]];
    const err = await spendApiCredit({ ...args, nonce: "n-1" }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiCreditError);
    expect(err.status).toBe(409);
  });

  it("returns 402 when the balance is exhausted", async () => {
    queue.results = [[{ id: 3 }], []];
    const err = await spendApiCredit({ ...args, nonce: "n-2" }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiCreditError);
    expect(err.status).toBe(402);
  });
});
