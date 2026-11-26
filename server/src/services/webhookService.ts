import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config, upstreamKeyRing } from "../config.js";
import { logger } from "../lib/logger.js";
import { sendUpstream } from "../lib/upstreamClient.js";
import { db } from "../db/client.js";
import { apis } from "../db/schema.js";
import { decryptSecret, encryptSecret } from "../utils/secretBox.js";
import { eq } from "drizzle-orm";
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
  apiId: string;
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

// ── Rotation, verification, test pings and the delivery log (#209-#212) ──────
// Charged-call events are delivered through the durable outbox above
// (chargedCallWebhookEntry + attemptWebhookDelivery). The functions below
// serve owner-initiated test pings and redeliveries.

/** How long a rotated-out secret keeps signing after a rotation (issue #211). */
export const WEBHOOK_ROTATION_GRACE_MS = 24 * 60 * 60 * 1000;

/** One header with a v1 per active secret: the current one, plus the previous one during rotation. */
export function webhookSignatureHeaderForSecrets(
  secrets: string[],
  timestamp: number,
  body: string,
): string {
  const v1 = secrets.map((secret) => signWebhookPayload(secret, timestamp, body));
  return [`t=${timestamp}`, ...v1.map((sig) => `v1=${sig}`)].join(",");
}

/**
 * Secrets that may sign a delivery at `now`: the current secret, and the
 * previous one while its grace period has not expired (issue #211).
 */
export function activeWebhookSecrets(
  api: Pick<
    ApiRow,
    "webhookSecretEnc" | "webhookPreviousSecretEnc" | "webhookPreviousSecretExpiresAt"
  >,
  now: number = Date.now(),
): string[] {
  const secrets: string[] = [];
  if (api.webhookSecretEnc) {
    secrets.push(decryptSecret(api.webhookSecretEnc, upstreamKeyRing, config.UPSTREAM_SECRET_KEY));
  }
  const expiresAt = api.webhookPreviousSecretExpiresAt;
  if (api.webhookPreviousSecretEnc && expiresAt && new Date(expiresAt).getTime() > now) {
    secrets.push(
      decryptSecret(api.webhookPreviousSecretEnc, upstreamKeyRing, config.UPSTREAM_SECRET_KEY),
    );
  }
  return secrets;
}

/**
 * Issue a new signing secret. The old current secret becomes the previous
 * one and keeps signing for WEBHOOK_ROTATION_GRACE_MS. Returns the new
 * plaintext secret; it is shown once and never stored in clear.
 */
export async function rotateWebhookSecret(api: ApiRow, now: number = Date.now()): Promise<string> {
  if (!api.webhookUrl) throw new Error("API has no webhook URL");
  const secret = `whsec_${randomBytes(24).toString("hex")}`;
  const previousEnc = api.webhookSecretEnc;
  await db
    .update(apis)
    .set({
      webhookSecretEnc: encryptSecret(secret, upstreamKeyRing),
      webhookPreviousSecretEnc: previousEnc,
      webhookPreviousSecretExpiresAt: previousEnc
        ? new Date(now + WEBHOOK_ROTATION_GRACE_MS)
        : null,
    })
    .where(eq(apis.id, api.id));
  return secret;
}

/** End the grace period now: only the current secret signs from here on. */
export async function expireWebhookPreviousSecret(api: ApiRow): Promise<void> {
  await db
    .update(apis)
    .set({ webhookPreviousSecretEnc: null, webhookPreviousSecretExpiresAt: null })
    .where(eq(apis.id, api.id));
}

/** Default replay window for receivers: a signed timestamp older than this is rejected. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

export type WebhookVerifyResult =
  | { ok: true }
  | { ok: false; reason: "missing_header" | "malformed" | "stale" | "mismatch" };

/**
 * Receiver-side check of an `X-ZentrixPay-Signature` header. Recomputes v1 over
 * `${t}.${body}`, compares in constant time, and rejects timestamps outside
 * the tolerance window (in either direction) to stop replays. Accepts several
 * v1 values so a receiver still verifies during secret rotation.
 */
export function verifyWebhookSignature(
  secret: string,
  header: string | undefined,
  body: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
  toleranceSeconds: number = WEBHOOK_TOLERANCE_SECONDS,
): WebhookVerifyResult {
  if (!header) return { ok: false, reason: "missing_header" };
  let timestamp: number | undefined;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const [key, value] = part.trim().split("=", 2);
    if (key === "t" && /^\d+$/.test(value ?? "")) timestamp = Number(value);
    else if (key === "v1" && /^[0-9a-f]+$/.test(value ?? "")) signatures.push(value);
  }
  if (timestamp === undefined || signatures.length === 0) {
    return { ok: false, reason: "malformed" };
  }
  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) {
    return { ok: false, reason: "stale" };
  }
  const expected = Buffer.from(signWebhookPayload(secret, timestamp, body), "hex");
  const matched = signatures.some((hex) => {
    const given = Buffer.from(hex, "hex");
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  return matched ? { ok: true } : { ok: false, reason: "mismatch" };
}

async function attemptDelivery(url: string, secrets: string[], eventId: string, body: string) {
  const timestamp = Math.floor(Date.now() / 1000);
  const res = await sendUpstream({
    url: new URL(url),
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "ZentrixPay-Webhooks/1",
      "x-zentrixpay-event": WEBHOOK_EVENT_CHARGED,
      "x-zentrixpay-delivery": eventId,
      "x-zentrixpay-signature": webhookSignatureHeaderForSecrets(secrets, timestamp, body),
    },
    body: Buffer.from(body, "utf8"),
    timeoutMs: config.WEBHOOK_TIMEOUT_MS,
    maxResponseBytes: 64 * 1024,
    allowPrivate: config.PROXY_ALLOW_PRIVATE_UPSTREAMS,
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`webhook answered HTTP ${res.status}`);
  }
}

