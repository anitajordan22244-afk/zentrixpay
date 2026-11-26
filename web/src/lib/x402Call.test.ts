import { afterEach, describe, expect, it, vi } from "vitest";
import { callPaidApi } from "./x402Call.js";

describe("callPaidApi", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("requests the API with a wallet address without requiring a secret key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(
      callPaidApi("https://api.example.test", `G${"A".repeat(55)}`, {
        method: "GET",
        path: "/resource",
        price: "0.01",
      }),
    ).resolves.toMatchObject({
      status: 200,
      charged: false,
      body: { ok: true },
    });
  });
});
