/**
 * Tests for the proxy buffer concurrency limit (#132).
 *
 * Covers:
 *  - ProxyBufferSemaphore: acquire/release semantics, capacity enforcement
 *  - proxyBufferConcurrency middleware: 503 at capacity, correct response fields
 *  - Slot release on: normal finish, client disconnect (close without finish),
 *    and double-event safety (both fire)
 *  - Unlimited mode (limit=0) never blocks
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Request, Response, NextFunction } from "express";
import {
  ProxyBufferSemaphore,
  proxyBufferConcurrency,
} from "../server/src/middleware/proxyBuffer.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRes() {
  const listeners: Record<string, Array<() => void>> = {};
  const res = {
    headersSent: false,
    statusCode: 200,
    setHeader: vi.fn(),
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    on: vi.fn((event: string, fn: () => void) => {
      (listeners[event] ??= []).push(fn);
      return res;
    }),
    /** Test helper: fire all listeners for an event. */
    emit(event: string) {
      for (const fn of listeners[event] ?? []) fn();
    },
  };
  return res as unknown as Response & { emit(e: string): void };
}

const req = {} as Request;

// ── ProxyBufferSemaphore unit tests ───────────────────────────────────────────

describe("ProxyBufferSemaphore", () => {
  it("allows acquisition up to the limit", () => {
    const sem = new ProxyBufferSemaphore(2);
    expect(sem.tryAcquire()).toBe(true);
    expect(sem.tryAcquire()).toBe(true);
    expect(sem.active).toBe(2);
  });

  it("rejects acquisition when at capacity", () => {
    const sem = new ProxyBufferSemaphore(2);
    sem.tryAcquire();
    sem.tryAcquire();
    expect(sem.tryAcquire()).toBe(false);
    expect(sem.active).toBe(2);
  });

  it("releases a slot so the next request can proceed", () => {
    const sem = new ProxyBufferSemaphore(1);
    expect(sem.tryAcquire()).toBe(true);
    expect(sem.tryAcquire()).toBe(false);
    sem.release();
    expect(sem.tryAcquire()).toBe(true);
  });

  it("active count never goes below 0", () => {
    const sem = new ProxyBufferSemaphore(2);
    sem.release(); // release without prior acquire
    expect(sem.active).toBe(0);
  });

  it("limit=0 disables the semaphore (unlimited)", () => {
    const sem = new ProxyBufferSemaphore(0);
    for (let i = 0; i < 1000; i++) {
      expect(sem.tryAcquire()).toBe(true);
    }
    // active stays 0 in unlimited mode
    expect(sem.active).toBe(0);
    sem.release(); // no-op
    expect(sem.active).toBe(0);
  });

  it("limit=1 allows exactly one concurrent slot", () => {
    const sem = new ProxyBufferSemaphore(1);
    expect(sem.tryAcquire()).toBe(true);
    expect(sem.tryAcquire()).toBe(false);
    sem.release();
    expect(sem.tryAcquire()).toBe(true);
  });
});

// ── proxyBufferConcurrency middleware ─────────────────────────────────────────

describe("proxyBufferConcurrency middleware", () => {
  let sem: ProxyBufferSemaphore;
  let middleware: ReturnType<typeof proxyBufferConcurrency>;

  beforeEach(() => {
    sem = new ProxyBufferSemaphore(2);
    middleware = proxyBufferConcurrency(sem);
  });

  it("calls next() and acquires a slot when capacity is available", () => {
    const res = makeRes();
    const next = vi.fn() as NextFunction;
    middleware(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(sem.active).toBe(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it("returns 503 with Retry-After: 1 when at capacity", () => {
    const next = vi.fn() as NextFunction;
    // fill capacity
    middleware(req, makeRes(), next);
    middleware(req, makeRes(), next);

    const blocked = makeRes();
    const blockedNext = vi.fn() as NextFunction;
    middleware(req, blocked, blockedNext);

    expect(blockedNext).not.toHaveBeenCalled();
    expect(blocked.status).toHaveBeenCalledWith(503);
    expect(blocked.setHeader).toHaveBeenCalledWith("Retry-After", "1");
    expect(blocked.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "proxy_buffer_capacity_exceeded",
        retryAfterSeconds: 1,
      }),
    );
  });

  it("releases the slot on response finish", () => {
    const res = makeRes();
    const next = vi.fn() as NextFunction;
    middleware(req, res, next);
    expect(sem.active).toBe(1);
    res.emit("finish");
    expect(sem.active).toBe(0);
  });

  it("releases the slot on client disconnect (close before finish)", () => {
    const res = makeRes();
    middleware(req, res, vi.fn() as NextFunction);
    expect(sem.active).toBe(1);
    res.emit("close"); // client disconnected without res.end()
    expect(sem.active).toBe(0);
  });

  it("releases the slot exactly once when both finish and close fire", () => {
    const res = makeRes();
    middleware(req, res, vi.fn() as NextFunction);
    expect(sem.active).toBe(1);
    res.emit("finish");
    res.emit("close"); // second event must not double-release
    expect(sem.active).toBe(0);
  });

  it("restores capacity after each release so subsequent requests succeed", () => {
    const sem1 = new ProxyBufferSemaphore(1);
    const mw = proxyBufferConcurrency(sem1);

    // First request acquires the slot
    const res1 = makeRes();
    mw(req, res1, vi.fn() as NextFunction);
    expect(sem1.active).toBe(1);

    // Second request is blocked
    const res2 = makeRes();
    const next2 = vi.fn() as NextFunction;
    mw(req, res2, next2);
    expect(next2).not.toHaveBeenCalled();

    // First request finishes — slot released
    res1.emit("finish");
    expect(sem1.active).toBe(0);

    // Third request now succeeds
    const res3 = makeRes();
    const next3 = vi.fn() as NextFunction;
    mw(req, res3, next3);
    expect(next3).toHaveBeenCalledOnce();
    expect(sem1.active).toBe(1);
  });

  it("does not block when limit=0 (unlimited mode)", () => {
    const unlimitedSem = new ProxyBufferSemaphore(0);
    const unlimitedMw = proxyBufferConcurrency(unlimitedSem);
    for (let i = 0; i < 200; i++) {
      const next = vi.fn() as NextFunction;
      unlimitedMw(req, makeRes(), next);
      expect(next).toHaveBeenCalledOnce();
    }
  });

  it("503 response does NOT consume a slot (rejected requests do not decrement capacity)", () => {
    const sem1 = new ProxyBufferSemaphore(1);
    const mw = proxyBufferConcurrency(sem1);

    // Fill capacity
    mw(req, makeRes(), vi.fn() as NextFunction);
    expect(sem1.active).toBe(1);

    // Reject several requests — each must not modify active count
    for (let i = 0; i < 5; i++) {
      mw(req, makeRes(), vi.fn() as NextFunction);
    }
    expect(sem1.active).toBe(1);
  });
});
