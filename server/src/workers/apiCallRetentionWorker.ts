import { config } from "../config.js";
import { db, pgClient } from "../db/client.js";
import { runWithAdvisoryLock, WORKER_LOCK_KEYS } from "../lib/workerLock.js";
import { logger } from "../lib/logger.js";
import { purgeExpiredApiCalls } from "../services/apiCallRetention.js";

// Deletes api_calls rows older than API_CALL_RETENTION_DAYS (#144) on an
// interval. Runs in every replica; deletes are idempotent, so concurrent runs
// only race for the same rows.

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let running = false;

export function startApiCallRetentionWorker(): void {
  if (config.API_CALL_RETENTION_DAYS <= 0 || config.API_CALL_RETENTION_INTERVAL_MS <= 0) return;
  logger.info(
    {
      event: "api_call_retention_worker_start",
      retentionDays: config.API_CALL_RETENTION_DAYS,
      intervalMs: config.API_CALL_RETENTION_INTERVAL_MS,
    },
    "starting API call retention worker",
  );
  void runApiCallRetention();
  intervalHandle = setInterval(
    () => void runApiCallRetention(),
    config.API_CALL_RETENTION_INTERVAL_MS,
  );
  intervalHandle.unref?.();
}

export function stopApiCallRetentionWorker(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

export async function runApiCallRetention(): Promise<void> {
  // Skip a run rather than overlap with a slow one.
  if (running) return;
  running = true;
  try {
    await runWithAdvisoryLock(pgClient, WORKER_LOCK_KEYS.apiCallRetention, async () => {
      const deleted = await purgeExpiredApiCalls(db, {
        retentionDays: config.API_CALL_RETENTION_DAYS,
        batchSize: config.API_CALL_RETENTION_BATCH_SIZE,
      });
      if (deleted > 0) {
        logger.info(
          {
            event: "api_calls_purged",
            deleted,
            retentionDays: config.API_CALL_RETENTION_DAYS,
          },
          "deleted expired API call records",
        );
      }
    });
  } catch (err) {
    logger.error({ event: "api_call_retention_error", err }, "API call retention run failed");
  } finally {
    running = false;
  }
}
