import { createHmac } from "node:crypto";
import { config, upstreamKeyRing } from "../config.js";
import { logger } from "../lib/logger.js";
import { sendUpstream } from "../lib/upstreamClient.js";
import { decryptSecret } from "../utils/secretBox.js";
import type { ApiRow } from "./apiService.js";

// Provider webhooks for charged calls (#36). After each call that settles, the
// provider's webhook URL receives a signed JSON event:
//
//   POST <webhookUrl>
//   X-ZentrixPay-Event: api.call.charged
//   X-ZentrixPay-Delivery: <event id, stable across retries>
//   X-ZentrixPay-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256>
//
// v1 is HMAC-SHA256(secret, `${t}.${rawBody}`). Receivers should recompute it,
// compare in constant time, and reject stale timestamps. A non-2xx answer or a
// network error is retried with exponential backoff.
//
// Durability (#208): the event is written to the webhook_deliveries outbox in
// the same transaction as its api_calls row (see apiCallRecorder), so it
// survives a restart. webhookDeliveryWorker claims due rows and delivers them;
// retries are scheduled in the database, not in memory.
//
// Delivery goes through sendUpstream, so the SSRF guard applies at connect
// time (DNS rebinding included), not only when the URL is registered.

export const WEBHOOK_EVENT_CHARGED = "api.call.charged";

export interface ChargedCallEvent {
  callId: string;
  payerAddress: string;
  amount: string;
  method: string;
  path: string;
  responseStatus: number;
  durationMs: number;
}

/** An outbox row's delivery inputs; the secret stays encrypted until delivery. */
export interface WebhookOutboxEntry {
  eventId: string;
  apiId: number;
  url: string;
  secretEnc: string;
  body: string;
}

export function signWebhookPayload(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export function webhookSignatureHeader(secret: string, timestamp: number, body: string): string {
  return `t=${timestamp},v1=${signWebhookPayload(secret, timestamp, body)}`;
}

/** Delay before retry `attempt` (1-based count of failed attempts so far). */
export function webhookRetryDelayMs(attempt: number): number {
  return config.WEBHOOK_RETRY_BASE_MS * 4 ** (attempt - 1);
}

/**
 * The outbox entry for a charged call, or undefined when the API has no
 * webhook configured or no encryption key is available to sign with.
 */
export function chargedCallWebhookEntry(
  api: ApiRow,
  call: ChargedCallEvent,
  now: Date = new Date(),
): WebhookOutboxEntry | undefined {
  if (!api.webhookUrl || !api.webhookSecretEnc) return undefined;
  if (upstreamKeyRing.length === 0) {
    logger.warn(
      { event: "webhook_skipped", apiId: api.id, reason: "no_secret_key" },
      "webhook configured but UPSTREAM_SECRET_KEY / UPSTREAM_SECRET_KEYS is missing",
    );
    return undefined;
  }
  const eventId = `evt_${call.callId}`;
  const body = JSON.stringify({
    id: eventId,
    type: WEBHOOK_EVENT_CHARGED,
    createdAt: now.toISOString(),
    data: { apiId: api.id, currency: "USDC", ...call },
  });
  return { eventId, apiId: api.id, url: api.webhookUrl, secretEnc: api.webhookSecretEnc, body };
}

/** One delivery attempt. Throws on a non-2xx answer or a network error. */
export async function attemptWebhookDelivery(entry: WebhookOutboxEntry): Promise<void> {
  const secret = decryptSecret(entry.secretEnc, upstreamKeyRing, config.UPSTREAM_SECRET_KEY);
  const timestamp = Math.floor(Date.now() / 1000);
  const res = await sendUpstream({
    url: new URL(entry.url),
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "ZentrixPay-Webhooks/1",
      "x-zentrixpay-event": WEBHOOK_EVENT_CHARGED,
      "x-zentrixpay-delivery": entry.eventId,
      "x-zentrixpay-signature": webhookSignatureHeader(secret, timestamp, entry.body),
    },
    body: Buffer.from(entry.body, "utf8"),
    timeoutMs: config.WEBHOOK_TIMEOUT_MS,
    maxResponseBytes: 64 * 1024,
    allowPrivate: config.PROXY_ALLOW_PRIVATE_UPSTREAMS,
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`webhook answered HTTP ${res.status}`);
  }
}
