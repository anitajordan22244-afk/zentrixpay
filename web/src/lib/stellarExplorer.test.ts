import { afterEach, describe, expect, it, vi } from "vitest";
import { explorerTxUrl } from "./stellarExplorer.js";

describe("explorerTxUrl", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("uses the Stellar Expert testnet explorer by default", () => {
    vi.stubEnv("VITE_STELLAR_NETWORK", "testnet");
    expect(explorerTxUrl("abc123")).toBe("https://stellar.expert/explorer/testnet/tx/abc123");
  });

  it("uses the public explorer for mainnet", () => {
    vi.stubEnv("VITE_STELLAR_NETWORK", "mainnet");
    expect(explorerTxUrl("abc123")).toBe("https://stellar.expert/explorer/public/tx/abc123");
  });
});
