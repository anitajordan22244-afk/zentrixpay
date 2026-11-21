import { config } from "../config.js";
import { getLogger } from "../lib/logger.js";
import { applyDuePriceChanges } from "../services/apiService.js";

// Issue #228: applies scheduled price changes once their effectiveAt has passed.
// Runs periodically; a change is at most one interval late.

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let running = false;

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const applied = await applyDuePriceChanges();
    if (applied > 0) {
      getLogger().info({ event: "price_changes_applied", count: applied }, "scheduled price changes applied");
    }
  } catch (err) {
    getLogger().error({ event: "price_change_worker_failed", err }, "failed to apply scheduled price changes");
  } finally {
    running = false;
  }
}

export function startPriceChangeWorker(): void {
  if (config.PRICE_CHANGE_WORKER_INTERVAL_MS <= 0) return;
  void tick();
  intervalHandle = setInterval(() => void tick(), config.PRICE_CHANGE_WORKER_INTERVAL_MS);
}

export function stopPriceChangeWorker(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
