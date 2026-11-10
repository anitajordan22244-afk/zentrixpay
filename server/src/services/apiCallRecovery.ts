import fs from "node:fs";
import path from "node:path";
import { createId } from "@paralleldrive/cuid2";
import { db } from "../db/client.js";
import { apiCalls } from "../db/schema.js";
import { getLogger } from "../lib/logger.js";
import { apiCallRecoveryPending, apiCallRecoveryTotal } from "../lib/metrics.js";

export interface RecordCallInput {
  id?: string;
  callId?: string;
  apiId: string;
  payerAddress: string;
  amount: string;
  charged: boolean;
  method: string;
  path: string;
  responseStatus: number;
  durationMs: number;
  txHash?: string | null;
  createdAt?: Date;
}

export interface RecoverableApiCallRecord {
  id: string;
  apiId: string;
  payerAddress: string;
  amount: string;
  charged: boolean;
  method: string;
  path: string;
  responseStatus: number;
  durationMs: number;
  txHash: string | null;
  createdAt: Date;
}

export interface PendingApiCallRecoveryEntry {
  record: RecoverableApiCallRecord;
  attempts: number;
  firstFailedAt: string;
  lastFailedAt: string;
  nextRetryAt: string;
  lastError: string;
}

export interface ApiCallRecoveryStatus {
  pendingCount: number;
  oldestPendingAt: string | null;
  totalQueued: number;
  totalRecovered: number;
  totalFailed: number;
  totalDeduplicated: number;
  pending: PendingApiCallRecoveryEntry[];
}

export type ApiCallRecordWriter = (record: RecoverableApiCallRecord) => Promise<void>;

export interface ApiCallRecoveryOptions {
  writer?: ApiCallRecordWriter;
  spoolFilePath?: string | null;
  retryBaseDelayMs?: number;
  maxRetryDelayMs?: number;
  maxQueueSize?: number;
  autoSchedule?: boolean;
}

const DEFAULT_RETRY_BASE_DELAY_MS = 5_000;
const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;
const DEFAULT_MAX_QUEUE_SIZE = 10_000;
const MAX_COMMITTED_ID_HISTORY = 10_000;

async function defaultDatabaseWriter(record: RecoverableApiCallRecord): Promise<void> {
  const query = db.insert(apiCalls).values({
    id: record.id,
    apiId: record.apiId,
    payerAddress: record.payerAddress,
    amount: record.amount,
    charged: record.charged,
    method: record.method,
    path: record.path,
    responseStatus: record.responseStatus,
    durationMs: record.durationMs,
    txHash: record.txHash,
    createdAt: record.createdAt,
  });

  if (
    query &&
    typeof (query as { onConflictDoNothing?: unknown }).onConflictDoNothing === "function"
  ) {
    await (
      query as unknown as {
        onConflictDoNothing: (opts: { target: typeof apiCalls.id }) => Promise<unknown>;
      }
    ).onConflictDoNothing({ target: apiCalls.id });
    return;
  }

  await query;
}

let activeWriter: ApiCallRecordWriter = defaultDatabaseWriter;
let spoolFilePath: string | null = process.env.API_CALL_RECOVERY_SPOOL_PATH ?? null;
let retryBaseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS;
let maxRetryDelayMs = DEFAULT_MAX_RETRY_DELAY_MS;
let maxQueueSize = DEFAULT_MAX_QUEUE_SIZE;
let autoSchedule = true;

const pendingQueue = new Map<string, PendingApiCallRecoveryEntry>();
const committedIds = new Set<string>();
let totalQueued = 0;
let totalRecovered = 0;
let totalFailed = 0;
let totalDeduplicated = 0;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let recoveryInFlight: Promise<{
  recovered: number;
  failed: number;
  pendingCount: number;
}> | null = null;

function rememberCommittedId(id: string): void {
  if (committedIds.has(id)) {
    committedIds.delete(id);
  }
  committedIds.add(id);
  if (committedIds.size > MAX_COMMITTED_ID_HISTORY) {
    const oldest = committedIds.values().next().value;
    if (oldest !== undefined) {
      committedIds.delete(oldest);
    }
  }
}

export function normalizeApiCallRecord(input: RecordCallInput): RecoverableApiCallRecord {
  const id = (input.id ?? input.callId ?? "").trim() || createId();
  return {
    id,
    apiId: input.apiId,
    payerAddress: input.payerAddress,
    amount: input.amount,
    charged: input.charged,
    method: input.method,
    path: input.path,
    responseStatus: input.responseStatus,
    durationMs: input.durationMs,
    txHash: input.txHash ?? null,
    createdAt: input.createdAt instanceof Date ? input.createdAt : new Date(),
  };
}

function syncPendingGauge(): void {
  apiCallRecoveryPending.set(pendingQueue.size);
}

