import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({
  config: {
    UPSTREAM_SECRET_KEY: "",
    PROXY_ALLOW_PRIVATE_UPSTREAMS: true,
    WEBHOOK_TIMEOUT_MS: 2_000,
    WEBHOOK_MAX_ATTEMPTS: 2,
    WEBHOOK_RETRY_BASE_MS: 1,
  },
  upstreamKeyRing: [{ id: "k1", key: "00" }],
}));
vi.mock("../utils/secretBox.js", () => ({
  encryptSecret: (plain: string) => `enc:${plain}`,
  decryptSecret: (enc: string) => enc.slice(4),
}));
vi.mock("../db/client.js", () => ({ db: {} }));
vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import type { ApiRow } from "./apiService.js";
import {
  listWebhookDeliveries,
  redeliverWebhook,
  resetWebhookDeliveryLog,
  sendWebhookTest,
  verifyWebhookSignature,
  webhookUnavailableReason,
} from "./webhookService.js";

const SECRET = "whsec_delivery_test";
let server: http.Server | undefined;
let received: Array<{ headers: http.IncomingHttpHeaders; body: string }> = [];
let respondWith = 200;

function startReceiver(): Promise<string> {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push({ headers: req.headers, body });
        res.writeHead(respondWith);
        res.end();
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server!.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}/hook`);
    });
  });
}

function api(overrides: Partial<ApiRow> = {}): ApiRow {
  return {
    id: 9,
    webhookUrl: null,
    webhookSecretEnc: `enc:${SECRET}`,
    webhookPreviousSecretEnc: null,
    webhookPreviousSecretExpiresAt: null,
    ...overrides,
  } as ApiRow;
}

beforeEach(() => {
  resetWebhookDeliveryLog();
  received = [];
  respondWith = 200;
});

afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  }
});

describe("webhook delivery log, test ping and redelivery (#209)", () => {
  it("reports a missing URL or secret as unavailable", () => {
    expect(webhookUnavailableReason(api())).toMatch(/Set a webhook URL/);
    expect(webhookUnavailableReason(api({ webhookUrl: "https://x.test" }))).toBeNull();
  });

  it("sends a signed webhook.test ping and logs it as delivered", async () => {
    const url = await startReceiver();
    const { done } = sendWebhookTest(api({ webhookUrl: url }));
    await done;

    expect(received).toHaveLength(1);
    const header = received[0].headers["x-zentrixpay-signature"] as string;
    expect(verifyWebhookSignature(SECRET, header, received[0].body)).toEqual({ ok: true });
    expect(JSON.parse(received[0].body).type).toBe("webhook.test");

    const [entry] = listWebhookDeliveries(9);
    expect(entry).toMatchObject({
      eventType: "webhook.test",
      status: "delivered",
      attempts: 1,
      lastError: null,
    });
    // The signing secret and request body are not part of the owner's view.
    expect(JSON.stringify(entry)).not.toContain(SECRET);
    expect(JSON.stringify(entry)).not.toContain("body");
  });

  it("records a failed ping with the error after its single attempt", async () => {
    respondWith = 500;
    const url = await startReceiver();
    const { done } = sendWebhookTest(api({ webhookUrl: url }));
    await done;

    expect(received).toHaveLength(1);
    expect(listWebhookDeliveries(9)[0]).toMatchObject({
      status: "failed",
      attempts: 1,
      lastError: "webhook answered HTTP 500",
    });
  });

  it("redelivers a logged event with the same event id and body and a fresh signature", async () => {
    respondWith = 500;
    const url = await startReceiver();
    const first = sendWebhookTest(api({ webhookUrl: url }));
    await first.done;
    const original = listWebhookDeliveries(9)[0];

    respondWith = 200;
    const again = redeliverWebhook(api({ webhookUrl: url }), original.deliveryId);
    expect(again).not.toBeNull();
    await again!.done;

    expect(received).toHaveLength(2);
    expect(received[1].body).toBe(received[0].body);
    expect(received[1].headers["x-zentrixpay-delivery"]).toBe(
      received[0].headers["x-zentrixpay-delivery"],
    );
    expect(
      verifyWebhookSignature(
        SECRET,
        received[1].headers["x-zentrixpay-signature"] as string,
        received[1].body,
      ),
    ).toEqual({ ok: true });

    const [latest, previous] = listWebhookDeliveries(9);
    expect(latest).toMatchObject({
      status: "delivered",
      redeliveryOf: original.deliveryId,
      eventId: original.eventId,
    });
    expect(previous.status).toBe("failed");
  });

  it("returns null when redelivering a delivery that is not in the log", () => {
    expect(redeliverWebhook(api({ webhookUrl: "https://x.test" }), "dlv_missing")).toBeNull();
  });
});
