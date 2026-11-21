import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockLimit, mockList, mockTest, mockRedeliver, mockReason } = vi.hoisted(() => ({
  mockLimit: vi.fn(),
  mockList: vi.fn(),
  mockTest: vi.fn(),
  mockRedeliver: vi.fn(),
  mockReason: vi.fn(),
}));

vi.mock("../db/client.js", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: mockLimit }) }) }),
  },
}));
vi.mock("../config.js", () => ({ config: { REQUIRE_REQUEST_SIGNATURE: false } }));
vi.mock("../lib/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../middleware/apiKeyAuth.js", () => ({
  apiKeyAuth: (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const key = req.headers["x-api-key"];
    if (!key) {
      res.status(401).json({ error: "Missing x-api-key header" });
      return;
    }
    req.publisher = { id: String(key) } as express.Request["publisher"];
    next();
  },
}));
vi.mock("../middleware/requestSignatureAuth.js", () => ({
  requestSignatureAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../services/webhookService.js", () => ({
  listWebhookDeliveries: mockList,
  sendWebhookTest: mockTest,
  redeliverWebhook: mockRedeliver,
  webhookUnavailableReason: mockReason,
  rotateWebhookSecret: vi.fn(),
  expireWebhookPreviousSecret: vi.fn(),
  WEBHOOK_ROTATION_GRACE_MS: 86_400_000,
}));

import router from "./webhooks.js";

const API = { id: 9, publisherId: "pub-1", webhookUrl: "https://x.test/hook" };
const VIEW = {
  deliveryId: "dlv_1",
  eventId: "evt_test_1",
  eventType: "webhook.test",
  status: "delivered",
  attempts: 1,
  lastError: null,
  redeliveryOf: null,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
};

function app() {
  const a = express();
  a.use(express.json());
  a.use(router);
  return a;
}

describe("webhook delivery routes (#209)", () => {
  beforeEach(() => {
    mockLimit.mockReset();
    mockList.mockReset().mockReturnValue([VIEW]);
    mockTest.mockReset();
    mockRedeliver.mockReset();
    mockReason.mockReset().mockReturnValue(null);
  });

  it("requires an API key on every endpoint", async () => {
    expect((await request(app()).get("/apis/9/webhooks/deliveries")).status).toBe(401);
    expect((await request(app()).post("/apis/9/webhooks/test")).status).toBe(401);
    expect((await request(app()).post("/apis/9/webhooks/deliveries/dlv_1/redeliver")).status).toBe(
      401,
    );
  });

  it("lists deliveries for the owner only; another publisher gets 404", async () => {
    mockLimit.mockResolvedValueOnce([API]);
    const ok = await request(app()).get("/apis/9/webhooks/deliveries").set("x-api-key", "pub-1");
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ apiId: 9, deliveries: [VIEW] });

    mockLimit.mockResolvedValueOnce([]);
    const other = await request(app()).get("/apis/9/webhooks/deliveries").set("x-api-key", "pub-2");
    expect(other.status).toBe(404);
    expect(mockList).toHaveBeenCalledTimes(1);
  });

  it("sends a test ping for the owner and returns its result", async () => {
    mockLimit.mockResolvedValue([API]);
    mockTest.mockReturnValue({ delivery: VIEW, done: Promise.resolve() });
    const res = await request(app()).post("/apis/9/webhooks/test").set("x-api-key", "pub-1");
    expect(res.status).toBe(200);
    expect(res.body.apiId).toBe(9);
  });

  it("refuses a test ping when webhooks are not configured", async () => {
    mockLimit.mockResolvedValue([API]);
    mockReason.mockReturnValue("Set a webhook URL and secret first");
    const res = await request(app()).post("/apis/9/webhooks/test").set("x-api-key", "pub-1");
    expect(res.status).toBe(409);
    expect(mockTest).not.toHaveBeenCalled();
  });

  it("redelivers a logged delivery and answers 202; unknown ids get 404", async () => {
    mockLimit.mockResolvedValue([API]);
    mockRedeliver.mockReturnValue({
      delivery: { ...VIEW, status: "pending" },
      done: Promise.resolve(),
    });
    const ok = await request(app())
      .post("/apis/9/webhooks/deliveries/dlv_1/redeliver")
      .set("x-api-key", "pub-1");
    expect(ok.status).toBe(202);
    expect(mockRedeliver).toHaveBeenCalledWith(API, "dlv_1");

    mockLimit.mockResolvedValue([API]);
    mockRedeliver.mockReturnValue(null);
    const missing = await request(app())
      .post("/apis/9/webhooks/deliveries/dlv_nope/redeliver")
      .set("x-api-key", "pub-1");
    expect(missing.status).toBe(404);
  });

  it("does not let another publisher redeliver", async () => {
    mockLimit.mockResolvedValue([]);
    const res = await request(app())
      .post("/apis/9/webhooks/deliveries/dlv_1/redeliver")
      .set("x-api-key", "pub-2");
    expect(res.status).toBe(404);
    expect(mockRedeliver).not.toHaveBeenCalled();
  });
});