export const WEBHOOK_EVENT_TEST = "webhook.test";
/** Deliveries kept per API for the owner's delivery log (issue #209). */
export const WEBHOOK_LOG_LIMIT = 100;

export type WebhookDeliveryStatus = "pending" | "delivered" | "failed";

/** What the owner sees about a delivery. The request body stays server-side. */
export interface WebhookDeliveryView {
  deliveryId: string;
  eventId: string;
  eventType: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  lastError: string | null;
  /** Set on a redelivery: the deliveryId it re-sent. */
  redeliveryOf: string | null;
  createdAt: string;
  updatedAt: string;
}

interface StoredDelivery extends WebhookDeliveryView {
  body: string;
}

// In memory, like the deliveries themselves (see the header comment).
const deliveryLog = new Map<string, StoredDelivery[]>();

function toView({ body: _body, ...view }: StoredDelivery): WebhookDeliveryView {
  return view;
}

/** Why an API cannot send webhooks right now, or null when it can. */
export function webhookUnavailableReason(api: ApiRow): string | null {
  if (!api.webhookUrl || !api.webhookSecretEnc) return "Set a webhook URL and secret first";
  if (upstreamKeyRing.length === 0) return "The server has no secret key for webhooks";
  return null;
}

/** The owner's recent deliveries for an API, newest first. */
export function listWebhookDeliveries(apiId: string): WebhookDeliveryView[] {
  return (deliveryLog.get(apiId) ?? []).map(toView);
}

function storeDelivery(apiId: string, delivery: StoredDelivery): void {
  const list = deliveryLog.get(apiId) ?? [];
  list.unshift(delivery);
  if (list.length > WEBHOOK_LOG_LIMIT) list.length = WEBHOOK_LOG_LIMIT;
  deliveryLog.set(apiId, list);
}

/**
 * Send one event now and log it. Retries follow `maxAttempts`. The returned
 * `done` settles when the last attempt has finished.
 */
function dispatchWebhook(
  api: ApiRow,
  event: { eventId: string; eventType: string; body: string },
  options: { maxAttempts: number; redeliveryOf?: string | null },
): { delivery: WebhookDeliveryView; done: Promise<void> } {
  const log = logger;
  const url = api.webhookUrl!;
  const now = new Date().toISOString();
  const stored: StoredDelivery = {
    deliveryId: `dlv_${randomBytes(8).toString("hex")}`,
    eventId: event.eventId,
    eventType: event.eventType,
    status: "pending",
    attempts: 0,
    lastError: null,
    redeliveryOf: options.redeliveryOf ?? null,
    createdAt: now,
    updatedAt: now,
    body: event.body,
  };
  storeDelivery(api.id, stored);

  const attempt = async (n: number): Promise<void> => {
    stored.attempts = n;
    stored.updatedAt = new Date().toISOString();
    try {
      // Read the secrets per attempt, so a rotation applies to pending retries.
      await attemptDelivery(url, activeWebhookSecrets(api), event.eventId, event.body);
      stored.status = "delivered";
      stored.lastError = null;
      log.info(
        { event: "webhook_delivered", apiId: api.id, eventId: event.eventId, attempt: n },
        "webhook delivered",
      );
    } catch (err) {
      const error = (err as Error).message;
      stored.lastError = error;
      if (n >= options.maxAttempts) {
        stored.status = "failed";
        log.error(
          { event: "webhook_failed", apiId: api.id, eventId: event.eventId, attempts: n, error },
          "webhook delivery failed; giving up",
        );
        return;
      }
      stored.status = "pending";
      const delayMs = webhookRetryDelayMs(n);
      log.warn(
        {
          event: "webhook_retry",
          apiId: api.id,
          eventId: event.eventId,
          attempt: n,
          delayMs,
          error,
        },
        "webhook delivery failed; retrying",
      );
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs).unref());
      return attempt(n + 1);
    }
  };
  const done = attempt(1);
  return { delivery: toView(stored), done };
}

/** Signed `webhook.test` ping: one attempt, no retries, so the owner sees the result at once. */
export function sendWebhookTest(api: ApiRow): {
  delivery: WebhookDeliveryView;
  done: Promise<void>;
} {
  const eventId = `evt_test_${randomBytes(8).toString("hex")}`;
  const body = JSON.stringify({
    id: eventId,
    type: WEBHOOK_EVENT_TEST,
    createdAt: new Date().toISOString(),
    data: { apiId: api.id, test: true },
  });
  return dispatchWebhook(api, { eventId, eventType: WEBHOOK_EVENT_TEST, body }, { maxAttempts: 1 });
}

/**
 * Re-send a logged delivery with the same event id and body (receivers dedupe
 * on it) and a fresh signature. Returns null when the delivery is not in the log.
 */
export function redeliverWebhook(
  api: ApiRow,
  deliveryId: string,
): { delivery: WebhookDeliveryView; done: Promise<void> } | null {
  const original = (deliveryLog.get(api.id) ?? []).find((d) => d.deliveryId === deliveryId);
  if (!original) return null;
  return dispatchWebhook(
    api,
    { eventId: original.eventId, eventType: original.eventType, body: original.body },
    { maxAttempts: config.WEBHOOK_MAX_ATTEMPTS, redeliveryOf: original.deliveryId },
  );
}

/** Test helper: clear the in-memory delivery log. */
export function resetWebhookDeliveryLog(): void {
  deliveryLog.clear();
}
