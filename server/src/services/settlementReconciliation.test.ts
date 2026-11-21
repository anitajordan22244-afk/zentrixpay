import { describe, expect, it } from "vitest";
import {
  reconcileCalls,
  horizonLookup,
  type ChargedCall,
  type HorizonTx,
} from "./settlementReconciliation.js";

const onChain: Record<string, HorizonTx> = {
  okTx: { hash: "okTx", successful: true },
  failTx: { hash: "failTx", successful: false },
};
const lookup = async (hash: string) => onChain[hash] ?? null;

describe("reconcileCalls", () => {
  it("reports no mismatches when every charged call settled on chain", async () => {
    const calls: ChargedCall[] = [{ id: 1, apiId: 9, charged: true, settlementTx: "okTx" }];
    expect(await reconcileCalls(calls, lookup)).toEqual([]);
  });

  it("ignores uncharged calls", async () => {
    const calls: ChargedCall[] = [{ id: 2, apiId: 9, charged: false, settlementTx: null }];
    expect(await reconcileCalls(calls, lookup)).toEqual([]);
  });

  it("reports a seeded mismatch: charged call whose settlement is missing on chain", async () => {
    const calls: ChargedCall[] = [
      { id: 3, apiId: 9, charged: true, settlementTx: "seededMissingTx" },
    ];
    expect(await reconcileCalls(calls, lookup)).toEqual([
      {
        kind: "settlement_not_on_chain",
        callId: 3,
        apiId: 9,
        settlementTx: "seededMissingTx",
      },
    ]);
  });

  it("reports a settlement that failed on chain", async () => {
    const calls: ChargedCall[] = [{ id: 4, apiId: 5, charged: true, settlementTx: "failTx" }];
    const result = await reconcileCalls(calls, lookup);
    expect(result).toHaveLength(1);
    expect(result[0]?.kind).toBe("settlement_failed_on_chain");
  });

  it("reports a charged call with no settlement transaction recorded", async () => {
    const calls: ChargedCall[] = [{ id: 5, apiId: 5, charged: true, settlementTx: null }];
    expect(await reconcileCalls(calls, lookup)).toEqual([
      { kind: "charged_without_settlement", callId: 5, apiId: 5, settlementTx: null },
    ]);
  });

  it("looks up each distinct hash once", async () => {
    let calls = 0;
    const counting = async (hash: string) => {
      calls++;
      return onChain[hash] ?? null;
    };
    const rows: ChargedCall[] = [1, 2, 3].map((id) => ({
      id,
      apiId: 1,
      charged: true,
      settlementTx: "okTx",
    }));
    await reconcileCalls(rows, counting);
    expect(calls).toBe(1);
  });
});

describe("horizonLookup", () => {
  it("maps a 404 to null and a 200 to the transaction", async () => {
    const fetchImpl = (async (url: string) => {
      if (url.endsWith("/transactions/gone")) return new Response("", { status: 404 });
      return new Response(JSON.stringify({ hash: "abc", successful: true }), { status: 200 });
    }) as unknown as typeof fetch;
    const lookup = horizonLookup("https://horizon.example", fetchImpl);
    expect(await lookup("gone")).toBeNull();
    expect(await lookup("abc")).toEqual({ hash: "abc", successful: true });
  });

  it("throws on other HTTP errors so the run is not silently treated as a mismatch", async () => {
    const fetchImpl = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    await expect(horizonLookup("https://h", fetchImpl)("x")).rejects.toThrow("503");
  });
});
