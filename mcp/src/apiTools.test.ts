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

  it("rejects path traversal, backslashes, and null bytes before calling or paying (#130)", async () => {
    const { handle, paid } = setup();
    await expect(handle("zentrixpay_call", { apiId: "api1", path: "../admin" })).rejects.toThrow(
      /Invalid path/,
    );
    await expect(
      handle("zentrixpay_call", { apiId: "api1", path: "/items/%2e%2e/admin" }),
    ).rejects.toThrow(/Invalid path/);
    await expect(
      handle("zentrixpay_call", { apiId: "api1", path: "items\\admin" }),
    ).rejects.toThrow(/Invalid path/);
    await expect(
      handle("zentrixpay_call", { apiId: "api1", path: "/items\0null" }),
    ).rejects.toThrow(/Invalid path/);
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
});

describe("zentrixpay_call safe response headers (#146)", () => {
  it("returns allowlisted pagination, retry and caching headers", async () => {
    const upstream = new Response("[]", {
      status: 200,
      headers: {
        "content-type": "application/json",
        link: '<https://api.test/items?page=2>; rel="next"',
        "x-total-count": "42",
        "retry-after": "30",
        etag: '"abc123"',
        "x-ratelimit-remaining": "99",
      },
    });
    const { handle } = setup({}, upstream);
    const out = JSON.parse(await handle("zentrixpay_call", { apiId: "api1" }));
    expect(out.headers).toEqual({
      link: '<https://api.test/items?page=2>; rel="next"',
      "x-total-count": "42",
      "retry-after": "30",
      etag: '"abc123"',
      "x-ratelimit-remaining": "99",
    });
  });

  it("excludes cookies, hop-by-hop and payment challenge headers", async () => {
    const upstream = new Response("ok", {
      status: 200,
      headers: {
        "set-cookie": "session=secret; HttpOnly",
        connection: "keep-alive, x-request-id",
        "keep-alive": "timeout=5",
        "x-request-id": "listed-in-connection",
        "payment-required": "challenge",
        "payment-response": '{"transaction":"tx1"}',
        "x-payment-response": '{"transaction":"tx1"}',
        "www-authenticate": "Payment",
        "x-upstream-secret": "nope",
        "cache-control": "no-store",
      },
    });
    const { handle } = setup({}, upstream);
    const out = JSON.parse(await handle("zentrixpay_call", { apiId: "api1" }));
    expect(out.headers).toEqual({ "cache-control": "no-store" });
    expect(out.txHash).toBe("tx1");
  });

  it("returns an empty object when no safe headers are present", async () => {
    const { handle } = setup();
    const out = JSON.parse(await handle("zentrixpay_call", { apiId: "api1" }));
    expect(out.headers).toEqual({});
  });
});

describe("zentrixpay_api_stats range and paging (#143)", () => {
  it("forwards from, to, limit and offset as query parameters", async () => {
    const jsonFetch = vi.fn(async () => ({ ok: true, status: 200, data: { calls: 0 } }));
    const { handle } = setup({ jsonFetch });
    await handle("zentrixpay_api_stats", {
      apiId: "api1",
      from: "2026-01-01",
      to: "2026-02-01",
      limit: 10,
      offset: 20,
    });
    expect(jsonFetch).toHaveBeenCalledWith(
      "http://gw.test/apis/api1/stats?from=2026-01-01&to=2026-02-01&limit=10&offset=20",
      { headers: { "x-api-key": "key" } },
    );
  });

  it("keeps the plain URL when no optional arguments are given", async () => {
    const jsonFetch = vi.fn(async () => ({ ok: true, status: 200, data: {} }));
    const { handle } = setup({ jsonFetch });
    await handle("zentrixpay_api_stats", { apiId: "api1" });
    expect(jsonFetch).toHaveBeenCalledWith("http://gw.test/apis/api1/stats", {
      headers: { "x-api-key": "key" },
    });
  });

  it("rejects invalid paging arguments before calling the server", async () => {
    const jsonFetch = vi.fn();
    const { handle } = setup({ jsonFetch });
    await expect(handle("zentrixpay_api_stats", { apiId: "api1", limit: -1 })).rejects.toThrow(
      /limit must be a non-negative integer/,
    );
    await expect(handle("zentrixpay_api_stats", { apiId: "api1", offset: "5" })).rejects.toThrow(
      /offset must be a non-negative integer/,
    );
    expect(jsonFetch).not.toHaveBeenCalled();
  });

  it("surfaces server-side validation errors", async () => {
    const jsonFetch = vi.fn(async () => ({
      ok: false,
      status: 400,
      data: { error: { from: ["from must not be after to"] } },
    }));
    const { handle } = setup({ jsonFetch });
    await expect(
      handle("zentrixpay_api_stats", { apiId: "api1", from: "2026-02-01", to: "2026-01-01" }),
    ).rejects.toThrow(/Invalid stats query/);
  });
});
