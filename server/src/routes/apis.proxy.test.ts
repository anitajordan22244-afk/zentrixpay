import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import request from "supertest";

const { state } = vi.hoisted(() => ({
  state: { api: null as any, recorded: [] as any[] },
}));

vi.mock("../config.js", () => ({
  config: {
    BASE_URL: "http://gateway.test",
    NETWORK: "stellar:testnet",
    UPSTREAM_SECRET_KEY: "11".repeat(32),
    PROXY_MAX_REQUEST_BODY: "1mb",
    PROXY_MAX_RESPONSE_BYTES: 1024,
    PROXY_DEFAULT_TIMEOUT_MS: 500,
    PROXY_MAX_TIMEOUT_MS: 1000,
    PROXY_ALLOW_PRIVATE_UPSTREAMS: true,
  },
  upstreamKeyRing: [{ id: "default", hex: "11".repeat(32) }],
}));
vi.mock("../db/client.js", () => ({ db: {} }));
vi.mock("../middleware/rateLimiters.js", () => ({
  publishIpRateLimit: (_q: unknown, _s: unknown, n: () => void) => n(),
  publishWalletRateLimit: (_q: unknown, _s: unknown, n: () => void) => n(),
}));
// The real x402 paywall needs a facilitator; here every call counts as paid.
vi.mock("../middleware/apiPaywall.js", async () => {
  const actual = await vi.importActual<typeof import("../middleware/apiPaywall.js")>(
    "../middleware/apiPaywall.js",
  );
  return {
    ...actual,
    apiPaywall: (_q: unknown, _s: unknown, n: () => void) => n(),
    loadProxiedApi: (req: express.Request, res: express.Response, next: express.NextFunction) => {
      const id = req.params.id;
      if (!id || state.api?.id !== id || !state.api?.listed) {
        return res.status(404).json({ error: "API not found" });
      }
      const method = req.method.toUpperCase();
      const allowed = (state.api.allowedMethods ?? ["GET", "POST"]).map((m: string) =>
        m.toUpperCase(),
      );
      if (!allowed.includes(method)) {
        res.setHeader("Allow", allowed.join(", "));
        return res.status(405).json({ error: "Method not allowed" });
      }
      res.locals.api = state.api;
      return next();
    },
  };
});
vi.mock("../services/apiService.js", () => ({
  ApiServiceError: class ApiServiceError extends Error {
    constructor(
      public readonly status: number,
      message: string,
    ) {
      super(message);
    }
  },
  getApiById: async (id: string) => (state.api?.id === id ? state.api : null),
  recordApiCall: async (call: unknown) => {
    state.recorded.push(call);
  },
  archiveApi: vi.fn(),
  createApi: vi.fn(),
  createApiPass: vi.fn(),
  effectiveMaxResponseBytes: (api: any) => Math.min(api?.maxResponseBytes ?? 1024, 1024),
  getActivePass: vi.fn(),
  getApiStats: vi.fn(),
  getApiTimeSeries: vi.fn(),
  getOwnedApi: vi.fn(),
  listPublicApis: vi.fn(),
  listPayerCalls: vi.fn(),
  listPublisherApis: vi.fn(),
  listRecentCalls: vi.fn(),
  toOwnerApi: vi.fn(),
  toPublicApi: vi.fn(),
  toPublicOpenApi: vi.fn(),
  updateApi: vi.fn(),
  verifyOwnership: vi.fn(),
}));

import router, {
  buildUpstreamUrl,
  rewriteOrSuppressRedirect,
  rewriteResponseHeader,
} from "./apis.js";
import { isPublicAddress, validateUpstreamUrl } from "../lib/upstreamGuard.js";
import { sendUpstream } from "../lib/upstreamClient.js";
import { encryptSecret, decryptSecret } from "../utils/secretBox.js";

