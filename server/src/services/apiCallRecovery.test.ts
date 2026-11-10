import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { dbInsertState } = vi.hoisted(() => ({
  dbInsertState: {
    rows: [] as Array<Record<string, unknown>>,
    failNextCount: 0,
    errorMessage: "connection terminated unexpectedly",
  },
}));

vi.mock("../db/client.js", () => ({
  db: {
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        const execute = async () => {
          if (dbInsertState.failNextCount > 0) {
            dbInsertState.failNextCount -= 1;
            throw new Error(dbInsertState.errorMessage);
          }
          const exists = dbInsertState.rows.some((r) => r.id === row.id);
          if (!exists) {
            dbInsertState.rows.push(row);
          }
        };
        return {
          onConflictDoNothing: () => execute(),
          then: (onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
            execute().then(onFulfilled, onRejected),
        };
      },
    }),
  },
}));

import { metricsRegistry } from "../lib/metrics.js";
import {
  configureApiCallRecovery,
  enqueueFailedApiCall,
  getApiCallRecoveryStatus,
  loadPendingApiCallsFromSpool,
  normalizeApiCallRecord,
  recordApiCallWithRecovery,
  recoverPendingApiCalls,
  resetApiCallRecoveryForTests,
} from "./apiCallRecovery.js";

