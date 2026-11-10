import { describe, it, expect, vi } from "vitest";
import { API_TOOL_DEFINITIONS, createApiToolHandler, type ApiToolDeps } from "./apiTools.js";
import { TOOL_DEFINITIONS } from "./tools.js";
import { isReadOnlyTool } from "./readOnlyMode.js";

const API = {
  id: "api1",
  name: "Weather",
  price: "0.01",
  allowedMethods: ["GET", "POST"],
  proxyUrl: "http://gw.test/api/api1",
};

function setup(
  overrides: Partial<ApiToolDeps> = {},
  upstream = new Response('{"temp":30}', { status: 200 }),
) {
  const paid = vi.fn(async () => upstream);
  const deps: ApiToolDeps = {
    baseUrl: () => "http://gw.test",
    network: () => "stellar:testnet",
    jsonFetch: vi.fn(async (url: string) =>
      url === "http://gw.test/apis/api1"
        ? { ok: true, status: 200, data: API }
        : { ok: true, status: 200, data: [] },
    ),
    requireApiKey: () => "key",
    requireWallet: () => ({ publicKey: "GPUB", secretKey: "SSEC" }),
    paidFetch: () => paid as unknown as typeof fetch,
    assertWithinCeiling: vi.fn(),
    insufficientFundsMessage: vi.fn(async () => null),
    recordPurchase: vi.fn(),
    ...overrides,
  };
  return { deps, paid, handle: createApiToolHandler(deps) };
}

describe("API tool surface", () => {
  it("is part of the advertised definitions with the right read-only flags", () => {
    for (const tool of API_TOOL_DEFINITIONS) expect(TOOL_DEFINITIONS).toContain(tool);
    expect(isReadOnlyTool("zentrixpay_list_apis")).toBe(true);
    expect(isReadOnlyTool("zentrixpay_call")).toBe(false);
  });
});

describe("zentrixpay_call", () => {
  it("pays through the proxy URL with path, query and JSON body, and records the purchase", async () => {
    const { handle, paid, deps } = setup();
    const out = JSON.parse(
      await handle("zentrixpay_call", {
        apiId: "api1",
        method: "POST",
        path: "/forecast/lagos",
        query: { units: "metric" },
        body: { days: 3 },
      }),
    );
    expect(paid).toHaveBeenCalledWith("http://gw.test/api/api1/forecast/lagos?units=metric", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"days":3}',
    });
    expect(out).toMatchObject({ status: 200, charged: true, body: '{"temp":30}' });
    expect(deps.recordPurchase).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: "api1", amount: "0.01" }),
    );
  });

  it("reports failed calls as not charged and records nothing", async () => {
    const { handle, deps } = setup({}, new Response("boom", { status: 502 }));
    const out = JSON.parse(await handle("zentrixpay_call", { apiId: "api1" }));
    expect(out).toMatchObject({ status: 502, charged: false });
    expect(deps.recordPurchase).not.toHaveBeenCalled();
  });

  it("refuses methods the API does not allow before paying", async () => {
    const { handle, paid } = setup();
    await expect(handle("zentrixpay_call", { apiId: "api1", method: "DELETE" })).rejects.toThrow(
      /does not accept DELETE/,
    );
    expect(paid).not.toHaveBeenCalled();
  });

  it("stops before paying when the wallet is short", async () => {
    const { handle, paid } = setup({ insufficientFundsMessage: async () => "Insufficient USDC" });
    expect(await handle("zentrixpay_call", { apiId: "api1" })).toBe("Insufficient USDC");
    expect(paid).not.toHaveBeenCalled();
  });
});

describe("provider tools", () => {
  it("register_api sends the API key and nests the secret header", async () => {
    const { handle, deps } = setup();
    await handle("zentrixpay_register_api", {
      name: "Weather",
      upstreamUrl: "https://api.example.com",
      price: "0.01",
      upstreamHeaderName: "x-key",
      upstreamHeaderValue: "s3cret",
    });
    const [url, init] = (deps.jsonFetch as any).mock.calls[0];
    expect(url).toBe("http://gw.test/apis");
    expect(init.headers["x-api-key"]).toBe("key");
    expect(JSON.parse(init.body)).toEqual({
      name: "Weather",
      upstreamUrl: "https://api.example.com",
      price: "0.01",
      upstreamHeader: { name: "x-key", value: "s3cret" },
    });
  });

  it("rejects a header name without a value", async () => {
    const { handle } = setup();
    await expect(
      handle("zentrixpay_update_api", { apiId: "api1", upstreamHeaderName: "x-key" }),
    ).rejects.toThrow(/together/);
  });

  it("api_stats forwards optional from/to date filters and limit/offset pagination (#143)", async () => {
    const { handle, deps } = setup();
    await handle("zentrixpay_api_stats", {
      apiId: "api1",
      from: "2026-03-01",
      to: "2026-03-31",
      limit: 25,
      offset: 50,
    });
    const [url, init] = (deps.jsonFetch as any).mock.calls[0];
    expect(url).toBe(
      "http://gw.test/apis/api1/stats?from=2026-03-01&to=2026-03-31&limit=25&offset=50",
    );
    expect(init.headers["x-api-key"]).toBe("key");
  });

  it("api_stats rejects invalid date ranges and out-of-bounds pagination before fetching (#143)", async () => {
    const { handle, deps } = setup();
    await expect(
      handle("zentrixpay_api_stats", {
        apiId: "api1",
        from: "2026-03-31",
        to: "2026-03-01",
      }),
    ).rejects.toThrow(/earlier than or equal to/);

    await expect(
      handle("zentrixpay_api_stats", {
        apiId: "api1",
        from: "2026-02-30",
      }),
    ).rejects.toThrow(/valid ISO-8601/);

    await expect(
      handle("zentrixpay_api_stats", {
        apiId: "api1",
        limit: 500,
      }),
    ).rejects.toThrow(/limit/);

    expect(deps.jsonFetch).not.toHaveBeenCalled();
  });
});