describe("upstream guard", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "169.254.169.254",
    "192.168.0.1",
    "::1",
    "fd00::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
  ])("blocks %s", (ip) => expect(isPublicAddress(ip)).toBe(false));

  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])("allows %s", (ip) =>
    expect(isPublicAddress(ip)).toBe(true),
  );

  it("rejects private, credentialed and non-http upstream URLs", () => {
    const strict = { allowPrivate: false };
    expect(() => validateUpstreamUrl("http://localhost:3000", strict)).toThrow(/public/);
    expect(() => validateUpstreamUrl("http://[::1]/x", strict)).toThrow(/public/);
    expect(() => validateUpstreamUrl("https://u:p@api.example.com", strict)).toThrow(/credentials/);
    expect(() => validateUpstreamUrl("ftp://api.example.com", strict)).toThrow(/http/);
    expect(validateUpstreamUrl("https://api.example.com/v1", strict).hostname).toBe(
      "api.example.com",
    );
  });

  it("refuses to connect when a hostname resolves to a private address", async () => {
    await expect(
      sendUpstream({
        url: new URL("http://localhost:9/"),
        method: "GET",
        headers: {},
        timeoutMs: 1000,
        maxResponseBytes: 1024,
        allowPrivate: false,
      }),
    ).rejects.toMatchObject({ kind: "blocked" });
  });
});

describe("buildUpstreamUrl", () => {
  it("joins base path, sub path and both query strings", () => {
    const url = buildUpstreamUrl(
      "https://api.example.com/v1/?key=a",
      ["weather", "lagos city"],
      "/api/x/weather/lagos%20city?units=c",
    );
    expect(url?.toString()).toBe("https://api.example.com/v1/weather/lagos%20city?key=a&units=c");
  });

  it("refuses traversal and smuggled separators", () => {
    expect(buildUpstreamUrl("https://api.example.com/v1", [".."], "/api/x/..")).toBeNull();
    expect(buildUpstreamUrl("https://api.example.com/v1", ["."], "/api/x/.")).toBeNull();
    expect(buildUpstreamUrl("https://api.example.com/v1", ["%2e%2e"], "/api/x/%2e%2e")).toBeNull();
    expect(buildUpstreamUrl("https://api.example.com/v1", ["%2E%2E"], "/api/x/%2E%2E")).toBeNull();
    expect(
      buildUpstreamUrl("https://api.example.com/v1", ["%252e%252e"], "/api/x/%252e%252e"),
    ).toBeNull();
    expect(buildUpstreamUrl("https://api.example.com/v1", ["a/b"], "/api/x/a%2Fb")).toBeNull();
    expect(buildUpstreamUrl("https://api.example.com/v1", ["a\\b"], "/api/x/a%5Cb")).toBeNull();
    expect(buildUpstreamUrl("https://api.example.com/v1", ["a\0b"], "/api/x/a%00b")).toBeNull();
    expect(
      buildUpstreamUrl("https://api.example.com/v1", ["items", ".."], "/api/x/items/.."),
    ).toBeNull();
  });
});

describe("secretBox", () => {
  it("round-trips and detects tampering", () => {
    const key = "22".repeat(32);
    const enc = encryptSecret("sk_live_123", key);
    expect(enc).not.toContain("sk_live_123");
    expect(decryptSecret(enc, key)).toBe("sk_live_123");
    const parts = enc.split(":");
    parts[3] = Buffer.from("tampered").toString("base64");
    expect(() => decryptSecret(parts.join(":"), key)).toThrow();
  });
});

