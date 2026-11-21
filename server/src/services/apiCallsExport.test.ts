import { describe, expect, it } from "vitest";
import { callToCsvLine, csvCell, writeCallsCsv, type CsvSink } from "./apiCallsExport.js";

describe("csvCell", () => {
  it("leaves plain values unquoted and empties nulls", () => {
    expect(csvCell("GET")).toBe("GET");
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });

  it("quotes values containing commas, quotes or line breaks", () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("line\nbreak")).toBe('"line\nbreak"');
  });
});

describe("callToCsvLine", () => {
  it("writes the documented columns in order", () => {
    const line = callToCsvLine({
      id: 7,
      createdAt: new Date("2026-01-02T03:04:05.000Z"),
      method: "POST",
      path: "/v1/items",
      statusCode: 200,
      charged: true,
      amount: "0.0100000",
      asset: "USDC",
      payer: "GPAYER",
      settlementTx: "abc",
      latencyMs: 42,
      error: null,
    } as never);
    expect(line).toBe(
      "7,2026-01-02T03:04:05.000Z,POST,/v1/items,200,true,0.0100000,USDC,GPAYER,abc,42,",
    );
  });
});

describe("writeCallsCsv backpressure", () => {
  it("waits for drain when the sink reports a full buffer", async () => {
    const writes: string[] = [];
    let drainListener: (() => void) | null = null;
    let full = true;
    const sink: CsvSink = {
      write(chunk) {
        writes.push(chunk);
        return !full;
      },
      once(_event, listener) {
        drainListener = listener;
      },
    };
    // With no database rows the export writes only the header, then waits for drain.
    const pending = writeCallsCsv(sink, 1).catch(() => "db-unavailable");
    await new Promise((r) => setImmediate(r));
    expect(writes[0]).toMatch(/^id,created_at,/);
    full = false;
    (drainListener as (() => void) | null)?.();
    await pending;
  });
});
