import { describe, it, expect, beforeEach } from "vitest";
import {
  isAccepting,
  beginShutdown,
  incInFlight,
  decInFlight,
  inFlightCount,
  whenDrained,
  trackProxyCall,
  proxyCallCount,
  whenProxyCallsSettled,
  __resetLifecycle,
} from "./lifecycle.js";

describe("lifecycle", () => {
  beforeEach(() => {
    __resetLifecycle();
  });

  it("accepts connections until shutdown begins", () => {
    expect(isAccepting()).toBe(true);
    beginShutdown();
    expect(isAccepting()).toBe(false);
  });

  it("tracks the in-flight request count without going negative", () => {
    incInFlight();
    incInFlight();
    expect(inFlightCount()).toBe(2);
    decInFlight();
    expect(inFlightCount()).toBe(1);
    decInFlight();
    decInFlight();
    expect(inFlightCount()).toBe(0);
  });

  it("whenDrained resolves immediately when idle", async () => {
    await expect(whenDrained()).resolves.toBeUndefined();
  });

  it("whenDrained resolves once the last in-flight request finishes", async () => {
    incInFlight();
    incInFlight();

    let resolved = false;
    const drained = whenDrained().then(() => {
      resolved = true;
    });

    decInFlight();
    expect(resolved).toBe(false); // still one in flight

    decInFlight();
    await drained;
    expect(resolved).toBe(true);
  });
});

describe("proxy call drain on shutdown (#216)", () => {
  beforeEach(() => {
    __resetLifecycle();
  });

  it("a paid call in flight when shutdown starts still completes and is awaited", async () => {
    const release = trackProxyCall();
    let settled = false;
    // Stand-in for proxyHandler: the upstream reply and payment settlement finish later.
    const call = new Promise<string>((resolve) => {
      setTimeout(() => {
        settled = true;
        resolve("paid-and-answered");
        release();
      }, 20);
    });

    beginShutdown();
    expect(isAccepting()).toBe(false);
    expect(proxyCallCount()).toBe(1);

    let drained = false;
    const waiting = whenProxyCallsSettled().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    await waiting;
    expect(settled).toBe(true);
    expect(drained).toBe(true);
    expect(await call).toBe("paid-and-answered");
    expect(proxyCallCount()).toBe(0);
  });

  it("resolves immediately when no proxy call is in flight", async () => {
    await expect(whenProxyCallsSettled()).resolves.toBeUndefined();
  });

  it("release is idempotent and never drives the count negative", () => {
    const release = trackProxyCall();
    release();
    release();
    expect(proxyCallCount()).toBe(0);
  });

  it("counts overlapping calls and only drains after the last one", () => {
    const first = trackProxyCall();
    const second = trackProxyCall();
    expect(proxyCallCount()).toBe(2);
    first();
    expect(proxyCallCount()).toBe(1);
    second();
    expect(proxyCallCount()).toBe(0);
  });
});