describe("rewriteOrSuppressRedirect (#131)", () => {
  const api = { id: "api1", upstreamUrl: "http://127.0.0.1:8080/v1" };

  it("rewrites absolute redirects that point to the upstream origin within boundary", () => {
    expect(rewriteOrSuppressRedirect("http://127.0.0.1:8080/v1/items/42?page=2#heading", api)).toBe(
      "http://gateway.test/api/api1/items/42?page=2#heading",
    );
  });

  it("rewrites relative redirects that resolve within upstream base path", () => {
    expect(rewriteOrSuppressRedirect("/v1/items/42", api)).toBe(
      "http://gateway.test/api/api1/items/42",
    );
    expect(rewriteOrSuppressRedirect("items/42", api)).toBe(
      "http://gateway.test/api/api1/items/42",
    );
  });

  it("suppresses redirects that point to the upstream origin outside boundary", () => {
    expect(rewriteOrSuppressRedirect("http://127.0.0.1:8080/admin/secrets", api)).toBeNull();
    expect(rewriteOrSuppressRedirect("http://127.0.0.1:8080/v2/items", api)).toBeNull();
    expect(rewriteOrSuppressRedirect("http://127.0.0.1:8080/", api)).toBeNull();
    expect(rewriteOrSuppressRedirect("/admin/secrets", api)).toBeNull();
  });

  it("preserves redirects to unrelated external destinations", () => {
    expect(
      rewriteOrSuppressRedirect("https://auth.provider.com/oauth/authorize?client_id=xyz", api),
    ).toBe("https://auth.provider.com/oauth/authorize?client_id=xyz");
  });

  it("handles upstream URLs with no path prefix", () => {
    const rootApi = { id: "api2", upstreamUrl: "http://api.example.com" };
    expect(rewriteOrSuppressRedirect("http://api.example.com/items", rootApi)).toBe(
      "http://gateway.test/api/api2/items",
    );
    expect(rewriteOrSuppressRedirect("https://other.com/login", rootApi)).toBe(
      "https://other.com/login",
    );
  });
});

describe("rewriteResponseHeader (#131)", () => {
  const api = {
    id: "api1",
    upstreamUrl: "http://127.0.0.1:8080/v1",
  } as any;
  const secrets = {
    queryName: "apiKey",
    values: ["sk_live_secret123"],
  };

  it("rewrites location header within upstream boundary", () => {
    expect(
      rewriteResponseHeader(
        "location",
        "http://127.0.0.1:8080/v1/next?apiKey=sk_live_secret123&page=2",
        api,
        secrets,
      ),
    ).toBe("http://gateway.test/api/api1/next?page=2");
  });

  it("suppresses location header pointing to upstream origin outside boundary", () => {
    expect(
      rewriteResponseHeader(
        "location",
        "http://127.0.0.1:8080/admin/leak?apiKey=sk_live_secret123",
        api,
        secrets,
      ),
    ).toBeNull();
  });

  it("preserves external location headers while stripping secrets", () => {
    expect(
      rewriteResponseHeader(
        "location",
        "https://auth.external.com/login?apiKey=sk_live_secret123&client=42",
        api,
        secrets,
      ),
    ).toBe("https://auth.external.com/login?client=42");
  });

  it("redacts secret values from other response headers", () => {
    expect(
      rewriteResponseHeader(
        "link",
        '<https://external.com/data?key=sk_live_secret123>; rel="next"',
        api,
        secrets,
      ),
    ).toBe('<https://external.com/data?key=[redacted]>; rel="next"');
  });
});

