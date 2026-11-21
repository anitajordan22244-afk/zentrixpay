import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    HEALTH_CHECK_TIMEOUT_MS: 1000,
    PROXY_ALLOW_PRIVATE_UPSTREAMS: false,
    UPSTREAM_SECRET_KEY: undefined,
  },
}));
vi.mock("../lib/upstreamClient.js", () => ({ sendUpstream: vi.fn() }));
vi.mock("../lib/logger.js", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { sendUpstream } from "../lib/upstreamClient.js";
import { checkApiHealth } from "./healthCheckWorker.js";

const api = {
  id: 1,
  upstreamUrl: "https://provider.example.test/base",
  healthPath: "/health",
  upstreamHeaderName: null,
  upstreamHeaderValueEnc: null,
} as any;

describe("upstream health checks: hide after failures, relist on recovery", () => {
  beforeEach(() => {
    vi.mocked(sendUpstream).mockReset();
  });

  it("reports healthy when the upstream answers 2xx", async () => {
    vi.mocked(sendUpstream).mockResolvedValue({ status: 200 } as any);
    await expect(checkApiHealth(api)).resolves.toBe(true);
    expect(sendUpstream).toHaveBeenCalledWith(expect.objectContaining({ method: "GET" }));
  });

  it("reports unhealthy on a 5xx response so failures can be counted", async () => {
    vi.mocked(sendUpstream).mockResolvedValue({ status: 503 } as any);
    await expect(checkApiHealth(api)).resolves.toBe(false);
  });

  it("reports unhealthy when the upstream is unreachable", async () => {
    vi.mocked(sendUpstream).mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(checkApiHealth(api)).resolves.toBe(false);
  });
});
