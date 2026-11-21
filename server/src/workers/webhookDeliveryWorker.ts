import { eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { config, upstreamKeyRing } from "../config.js";
import { db as defaultDb } from "../db/client.js";
import { webhookDeliveries } from "../db/schema.js";
import type * as schema from "../db/schema.js";
import { logger } from "../lib/logger.js";
import {
  attemptWebhookDelivery,
  webhookRetryDelayMs,
  type WebhookOutboxEntry,
} from "../services/webhookService.js";

// Delivers charged-call webhooks from the webhook_deliveries outbox (#208).
//
// Each tick claims due rows with FOR UPDATE SKIP LOCKED and pushes their lease
// forward in the same statement, so replicas never deliver the same row at the
// same time. A claimed row whose instance dies mid-attempt becomes due again
// when its lease runs out. A failed attempt reschedules the row with exponential
// backoff; after WEBHOOK_MAX_ATTEMPTS it is marked failed. Pending rows live in
// Postgres, so a restart or deploy loses nothing.

type Db = PostgresJsDatabase<typeof schema>;

export interface WebhookDeliveryRun {
  delivered: number;
  retried: number;
  failed: number;
}

interface ClaimedRow {
  id: number;
  event_id: string;
  api_id: number;
  url: string;
  secret_enc: string;
  body: string;
  attempts: number;
}

export interface WebhookDeliveryOptions {
  batchSize?: number;
  maxAttempts?: number;
  leaseMs?: number;
  now?: () => Date;
  /** Delivers one entry; defaults to a signed POST through the SSRF-guarded client. */
  deliver?: (entry: WebhookOutboxEntry) => Promise<void>;
}

/** Claim due rows and attempt each one. Returns counts for this run. */
export async function runWebhookDeliveries(
  database: Db = defaultDb as unknown as Db,
  opts: WebhookDeliveryOptions = {},
): Promise<WebhookDeliveryRun> {
  const run: WebhookDeliveryRun = { delivered: 0, retried: 0, failed: 0 };
  if (upstreamKeyRing.length === 0) return run;

  const batchSize = opts.batchSize ?? 20;
  const maxAttempts = opts.maxAttempts ?? config.WEBHOOK_MAX_ATTEMPTS;
  const leaseMs = opts.leaseMs ?? config.WEBHOOK_TIMEOUT_MS * 2 + 30_000;
  const now = opts.now ?? (() => new Date());
  const deliver = opts.deliver ?? attemptWebhookDelivery;

  const claimed = (await database.execute(sql`
    update webhook_deliveries
       set next_attempt_at = ${new Date(now().getTime() + leaseMs).toISOString()}::timestamptz
     where id in (
       select id from webhook_deliveries
        where status = 'pending' and next_attempt_at <= ${now().toISOString()}::timestamptz
        order by next_attempt_at
        limit ${batchSize}
        for update skip locked
     )
    returning id, event_id, api_id, url, secret_enc, body, attempts
  `)) as unknown as ClaimedRow[];

  for (const row of claimed) {
    const entry: WebhookOutboxEntry = {
      eventId: row.event_id,
      apiId: row.api_id,
      url: row.url,
      secretEnc: row.secret_enc,
      body: row.body,
    };
    const attempt = row.attempts + 1;
    try {
      await deliver(entry);
      await database
        .update(webhookDeliveries)
        .set({ status: "delivered", attempts: attempt, deliveredAt: now(), lastError: null })
        .where(eq(webhookDeliveries.id, row.id));
      run.delivered++;
      logger.info(
        { event: "webhook_delivered", apiId: row.api_id, eventId: row.event_id, attempt },
        "webhook delivered",
      );
    } catch (err) {
      const error = (err as Error).message;
      if (attempt >= maxAttempts) {
        await database
          .update(webhookDeliveries)
          .set({ status: "failed", attempts: attempt, lastError: error })
          .where(eq(webhookDeliveries.id, row.id));
        run.failed++;
        logger.error(
          {
            event: "webhook_failed",
            apiId: row.api_id,
            eventId: row.event_id,
            attempts: attempt,
            error,
          },
          "webhook delivery failed; giving up",
        );
      } else {
        const delayMs = webhookRetryDelayMs(attempt);
        await database
          .update(webhookDeliveries)
          .set({
            attempts: attempt,
            lastError: error,
            nextAttemptAt: new Date(now().getTime() + delayMs),
          })
          .where(eq(webhookDeliveries.id, row.id));
        run.retried++;
        logger.warn(
          {
            event: "webhook_retry",
            apiId: row.api_id,
            eventId: row.event_id,
            attempt,
            delayMs,
            error,
          },
          "webhook delivery failed; retrying",
        );
      }
    }
  }
  return run;
}

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let running = false;

export function startWebhookDeliveryWorker(): void {
  if (config.WEBHOOK_DELIVERY_INTERVAL_MS <= 0) return;
  logger.info(
    { event: "webhook_worker_start", intervalMs: config.WEBHOOK_DELIVERY_INTERVAL_MS },
    "starting webhook delivery worker",
  );
  void tick();
  intervalHandle = setInterval(() => void tick(), config.WEBHOOK_DELIVERY_INTERVAL_MS);
  intervalHandle.unref?.();
}

export function stopWebhookDeliveryWorker(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await runWebhookDeliveries();
  } catch (err) {
    logger.error({ event: "webhook_worker_tick_error", err }, "webhook delivery tick failed");
  } finally {
    running = false;
  }
}