describe("proxy route", () => {
  let upstream: http.Server;
  let upstreamPort: number;
  let seen: { url?: string; headers?: http.IncomingHttpHeaders; body?: string };
  const app = express();
  app.disable("x-powered-by");
  app.use(router);

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen = { url: req.url, headers: req.headers, body };
        if (req.url?.startsWith("/v1/big")) return res.end("x".repeat(4096));
        if (req.url?.startsWith("/v1/slow")) return setTimeout(() => res.end("late"), 2000);
        if (req.url?.startsWith("/v1/fail")) return res.writeHead(500).end("boom");
        if (req.url?.startsWith("/v1/redirect-internal")) {
          res.writeHead(302, { location: `http://127.0.0.1:${upstreamPort}/v1/items/99` });
          return res.end();
        }
        if (req.url?.startsWith("/v1/redirect-leak")) {
          res.writeHead(302, { location: `http://127.0.0.1:${upstreamPort}/admin/secret` });
          return res.end();
        }
        if (req.url?.startsWith("/v1/redirect-external")) {
          res.writeHead(302, { location: "https://auth.provider.example.com/login?client=123" });
          return res.end();
        }
        res.writeHead(200, {
          "content-type": "application/json",
          "set-cookie": "a=b",
          server: "provider-stack",
          "x-powered-by": "provider-framework",
          via: "provider-proxy",
          "x-aspnet-version": "8.0",
        });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
    const { port } = upstream.address() as AddressInfo;
    upstreamPort = port;
    state.api = {
      id: "api1",
      listed: true,
      price: "0.01",
      walletAddress: "G".padEnd(56, "A"),
      allowedMethods: ["GET", "POST"],
      upstreamUrl: `http://127.0.0.1:${port}/v1`,
      upstreamHeaderName: "x-provider-key",
      upstreamHeaderValueEnc: encryptSecret("provider-secret", "11".repeat(32)),
      timeoutMs: null,
    };
  });

  afterAll(() => new Promise<void>((r) => upstream.close(() => r())));

  it("forwards method, path, query and body, injects the secret, strips caller headers", async () => {
    const res = await request(app)
      .post("/api/api1/items/42?expand=1")
      .set("content-type", "application/json")
      .set("x-tenant-key", "tenant-123")
      .set("x-payment", "abc")
      .set("cookie", "session=1")
      .send('{"a":1}');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(res.headers["set-cookie"]).toBeUndefined();
    expect(res.headers.server).toBeUndefined();
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers.via).toBeUndefined();
    expect(res.headers["x-aspnet-version"]).toBeUndefined();
    expect(seen.url).toBe("/v1/items/42?expand=1");
    expect(seen.body).toBe('{"a":1}');
    expect(seen.headers?.["x-provider-key"]).toBe("provider-secret");
    expect(seen.headers?.["x-tenant-key"]).toBe("tenant-123");
    expect(seen.headers?.["x-payment"]).toBeUndefined();
    expect(seen.headers?.cookie).toBeUndefined();
    expect(state.recorded.at(-1)).toMatchObject({
      apiId: "api1",
      charged: true,
      path: "/items/42",
      method: "POST",
    });
  });

  it("rejects methods the provider does not allow before any payment", async () => {
    const res = await request(app).delete("/api/api1/items/1");
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe("GET, POST");
  });

  it("returns 404 for unknown APIs", async () => {
    expect((await request(app).get("/api/nope")).status).toBe(404);
  });

  it("passes upstream errors through as uncharged calls", async () => {
    const res = await request(app).get("/api/api1/fail");
    expect(res.status).toBe(500);
    expect(state.recorded.at(-1)).toMatchObject({ charged: false, responseStatus: 500 });
  });

  it("rejects path traversal and smuggled separators with 400 without forwarding or charging (#130)", async () => {
    const recordedBefore = state.recorded.length;
    seen = {};

    const res1 = await request(app).get("/api/api1/..%2fadmin");
    expect(res1.status).toBe(400);
    expect(res1.body).toMatchObject({ error: "Invalid path", code: "invalid_path" });

    const res2 = await request(app).get("/api/api1/%2e%2e");
    expect(res2.status).toBe(400);
    expect(res2.body).toMatchObject({ error: "Invalid path", code: "invalid_path" });

    // Upstream server was never called
    expect(seen.url).toBeUndefined();
    // No call was charged or recorded
    expect(state.recorded.length).toBe(recordedBefore);
  });

  it("maps oversize and slow upstream responses to 502/504", async () => {
    expect((await request(app).get("/api/api1/big")).status).toBe(502);
    expect((await request(app).get("/api/api1/slow")).status).toBe(504);
  });

  it("rewrites redirects that point within the configured upstream origin (#131)", async () => {
    const res = await request(app).get("/api/api1/redirect-internal").redirects(0);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("http://gateway.test/api/api1/items/99");
  });

  it("suppresses redirects that point to the upstream origin outside boundary to avoid leaking private origin details (#131)", async () => {
    const res = await request(app).get("/api/api1/redirect-leak").redirects(0);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBeUndefined();
  });

  it("preserves redirects to unrelated external destinations (#131)", async () => {
    const res = await request(app).get("/api/api1/redirect-external").redirects(0);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("https://auth.provider.example.com/login?client=123");
  });
});