function persistSpoolToDisk(): void {
  if (!spoolFilePath) return;
  try {
    const dir = path.dirname(spoolFilePath);
    fs.mkdirSync(dir, { recursive: true });
    const serialized = JSON.stringify(
      Array.from(pendingQueue.values()).map((entry) => ({
        ...entry,
        record: {
          ...entry.record,
          createdAt: entry.record.createdAt.toISOString(),
        },
      })),
      null,
      2,
    );
    const tmpPath = `${spoolFilePath}.tmp.${process.pid}`;
    fs.writeFileSync(tmpPath, serialized, "utf8");
    fs.renameSync(tmpPath, spoolFilePath);
  } catch (err) {
    getLogger().error(
      { event: "api_call_recovery_spool_write_failed", spoolFilePath, err },
      "failed to persist API call recovery spool to disk",
    );
  }
}

export function loadPendingApiCallsFromSpool(customPath?: string): number {
  const targetPath = customPath ?? spoolFilePath;
  if (!targetPath || !fs.existsSync(targetPath)) {
    return 0;
  }

  try {
    const raw = fs.readFileSync(targetPath, "utf8").trim();
    if (!raw) return 0;
    const parsed = JSON.parse(raw) as Array<{
      record: Omit<RecoverableApiCallRecord, "createdAt"> & { createdAt: string };
      attempts: number;
      firstFailedAt: string;
      lastFailedAt: string;
      nextRetryAt: string;
      lastError: string;
    }>;

    let loaded = 0;
    for (const item of parsed) {
      if (!item?.record?.id) continue;
      if (committedIds.has(item.record.id) || pendingQueue.has(item.record.id)) {
        continue;
      }
      pendingQueue.set(item.record.id, {
        ...item,
        record: {
          ...item.record,
          createdAt: new Date(item.record.createdAt),
        },
      });
      loaded++;
    }
    syncPendingGauge();
    if (loaded > 0) {
      scheduleRecoveryTimer();
    }
    return loaded;
  } catch (err) {
    getLogger().error(
      { event: "api_call_recovery_spool_read_failed", spoolFilePath: targetPath, err },
      "failed to load API call recovery spool from disk",
    );
    return 0;
  }
}

function computeNextRetryDelayMs(attempts: number): number {
  const factor = Math.pow(2, Math.max(0, attempts - 1));
  return Math.min(retryBaseDelayMs * factor, maxRetryDelayMs);
}

function scheduleRecoveryTimer(): void {
  if (!autoSchedule || retryTimer || pendingQueue.size === 0) {
    return;
  }

  let delayMs = retryBaseDelayMs;
  const now = Date.now();
  for (const entry of pendingQueue.values()) {
    const waitMs = Math.max(0, new Date(entry.nextRetryAt).getTime() - now);
    if (waitMs < delayMs) {
      delayMs = waitMs;
    }
  }

  retryTimer = setTimeout(
    () => {
      retryTimer = null;
      void recoverPendingApiCalls();
    },
    Math.max(10, delayMs),
  );
  retryTimer.unref?.();
}

export function enqueueFailedApiCall(
  record: RecoverableApiCallRecord,
  error: unknown,
  now = new Date(),
): PendingApiCallRecoveryEntry | null {
  if (committedIds.has(record.id)) {
    totalDeduplicated++;
    apiCallRecoveryTotal.inc({ outcome: "deduplicated" });
    return null;
  }

  const errorMessage = error instanceof Error ? error.message : String(error);
  const existing = pendingQueue.get(record.id);
  const nowIso = now.toISOString();

  if (existing) {
    existing.attempts += 1;
    existing.lastFailedAt = nowIso;
    existing.lastError = errorMessage;
    existing.nextRetryAt = new Date(
      now.getTime() + computeNextRetryDelayMs(existing.attempts),
    ).toISOString();
    persistSpoolToDisk();
    scheduleRecoveryTimer();
    return existing;
  }

  if (pendingQueue.size >= maxQueueSize) {
    const oldestKey = pendingQueue.keys().next().value;
    if (oldestKey !== undefined) {
      pendingQueue.delete(oldestKey);
    }
  }

  const entry: PendingApiCallRecoveryEntry = {
    record,
    attempts: 1,
    firstFailedAt: nowIso,
    lastFailedAt: nowIso,
    nextRetryAt: new Date(now.getTime() + computeNextRetryDelayMs(1)).toISOString(),
    lastError: errorMessage,
  };

  pendingQueue.set(record.id, entry);
  totalQueued++;
  apiCallRecoveryTotal.inc({ outcome: "queued" });
  syncPendingGauge();
  persistSpoolToDisk();

  getLogger().error(
    {
      event: "api_call_record_queued_for_recovery",
      callId: record.id,
      apiId: record.apiId,
      charged: record.charged,
      pendingCount: pendingQueue.size,
      err: error,
    },
    "failed to write API call record to database; queued for idempotent recovery",
  );

  scheduleRecoveryTimer();
  return entry;
}