describe("apiCallRecovery (#134)", () => {
  beforeEach(() => {
    dbInsertState.rows = [];
    dbInsertState.failNextCount = 0;
    dbInsertState.errorMessage = "connection terminated unexpectedly";
    resetApiCallRecoveryForTests();
    configureApiCallRecovery({ autoSchedule: false });
  });

  afterEach(() => {
    resetApiCallRecoveryForTests();
  });

  it("writes call records directly when the database is healthy", async () => {
    const res = await recordApiCallWithRecovery({
      id: "call_ok_1",
      apiId: "api_1",
      payerAddress: "G".padEnd(56, "A"),
      amount: "0.05",
      charged: true,
      txHash: "tx_abc123",
      method: "POST",
      path: "/v1/infer",
      responseStatus: 200,
      durationMs: 42,
    });

    expect(res).toEqual({ status: "recorded", id: "call_ok_1" });
    expect(dbInsertState.rows).toHaveLength(1);
    expect(dbInsertState.rows[0]).toMatchObject({
      id: "call_ok_1",
      apiId: "api_1",
      charged: true,
      amount: "0.05",
      txHash: "tx_abc123",
    });
    expect(getApiCallRecoveryStatus().pendingCount).toBe(0);
  });

  it("queues failed database writes, exposes operational signals, and recovers when DB returns", async () => {
    dbInsertState.failNextCount = 1;

    const firstAttempt = await recordApiCallWithRecovery({
      id: "call_recover_1",
      apiId: "api_weather",
      payerAddress: "G".padEnd(56, "B"),
      amount: "0.02",
      charged: true,
      txHash: "tx_settled_99",
      method: "GET",
      path: "/forecast",
      responseStatus: 200,
      durationMs: 18,
    });

    expect(firstAttempt).toEqual({ status: "queued", id: "call_recover_1" });
    expect(dbInsertState.rows).toHaveLength(0);

    const statusWhilePending = getApiCallRecoveryStatus();
    expect(statusWhilePending.pendingCount).toBe(1);
    expect(statusWhilePending.totalQueued).toBe(1);
    expect(statusWhilePending.oldestPendingAt).toBeTruthy();
    expect(statusWhilePending.pending[0]).toMatchObject({
      attempts: 1,
      lastError: "connection terminated unexpectedly",
      record: {
        id: "call_recover_1",
        apiId: "api_weather",
        charged: true,
        amount: "0.02",
        txHash: "tx_settled_99",
      },
    });

    const metricsBefore = await metricsRegistry.metrics();
    expect(metricsBefore).toContain("api_call_records_pending_recovery 1");
    expect(metricsBefore).toContain('api_call_records_recovery_total{outcome="queued"} 1');

    const recoveryResult = await recoverPendingApiCalls();
    expect(recoveryResult).toEqual({
      recovered: 1,
      failed: 0,
      pendingCount: 0,
    });

    expect(dbInsertState.rows).toHaveLength(1);
    expect(dbInsertState.rows[0]).toMatchObject({
      id: "call_recover_1",
      apiId: "api_weather",
      charged: true,
      amount: "0.02",
      txHash: "tx_settled_99",
    });

    const statusAfterRecovery = getApiCallRecoveryStatus();
    expect(statusAfterRecovery.pendingCount).toBe(0);
    expect(statusAfterRecovery.totalRecovered).toBe(1);

    const metricsAfter = await metricsRegistry.metrics();
    expect(metricsAfter).toContain("api_call_records_pending_recovery 0");
    expect(metricsAfter).toContain('api_call_records_recovery_total{outcome="recovered"} 1');
  });

  it("is idempotent across repeated failures and duplicate submission attempts", async () => {
    dbInsertState.failNextCount = 2;

    const input = {
      id: "call_idempotent_1",
      apiId: "api_search",
      payerAddress: "G".padEnd(56, "C"),
      amount: "0.10",
      charged: true,
      txHash: "tx_unique_1",
      method: "POST",
      path: "/query",
      responseStatus: 200,
      durationMs: 31,
    };

    // Initial write fails -> queued
    await recordApiCallWithRecovery(input);
    expect(getApiCallRecoveryStatus().pendingCount).toBe(1);

    // Duplicate enqueue with the same id updates existing entry rather than duplicating
    enqueueFailedApiCall(normalizeApiCallRecord(input), new Error("still down"));
    expect(getApiCallRecoveryStatus().pendingCount).toBe(1);
    expect(getApiCallRecoveryStatus().pending[0].attempts).toBe(2);

    // First recovery attempt fails (failNextCount was 2)
    const failedPass = await recoverPendingApiCalls();
    expect(failedPass).toEqual({ recovered: 0, failed: 1, pendingCount: 1 });
    expect(dbInsertState.rows).toHaveLength(0);

    // Second recovery attempt succeeds
    const recoveredPass = await recoverPendingApiCalls();
    expect(recoveredPass).toEqual({ recovered: 1, failed: 0, pendingCount: 0 });
    expect(dbInsertState.rows).toHaveLength(1);

    // Re-recording or re-enqueueing the already-recovered call is deduplicated
    const replay = await recordApiCallWithRecovery(input);
    expect(replay).toEqual({ status: "deduplicated", id: "call_idempotent_1" });
    expect(enqueueFailedApiCall(normalizeApiCallRecord(input), new Error("late error"))).toBeNull();
    expect(dbInsertState.rows).toHaveLength(1);
    expect(getApiCallRecoveryStatus().totalDeduplicated).toBe(2);
  });

  it("persists pending records to a disk spool and recovers them across restarts", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zentrix-call-spool-"));
    const spoolFilePath = path.join(tmpDir, "pending-calls.json");

    try {
      configureApiCallRecovery({ spoolFilePath, autoSchedule: false });
      dbInsertState.failNextCount = 1;

      await recordApiCallWithRecovery({
        id: "call_spooled_1",
        apiId: "api_spool",
        payerAddress: "G".padEnd(56, "D"),
        amount: "0.05",
        charged: true,
        txHash: "tx_spool_1",
        method: "GET",
        path: "/items",
        responseStatus: 200,
        durationMs: 12,
      });

      expect(fs.existsSync(spoolFilePath)).toBe(true);
      const rawSpool = JSON.parse(fs.readFileSync(spoolFilePath, "utf8"));
      expect(rawSpool).toHaveLength(1);
      expect(rawSpool[0].record.id).toBe("call_spooled_1");

      // Simulate process restart by resetting memory state and reloading from disk spool
      resetApiCallRecoveryForTests();
      configureApiCallRecovery({ spoolFilePath, autoSchedule: false });
      expect(getApiCallRecoveryStatus().pendingCount).toBe(0);

      const loaded = loadPendingApiCallsFromSpool();
      expect(loaded).toBe(1);
      expect(getApiCallRecoveryStatus().pendingCount).toBe(1);

      const recovered = await recoverPendingApiCalls();
      expect(recovered).toEqual({ recovered: 1, failed: 0, pendingCount: 0 });
      expect(dbInsertState.rows).toHaveLength(1);
      expect(dbInsertState.rows[0].id).toBe("call_spooled_1");

      const updatedSpool = JSON.parse(fs.readFileSync(spoolFilePath, "utf8"));
      expect(updatedSpool).toHaveLength(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("automatically retries and recovers queued records in the background when enabled", async () => {
    configureApiCallRecovery({
      autoSchedule: true,
      retryBaseDelayMs: 20,
      maxRetryDelayMs: 50,
    });
    dbInsertState.failNextCount = 1;

    const queued = await recordApiCallWithRecovery({
      id: "call_auto_retry_1",
      apiId: "api_auto",
      payerAddress: "G".padEnd(56, "E"),
      amount: "0.01",
      charged: true,
      txHash: "tx_auto_1",
      method: "GET",
      path: "/ping",
      responseStatus: 200,
      durationMs: 7,
    });

    expect(queued.status).toBe("queued");
    expect(getApiCallRecoveryStatus().pendingCount).toBe(1);

    await vi.waitFor(
      () => {
        expect(getApiCallRecoveryStatus().pendingCount).toBe(0);
        expect(dbInsertState.rows).toHaveLength(1);
      },
      { timeout: 1_000, interval: 15 },
    );

    expect(dbInsertState.rows[0].id).toBe("call_auto_retry_1");
  });
});
