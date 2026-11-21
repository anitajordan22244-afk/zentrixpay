import { describe, it, expect, vi, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";

vi.mock("../config.js", () => ({ config: {} }));

import { streamUpstream } from "./upstreamClient.js";

let server: http.Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

describe("streaming (SSE) responses from upstream", () => {
  it("delivers events to the caller incrementally, before the upstream finishes", async () => {
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>((r) => (releaseSecond = r));

    server = http.createServer(async (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\n\n");
      await secondGate;
      res.end("data: second\n\n");
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    const { port } = server.address() as AddressInfo;

    const upstream = await streamUpstream({
      url: new URL(`http://127.0.0.1:${port}/events`),
      method: "GET",
      headers: {},
      timeoutMs: 5000,
      maxResponseBytes: 1024 * 1024,
      allowPrivate: true,
    } as any);

    expect(upstream.status).toBe(200);
    const firstChunk = await new Promise<string>((resolve, reject) => {
      upstream.stream.once("data", (c: Buffer) => resolve(c.toString()));
      upstream.stream.once("error", reject);
    });
    expect(firstChunk).toContain("data: first");

    releaseSecond();
    const rest: string[] = [];
    for await (const chunk of upstream.stream) rest.push(String(chunk));
    expect(rest.join("")).toContain("data: second");
  });
});
