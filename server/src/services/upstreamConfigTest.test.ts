import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({
  config: { PROXY_ALLOW_PRIVATE_UPSTREAMS: true, PROXY_DEFAULT_TIMEOUT_MS: 15_000 },
  upstreamKeyRing: [],
}));

import { streamUpstream, UpstreamError } from "../lib/upstreamClient.js";
import {
  testUpstreamConfig,
  upstreamTestUrl,
  UPSTREAM_TEST_MAX_TIMEOUT_MS,
  type UpstreamTestDeps,
} from "./upstreamConfigTest.js";

const HEADER_SECRET = "hdr-secret-value-123";
const QUERY_SECRET = "qry-secret-value-456";

type Api = Parameters<typeof testUpstreamConfig>[0];

function makeApi(overrides: Partial<Api> = {}): Api {
  return {
    id: 7,
    publisherId: "pub-1",
    name: "Weather",
    description: null,
    upstreamUrl: "http://127.0.0.1:1/v1",
    price: "0.01",
    priceRules: [],
    walletAddress: "G".padEnd(56, "A"),
    allowedMethods: ["GET"],
    payerAllowlist: null,
    payerDenylist: [],
    upstreamHeaderName: null,
    upstreamHeaderValueEnc: null,
    upstreamQueryName: null,
    upstreamQueryValueEnc: null,
    openapiSpec: null,
    timeoutMs: null,
    maxResponseBytes: null,
    webhookUrl: null,
    webhookSecretEnc: null,
    healthPath: null,
    healthy: true,
    healthFailures: 0,
    lastHealthCheckAt: null,
    ownershipToken: "tok",
    ownershipVerifiedAt: null,
    listed: false,
    tags: [],
    passPrice: null,
    freeCallsPerDay: 0,
    archivedAt: null,
    createdAt: new Date(),
    ...overrides,
  } as Api;
}

// Plaintext stands in for ciphertext: "enc:<value>" decrypts to <value>.
function deps(overrides: Partial<UpstreamTestDeps> = {}): UpstreamTestDeps {
  return {
    stream: streamUpstream,
    decrypt: (encoded) => {
      if (!encoded.startsWith("enc:")) throw new Error("bad ciphertext");
      return encoded.slice(4);
    },
    now: Date.now,
    allowPrivate: true,
    defaultTimeoutMs: 15_000,
    ...overrides,
  };
}

let server: http.Server | undefined;
let seen: http.IncomingMessage | undefined;

function startUpstream(handler: http.RequestListener): Promise<string> {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      seen = req;
      handler(req, res);
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server!.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

afterEach(async () => {
  seen = undefined;
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  }
});

describe("upstreamTestUrl", () => {
  it("uses the upstream URL when no health path is set", () => {
    expect(upstreamTestUrl({ upstreamUrl: "https://x.test/v1?a=1", healthPath: null }).href).toBe(
      "https://x.test/v1?a=1",
    );
  });

  it("appends the health path to the upstream base path", () => {
    expect(
      upstreamTestUrl({ upstreamUrl: "https://x.test/v1/", healthPath: "/health?deep=1" }).href,
    ).toBe("https://x.test/v1/health?deep=1");
  });
});