export async function recordApiCallWithRecovery(
  input: RecordCallInput,
): Promise<{ status: "recorded" | "queued" | "deduplicated"; id: string }> {
  const record = normalizeApiCallRecord(input);

  if (committedIds.has(record.id)) {
    totalDeduplicated++;
    apiCallRecoveryTotal.inc({ outcome: "deduplicated" });
    return { status: "deduplicated", id: record.id };
  }

  try {
    await activeWriter(record);
    rememberCommittedId(record.id);
    if (pendingQueue.delete(record.id)) {
      syncPendingGauge();
      persistSpoolToDisk();
    }
    return { status: "recorded", id: record.id };
  } catch (err) {
    enqueueFailedApiCall(record, err);
    return { status: "queued", id: record.id };
  }
}

export async function recoverPendingApiCalls(
  options: { force?: boolean; now?: Date } = {},
): Promise<{ recovered: number; failed: number; pendingCount: number }> {
  if (recoveryInFlight) {
    return recoveryInFlight;
  }

  const force = options.force ?? true;
  const now = options.now ?? new Date();

  recoveryInFlight = (async () => {
    let recovered = 0;
    let failed = 0;

    for (const [id, entry] of Array.from(pendingQueue.entries())) {
      if (committedIds.has(id)) {
        pendingQueue.delete(id);
        totalDeduplicated++;
        apiCallRecoveryTotal.inc({ outcome: "deduplicated" });
        continue;
      }

      if (!force && new Date(entry.nextRetryAt).getTime() > now.getTime()) {
        continue;
      }

      try {
        await activeWriter(entry.record);
        rememberCommittedId(id);
        pendingQueue.delete(id);
        recovered++;
        totalRecovered++;
        apiCallRecoveryTotal.inc({ outcome: "recovered" });

        getLogger().info(
          {
            event: "api_call_record_recovered",
            callId: id,
            apiId: entry.record.apiId,
            charged: entry.record.charged,
            attempts: entry.attempts,
            pendingCount: pendingQueue.size,
          },
          "recovered API call record after database write failure",
        );
      } catch (err) {
        failed++;
        totalFailed++;
        apiCallRecoveryTotal.inc({ outcome: "failed" });
        entry.attempts += 1;
        entry.lastFailedAt = now.toISOString();
        entry.lastError = err instanceof Error ? err.message : String(err);
        entry.nextRetryAt = new Date(
          now.getTime() + computeNextRetryDelayMs(entry.attempts),
        ).toISOString();

        getLogger().error(
          {
            event: "api_call_record_recovery_failed",
            callId: id,
            apiId: entry.record.apiId,
            charged: entry.record.charged,
            attempts: entry.attempts,
            pendingCount: pendingQueue.size,
            err,
          },
          "retry failed while recovering API call record",
        );
      }
    }

    syncPendingGauge();
    persistSpoolToDisk();

    if (pendingQueue.size > 0) {
      scheduleRecoveryTimer();
    }

    return {
      recovered,
      failed,
      pendingCount: pendingQueue.size,
    };
  })();

  try {
    return await recoveryInFlight;
  } finally {
    recoveryInFlight = null;
  }
}

export function getApiCallRecoveryStatus(): ApiCallRecoveryStatus {
  const pending = Array.from(pendingQueue.values()).map((entry) => ({
    ...entry,
    record: { ...entry.record },
  }));

  return {
    pendingCount: pending.length,
    oldestPendingAt: pending.length > 0 ? pending[0].firstFailedAt : null,
    totalQueued,
    totalRecovered,
    totalFailed,
    totalDeduplicated,
    pending,
  };
}

export function configureApiCallRecovery(options: ApiCallRecoveryOptions): void {
  if (options.writer !== undefined) {
    activeWriter = options.writer;
  }
  if (options.spoolFilePath !== undefined) {
    spoolFilePath = options.spoolFilePath;
  }
  if (options.retryBaseDelayMs !== undefined) {
    retryBaseDelayMs = options.retryBaseDelayMs;
  }
  if (options.maxRetryDelayMs !== undefined) {
    maxRetryDelayMs = options.maxRetryDelayMs;
  }
  if (options.maxQueueSize !== undefined) {
    maxQueueSize = options.maxQueueSize;
  }
  if (options.autoSchedule !== undefined) {
    autoSchedule = options.autoSchedule;
  }
}

export function resetApiCallRecoveryForTests(): void {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  pendingQueue.clear();
  committedIds.clear();
  totalQueued = 0;
  totalRecovered = 0;
  totalFailed = 0;
  totalDeduplicated = 0;
  activeWriter = defaultDatabaseWriter;
  spoolFilePath = null;
  retryBaseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS;
  maxRetryDelayMs = DEFAULT_MAX_RETRY_DELAY_MS;
  maxQueueSize = DEFAULT_MAX_QUEUE_SIZE;
  autoSchedule = true;
  syncPendingGauge();
}
