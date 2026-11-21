import { Router, type Request, type Response } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { apis } from "../db/schema.js";
import { apiKeyAuth } from "../middleware/apiKeyAuth.js";
import { requestSignatureAuth } from "../middleware/requestSignatureAuth.js";
import {
  expireWebhookPreviousSecret,
  listWebhookDeliveries,
  redeliverWebhook,
  rotateWebhookSecret,
  sendWebhookTest,
  webhookUnavailableReason,
  WEBHOOK_ROTATION_GRACE_MS,
} from "../services/webhookService.js";

const router = Router();

async function loadOwnedApi(id: string, publisherId: string) {
  const numericId = Number(id);
  if (!Number.isInteger(numericId) || numericId <= 0) return null;
  const [row] = await db
    .select()
    .from(apis)
    .where(and(eq(apis.id, numericId), eq(apis.publisherId, publisherId), isNull(apis.archivedAt)))
    .limit(1);
  return row ?? null;
}

// POST /apis/:id/webhook/secret/rotate — issue a new webhook signing secret (owner, #211).
// The previous secret keeps signing for a grace period. The new secret is returned once.
router.post(
  "/apis/:id/webhook/secret/rotate",
  apiKeyAuth,
  requestSignatureAuth,
  async (req: Request, res: Response) => {
    const api = await loadOwnedApi(req.params.id as string, req.publisher!.id);
    if (!api) {
      res.status(404).json({ error: "API not found" });
      return;
    }
    if (!api.webhookUrl) {
      res.status(409).json({ error: "Set a webhook URL before rotating its secret" });
      return;
    }
    const secret = await rotateWebhookSecret(api);
    res.setHeader("Cache-Control", "no-store");
    res.json({ apiId: api.id, secret, previousSecretExpiresInMs: WEBHOOK_ROTATION_GRACE_MS });
  },
);

// POST /apis/:id/webhook/secret/expire — end the previous secret's grace period now (owner, #211).
router.post(
  "/apis/:id/webhook/secret/expire",
  apiKeyAuth,
  requestSignatureAuth,
  async (req: Request, res: Response) => {
    const api = await loadOwnedApi(req.params.id as string, req.publisher!.id);
    if (!api) {
      res.status(404).json({ error: "API not found" });
      return;
    }
    await expireWebhookPreviousSecret(api);
    res.json({ apiId: api.id, previousSecretExpired: true });
  },
);

// GET /apis/:id/webhooks/deliveries — the owner's recent webhook deliveries with status,
// attempts and last error (issue #209). Owner-only: other publishers get a 404.
router.get(
  "/apis/:id/webhooks/deliveries",
  apiKeyAuth,
  requestSignatureAuth,
  async (req: Request, res: Response) => {
    const api = await loadOwnedApi(req.params.id as string, req.publisher!.id);
    if (!api) {
      res.status(404).json({ error: "API not found" });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.json({ apiId: api.id, deliveries: listWebhookDeliveries(api.id) });
  },
);

// POST /apis/:id/webhooks/test — send one signed `webhook.test` ping and report the result (#209).
router.post(
  "/apis/:id/webhooks/test",
  apiKeyAuth,
  requestSignatureAuth,
  async (req: Request, res: Response) => {
    const api = await loadOwnedApi(req.params.id as string, req.publisher!.id);
    if (!api) {
      res.status(404).json({ error: "API not found" });
      return;
    }
    const reason = webhookUnavailableReason(api);
    if (reason) {
      res.status(409).json({ error: reason });
      return;
    }
    const { delivery, done } = sendWebhookTest(api);
    await done;
    res.setHeader("Cache-Control", "no-store");
    res.json({
      apiId: api.id,
      delivery: listWebhookDeliveries(api.id).find((d) => d.deliveryId === delivery.deliveryId),
    });
  },
);

// POST /apis/:id/webhooks/deliveries/:deliveryId/redeliver — re-send a logged event with the same
// event id and body and a fresh signature (#209). Answers 202; the attempt runs in the background.
router.post(
  "/apis/:id/webhooks/deliveries/:deliveryId/redeliver",
  apiKeyAuth,
  requestSignatureAuth,
  async (req: Request, res: Response) => {
    const api = await loadOwnedApi(req.params.id as string, req.publisher!.id);
    if (!api) {
      res.status(404).json({ error: "API not found" });
      return;
    }
    const reason = webhookUnavailableReason(api);
    if (reason) {
      res.status(409).json({ error: reason });
      return;
    }
    const started = redeliverWebhook(api, req.params.deliveryId as string);
    if (!started) {
      res.status(404).json({ error: "Delivery not found" });
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    res.status(202).json({ apiId: api.id, delivery: started.delivery });
  },
);

export default router;
