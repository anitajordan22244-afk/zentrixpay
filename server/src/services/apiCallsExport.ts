import { asc, gt } from "drizzle-orm";
import { db } from "../db/client.js";
import { apiCalls } from "../db/schema.js";
import { statsWhere, type StatsRange } from "./apiStatsQuery.js";

/** Rows fetched per database round trip while streaming an export. */
export const CALLS_EXPORT_BATCH_SIZE = 500;

export const CALLS_CSV_HEADER = [
  "id",
  "created_at",
  "method",
  "path",
  "response_status",
  "charged",
  "amount",
  "payer_address",
  "tx_hash",
  "duration_ms",
] as const;

type CallRow = typeof apiCalls.$inferSelect;

/** RFC 4180 cell: quote when it holds a delimiter, quote, or line break. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = value instanceof Date ? value.toISOString() : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function callToCsvLine(call: CallRow): string {
  return [
    call.id,
    call.createdAt,
    call.method,
    call.path,
    call.responseStatus,
    call.charged,
    call.amount,
    call.payerAddress,
    call.txHash,
    call.durationMs,
  ]
    .map(csvCell)
    .join(",");
}

/**
 * Yields an API's call rows in id order, one bounded batch at a time, using
 * keyset pagination so the full range is never held in memory.
 */
export async function* iterateApiCalls(
  apiId: string,
  range: StatsRange = {},
  batchSize = CALLS_EXPORT_BATCH_SIZE,
): AsyncGenerator<CallRow> {
  let lastId = "";
  for (;;) {
    const batch = await db
      .select()
      .from(apiCalls)
      .where(statsWhere(String(apiId), range) && gt(apiCalls.id, lastId))
      .orderBy(asc(apiCalls.id))
      .limit(batchSize);
    for (const call of batch) yield call;
    if (batch.length < batchSize) return;
    lastId = batch[batch.length - 1].id;
  }
}

/** Minimal writable surface, so the stream can be driven by Express or a test double. */
export interface CsvSink {
  write(chunk: string): boolean;
  once(event: "drain", listener: () => void): unknown;
}

/**
 * Streams the CSV to `sink`, waiting for `drain` whenever the sink's buffer is
 * full so memory stays bounded for very large ranges.
 */
export async function writeCallsCsv(
  sink: CsvSink,
  apiId: string,
  range: StatsRange = {},
): Promise<number> {
  let rows = 0;
  if (!sink.write(`${CALLS_CSV_HEADER.join(",")}\n`)) {
    await new Promise<void>((resolve) => sink.once("drain", () => resolve()));
  }
  for await (const call of iterateApiCalls(apiId, range)) {
    rows += 1;
    if (!sink.write(`${callToCsvLine(call)}\n`)) {
      await new Promise<void>((resolve) => sink.once("drain", () => resolve()));
    }
  }
  return rows;
}