describe("testUpstreamConfig", () => {
  it("reports status, latency and content type using the saved secrets", async () => {
    const url = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "x-internal": "1" });
      res.end(JSON.stringify({ token: "upstream-private-data" }));
    });
    const result = await testUpstreamConfig(
      makeApi({
        upstreamUrl: `${url}/v1`,
        healthPath: "/health",
        upstreamHeaderName: "X-Api-Key",
        upstreamHeaderValueEnc: `enc:${HEADER_SECRET}`,
        upstreamQueryName: "api_key",
        upstreamQueryValueEnc: `enc:${QUERY_SECRET}`,
      }),
      deps(),
    );

    expect(seen?.method).toBe("GET");
    expect(seen?.url).toBe(`/v1/health?api_key=${QUERY_SECRET}`);
    expect(seen?.headers["x-api-key"]).toBe(HEADER_SECRET);

    expect(result).toMatchObject({
      ok: true,
      status: 200,
      contentType: "application/json",
      error: null,
      charged: false,
      request: { method: "GET", path: "/v1/health", usedHeaderSecret: true, usedQuerySecret: true },
    });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);

    // Nothing from the upstream response or the secrets leaks into the result.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(HEADER_SECRET);
    expect(serialized).not.toContain(QUERY_SECRET);
    expect(serialized).not.toContain("upstream-private-data");
    expect(serialized).not.toContain("x-internal");
  });

  it("flags rejected credentials without failing the request", async () => {
    const url = await startUpstream((_req, res) => {
      res.writeHead(401);
      res.end("bad key");
    });
    const result = await testUpstreamConfig(makeApi({ upstreamUrl: url }), deps());
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.error).toBeNull();
    expect(result.diagnosis).toMatch(/rejected/);
  });

  it("does not read a large response body", async () => {
    const url = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      // Keep streaming; the test must still finish as soon as headers arrive.
      const chunk = Buffer.alloc(64 * 1024);
      const timer = setInterval(() => res.write(chunk), 5);
      res.on("close", () => clearInterval(timer));
    });
    const result = await testUpstreamConfig(makeApi({ upstreamUrl: url }), deps());
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
  });

  it("caps the timeout and scrubs secrets from error messages", async () => {
    const stream = vi
      .fn()
      .mockRejectedValue(new UpstreamError("timeout", `no answer for ?api_key=${QUERY_SECRET}`));
    const result = await testUpstreamConfig(
      makeApi({
        timeoutMs: 60_000,
        upstreamQueryName: "api_key",
        upstreamQueryValueEnc: `enc:${QUERY_SECRET}`,
      }),
      deps({ stream }),
    );
    expect(stream.mock.calls[0][0].timeoutMs).toBe(UPSTREAM_TEST_MAX_TIMEOUT_MS);
    expect(result.ok).toBe(false);
    expect(result.status).toBeNull();
    expect(result.error?.kind).toBe("timeout");
    expect(result.error?.message).not.toContain(QUERY_SECRET);
    expect(result.error?.message).toContain("***");
  });

  it("scrubs URL-encoded secret forms echoed back in error messages", async () => {
    const tricky = "a+b/c=d&e f";
    const stream = vi
      .fn()
      .mockRejectedValue(
        new UpstreamError(
          "network",
          `connect failed for ?api_key=${encodeURIComponent(tricky)} and ${new URLSearchParams([["api_key", tricky]]).toString()}`,
        ),
      );
    const result = await testUpstreamConfig(
      makeApi({ upstreamQueryName: "api_key", upstreamQueryValueEnc: `enc:${tricky}` }),
      deps({ stream }),
    );
    expect(result.error?.message).not.toContain("a%2Bb");
    expect(result.error?.message).not.toContain("a+b");
    expect(result.error?.message).toContain("***");
    expect(JSON.stringify(result)).not.toContain("c%3Dd");
  });

  it("never returns the secret when the upstream echoes it in its response", async () => {
    // A hostile upstream reflects every header and the query string it received.
    const url = await startUpstream((req, res) => {
      res.writeHead(500, {
        "content-type": "text/plain",
        "x-echo": String(req.headers["x-api-key"]),
      });
      res.end(`bad request ${req.url} ${req.headers["x-api-key"]}`);
    });
    const result = await testUpstreamConfig(
      makeApi({
        upstreamUrl: url,
        upstreamHeaderName: "X-Api-Key",
        upstreamHeaderValueEnc: `enc:${HEADER_SECRET}`,
        upstreamQueryName: "api_key",
        upstreamQueryValueEnc: `enc:${QUERY_SECRET}`,
      }),
      deps(),
    );
    expect(result.status).toBe(500);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(HEADER_SECRET);
    expect(serialized).not.toContain(QUERY_SECRET);
    expect(serialized).not.toContain("bad request");
  });

  it("passes the private-upstream policy through to the client", async () => {
    const stream = vi.fn().mockRejectedValue(new UpstreamError("blocked", "not public"));
    const result = await testUpstreamConfig(makeApi(), deps({ stream, allowPrivate: false }));
    expect(stream.mock.calls[0][0].allowPrivate).toBe(false);
    expect(result.error?.kind).toBe("blocked");
  });

  it("reports a config error when a saved secret cannot be decrypted", async () => {
    const stream = vi.fn();
    const result = await testUpstreamConfig(
      makeApi({ upstreamHeaderName: "X-Api-Key", upstreamHeaderValueEnc: "corrupt" }),
      deps({ stream }),
    );
    expect(stream).not.toHaveBeenCalled();
    expect(result.error).toEqual({
      kind: "config",
      message: "saved upstream secret could not be decrypted",
    });
  });
});
