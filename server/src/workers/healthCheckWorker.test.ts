import { beforeEach, describe, expect, it, vi } from "vitest";

const sendUpstream = vi.fn();

vi.mock("../config.js", () => ({
  config: {
    UPSTREAM_SECRET_KEY: "test-key",
    HEALTH_CHECK_TIMEOUT_MS: 1000,
    PROXY_ALLOW_PRIVATE_UPSTREAMS: false,
  },
  upstreamKeyRing: [{ id: "k1", key: "00" }],
}));
vi.mock("../lib/logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../lib/upstreamClient.js", () => ({
  sendUpstream: (...args: unknown[]) => sendUpstream(...args),
}));
vi.mock("../utils/secretBox.js", () => ({ decryptSecret: (enc: string) => `plain:${enc}` }));
vi.mock("../services/apiService.js", () => ({
  healthCheckUrl: (api: { upstreamUrl: string }) => api.upstreamUrl,
  listApisForHealthCheck: vi.fn(),
  recordHealthCheck: vi.fn(),
}));

const { checkApiHealth } = await import("./healthCheckWorker.js");

const base = {
  id: 1,
  upstreamUrl: "https://upstream.example.com/status",
  upstreamHeaderName: null,
  upstreamHeaderValueEnc: null,
  upstreamQueryName: null,
  upstreamQueryValueEnc: null,
} as never;

describe("checkApiHealth secret injection", () => {
  beforeEach(() => {
    sendUpstream.mockReset();
    sendUpstream.mockResolvedValue({ status: 200 });
  });

  it("adds the secret query parameter so a query-authenticated healthy API stays listed", async () => {
    const api = { ...base, upstreamQueryName: "api_key", upstreamQueryValueEnc: "abc" };
    await expect(checkApiHealth(api)).resolves.toBe(true);
    const { url } = sendUpstream.mock.calls[0][0];
    expect(new URL(url).searchParams.get("api_key")).toBe("plain:abc");
  });

  it("keeps existing query parameters alongside the secret", async () => {
    const api = {
      ...base,
      upstreamUrl: "https://upstream.example.com/status?format=json",
      upstreamQueryName: "api_key",
      upstreamQueryValueEnc: "abc",
    };
    await checkApiHealth(api);
    const parsed = new URL(sendUpstream.mock.calls[0][0].url);
    expect(parsed.searchParams.get("format")).toBe("json");
    expect(parsed.searchParams.get("api_key")).toBe("plain:abc");
  });

  it("sends no query secret when none is configured", async () => {
    await checkApiHealth(base);
    expect(new URL(sendUpstream.mock.calls[0][0].url).search).toBe("");
  });

  it("treats an upstream error status as unhealthy", async () => {
    sendUpstream.mockResolvedValue({ status: 401 });
    const api = { ...base, upstreamQueryName: "api_key", upstreamQueryValueEnc: "abc" };
    await expect(checkApiHealth(api)).resolves.toBe(false);
  });
});
