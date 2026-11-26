import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { WebhookOutboxEntry } from "./webhookService.js";

// Durable recording of API-call rows (#134).
//
// A paid call has already succeeded by the time its row is written, so a
// failed insert must not silently drop it from usage stats. The recorder tries
// the database first; on failure it spools the row to an on-disk outbox and a
// background worker retries it later. Every row carries a stable id (the call
// id) and inserts use ON CONFLICT DO NOTHING, so a retry after a partial
// failure (row written, spool entry not yet removed) never creates a duplicate.
//
// Kept free of config and the shared DB client so it can be unit-tested.

export interface ApiCallRecord {
  /** Stable id for the call; doubles as the api_calls primary key. */
  callId: string;
  apiId: string;
  payerAddress: string;
  amount: string;
  charged: boolean;
  method: string;
  path: string;
  txHash?: string | null;
  responseStatus: number;
  durationMs: number;
  /** ISO-8601 time the call finished; kept so recovered rows keep their real time. */
  createdAt: string;
  /**
   * Webhook event for a charged call. Written to the webhook outbox in the same
   * transaction as the call row (#208), so both exist or neither does.
   */
  webhook?: WebhookOutboxEntry;
}

/** Writes one record. Must be idempotent on `callId`. */
export interface ApiCallRecordStore {
  insert(record: ApiCallRecord): Promise<void>;
}

/** Durable spool for records whose insert failed. */
export interface ApiCallRecordOutbox {
  put(entry: OutboxEntry): Promise<void>;
  list(): Promise<OutboxEntry[]>;
  remove(callId: string): Promise<void>;
}

export interface OutboxEntry {
  record: ApiCallRecord;
  attempts: number;
  lastError?: string;
  /** Epoch ms before which the entry is not retried. */
  nextAttemptAt: number;
}

export interface RecoveryResult {
  recovered: number;
  failed: number;
  pending: number;
}

interface Logger {
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

export interface ApiCallRecorderOptions {
  store: ApiCallRecordStore;
  outbox: ApiCallRecordOutbox;
  logger?: Logger;
  /** Called with the number of records awaiting recovery whenever it changes. */
  onPending?: (pending: number) => void;
  /** First retry delay; doubles per attempt up to maxDelayMs. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  now?: () => number;
}

export interface ApiCallRecorder {
  /** Insert the record, spooling it for recovery if the insert fails. Never throws for DB errors. */
  record(record: ApiCallRecord): Promise<"stored" | "spooled">;
  /** Retry spooled records that are due. Safe to run concurrently with record(). */
  recover(): Promise<RecoveryResult>;
  /** Records currently awaiting recovery. */
  pending(): Promise<number>;
}

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function createApiCallRecorder(opts: ApiCallRecorderOptions): ApiCallRecorder {
  const { store, outbox, logger } = opts;
  const baseDelayMs = opts.baseDelayMs ?? 1_000;
  const maxDelayMs = opts.maxDelayMs ?? 5 * 60_000;
  const now = opts.now ?? Date.now;
  let recovering = false;

  const backoff = (attempts: number) =>
    Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempts - 1));

  async function publishPending(): Promise<number> {
    const pending = (await outbox.list()).length;
    opts.onPending?.(pending);
    return pending;
  }

  return {
    async record(record) {
      try {
        await store.insert(record);
        return "stored";
      } catch (err) {
        // The spool is the durable fallback; if it also fails the error is
        // surfaced to the caller's logger.
        await outbox.put({
          record,
          attempts: 1,
          lastError: errorMessage(err),
          nextAttemptAt: now() + backoff(1),
        });
        logger?.warn(
          { event: "api_call_record_spooled", callId: record.callId, apiId: record.apiId, err },
          "API call record write failed; spooled for recovery",
        );
        await publishPending();
        return "spooled";
      }
    },

    async recover() {
      if (recovering) {
        return { recovered: 0, failed: 0, pending: (await outbox.list()).length };
      }
      recovering = true;
      let recovered = 0;
      let failed = 0;
      try {
        for (const entry of await outbox.list()) {
          if (entry.nextAttemptAt > now()) continue;
          try {
            await store.insert(entry.record);
            await outbox.remove(entry.record.callId);
            recovered++;
          } catch (err) {
            failed++;
            const attempts = entry.attempts + 1;
            await outbox.put({
              ...entry,
              attempts,
              lastError: errorMessage(err),
              nextAttemptAt: now() + backoff(attempts),
            });
            logger?.error(
              {
                event: "api_call_record_recovery_failed",
                callId: entry.record.callId,
                attempts,
                err,
              },
              "API call record recovery attempt failed",
            );
          }
        }
        return { recovered, failed, pending: await publishPending() };
      } finally {
        recovering = false;
      }
    },

    pending: publishPending,
  };
}

/**
 * One JSON file per spooled record, named after the call id. Writes go through
 * a temp file and rename so a crash never leaves a half-written entry, and
 * re-spooling the same call replaces its file instead of duplicating it.
 */
export class FileApiCallRecordOutbox implements ApiCallRecordOutbox {
  constructor(private readonly dir: string) {}

  private file(callId: string): string {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(callId)) throw new Error(`invalid call id: ${callId}`);
    return join(this.dir, `${callId}.json`);
  }

  async put(entry: OutboxEntry): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const target = this.file(entry.record.callId);
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(entry), { mode: 0o600 });
    await rename(tmp, target);
  }

  async list(): Promise<OutboxEntry[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const entries: OutboxEntry[] = [];
    for (const name of names.filter((n) => n.endsWith(".json")).sort()) {
      try {
        entries.push(JSON.parse(await readFile(join(this.dir, name), "utf8")) as OutboxEntry);
      } catch {
        // Removed concurrently, or unreadable: skip. An unreadable file stays
        // on disk for an operator to inspect.
      }
    }
    return entries;
  }

  async remove(callId: string): Promise<void> {
    try {
      await unlink(this.file(callId));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
}

/**
 * Idempotent insert into api_calls, plus the webhook outbox row when the call
 * carries a webhook event. One transaction: a retried call id or event id is a
 * no-op, and a webhook event is never recorded without its call row.
 */
export function postgresApiCallRecordStore(
  db: PostgresJsDatabase<Record<string, unknown>>,
): ApiCallRecordStore {
  return {
    async insert(r) {
      await db.transaction(async (tx) => {
        await tx.execute(sql`
          insert into api_calls
            (
              id, api_id, payer_address, amount, charged, method, path,
              response_status, duration_ms, tx_hash, created_at
            )
          values
            (
              ${r.callId}, ${r.apiId}, ${r.payerAddress}, ${r.amount}, ${r.charged},
              ${r.method}, ${r.path}, ${r.responseStatus}, ${r.durationMs},
              ${r.txHash ?? null}, ${r.createdAt}::timestamptz
            )
          on conflict (id) do nothing
        `);
        if (r.webhook) {
          const w = r.webhook;
          await tx.execute(sql`
            insert into webhook_deliveries
              (event_id, api_id, url, secret_enc, body, status, attempts, next_attempt_at, created_at)
            values
              (${w.eventId}, ${w.apiId}, ${w.url}, ${w.secretEnc}, ${w.body}, 'pending', 0,
               ${r.createdAt}::timestamptz, ${r.createdAt}::timestamptz)
            on conflict (event_id) do nothing
          `);
        }
      });
    },
  };
}
