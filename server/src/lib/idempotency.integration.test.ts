import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config.js", () => ({ config: { NODE_ENV: "test" } }));

import { getProxyIdempotencyStore, type ProxyIdempotencyKey } from "./idempotency.js";

const key: ProxyIdempotencyKey = { apiId: 1, payer: "GPAYER", key: "idem-1" };

describe("Idempotency-Key on paid calls", () => {
  beforeEach(() => {
    // Fresh state per test: remove any record left by a previous test.
    return getProxyIdempotencyStore().delete(key);
  });

  it("claims a key once, so a concurrent retry cannot start a second charge", async () => {
    const store = getProxyIdempotencyStore();
    expect(await store.claim(key, "fp")).toBe(true);
    expect(await store.claim(key, "fp")).toBe(false);
  });

  it("replays the first stored response for a retried key without a second charge", async () => {
    const store = getProxyIdempotencyStore();
    await store.claim(key, "fp");
    await store.complete(key, {
      inProgress: false,
      fingerprint: "fp",
      paymentHash: "pay-hash",
      response: { status: 200, headers: {}, body: Buffer.from("ok") },
      txHash: "tx1",
    });

    const record = await store.get(key);
    expect(record).toMatchObject({ inProgress: false, txHash: "tx1" });
    expect((record as any).response.body.toString()).toBe("ok");
  });
});
