import { describe, it, expect, vi } from "vitest";
import {
  API_TOOL_DEFINITIONS,
  EXCLUDED_RESPONSE_HEADERS,
  SAFE_RESPONSE_HEADERS,
  createApiToolHandler,
  extractSafeResponseHeaders,
  type ApiToolDeps,
} from "./apiTools.js";
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

  it("returns allowlisted pagination, rate-limit, retry, and caching headers while stripping sensitive headers (#146)", async () => {
    const upstream = new Response('{"items":[1,2]}', {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": "30",
        "X-RateLimit-Limit": "100",
        "X-RateLimit-Remaining": "99",
        "X-RateLimit-Reset": "1700000000",
        "RateLimit-Policy": "100;w=60",
        "X-Total-Count": "42",
        "X-Page": "2",
        "X-Per-Page": "20",
        "X-Next-Page": "3",
        Link: '<https://api.example.com/items?page=3>; rel="next"',
        ETag: '"v1-abc"',
        "Cache-Control": "max-age=60",
        "X-Request-Id": "req-123",
        // Excluded: cookies
        "Set-Cookie": "session=secret; HttpOnly",
        Cookie: "caller_cookie=1",
        // Excluded: hop-by-hop headers
        Connection: "keep-alive, x-custom-hop",
        "Keep-Alive": "timeout=5",
        "Transfer-Encoding": "chunked",
        Upgrade: "websocket",
        "Proxy-Authenticate": "Basic",
        "Proxy-Authorization": "Basic secret",
        // Excluded: payment challenge / settlement / auth headers
        "Payment-Required": "x402-challenge",
        "Payment-Response": JSON.stringify({ transaction: "tx-abc" }),
        "X-Payment-Response": JSON.stringify({ transaction: "tx-abc" }),
        "X-Payment-Required": "challenge",
        "WWW-Authenticate": "Bearer realm=internal",
        Authorization: "Bearer upstream-token",
        "X-Api-Key": "internal-key",
        // Excluded: unallowlisted internal headers
        Server: "internal-nginx",
        "X-Powered-By": "Express",
        "X-Internal-Secret": "top-secret",
      },
    });
    const { handle } = setup({}, upstream);
    const out = JSON.parse(await handle("zentrixpay_call", { apiId: "api1" }));

    expect(out.txHash).toBe("tx-abc");
    expect(out.headers).toEqual({
      "cache-control": "max-age=60",
      "content-type": "application/json",
      etag: '"v1-abc"',
      link: '<https://api.example.com/items?page=3>; rel="next"',
      "ratelimit-policy": "100;w=60",
      "retry-after": "30",
      "x-next-page": "3",
      "x-page": "2",
      "x-per-page": "20",
      "x-ratelimit-limit": "100",
      "x-ratelimit-remaining": "99",
      "x-ratelimit-reset": "1700000000",
      "x-request-id": "req-123",
      "x-total-count": "42",
    });

    // Ensure excluded headers never leak
    for (const forbidden of [
      "set-cookie",
      "cookie",
      "connection",
      "keep-alive",
      "transfer-encoding",
      "upgrade",
      "proxy-authenticate",
      "proxy-authorization",
      "payment-required",
      "payment-response",
      "x-payment-response",
      "x-payment-required",
      "www-authenticate",
      "authorization",
      "x-api-key",
      "server",
      "x-powered-by",
      "x-internal-secret",
    ]) {
      expect(out.headers[forbidden]).toBeUndefined();
    }
  });

  it("excludes headers dynamically listed in the Connection hop-by-hop header (#146)", () => {
    const raw = new Headers({
      Connection: "close, x-request-id, retry-after",
      "X-Request-Id": "hop-scoped-id",
      "Retry-After": "10",
      "X-Total-Count": "5",
    });
    expect(extractSafeResponseHeaders(raw)).toEqual({
      "x-total-count": "5",
    });
  });

  it("keeps SAFE_RESPONSE_HEADERS and EXCLUDED_RESPONSE_HEADERS disjoint (#146)", () => {
    for (const h of SAFE_RESPONSE_HEADERS) {
      expect(EXCLUDED_RESPONSE_HEADERS.has(h)).toBe(false);
    }
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
