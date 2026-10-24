import type { NextFunction, Request, Response } from "express";

/**
 * Semaphore that limits concurrent proxy buffer slots (#132).
 *
 * When `limit` is 0 the semaphore is disabled and every `acquire()` resolves
 * immediately, preserving pre-#132 behaviour.
 */
export class ProxyBufferSemaphore {
  private readonly limit: number;
  private count = 0;

  constructor(limit: number) {
    this.limit = limit;
  }

  /** Current number of acquired slots. */
  get active(): number {
    return this.count;
  }

  /**
   * Try to acquire a slot.
   * Returns `true` when a slot was obtained, `false` when at capacity.
   * A `false` result must NOT be followed by `release()`.
   */
  tryAcquire(): boolean {
    if (this.limit === 0) return true; // unlimited
    if (this.count >= this.limit) return false;
    this.count++;
    return true;
  }

  /**
   * Release a previously acquired slot.
   * Safe to call multiple times for the same logical slot (idempotent via the
   * `settled` guard in the middleware).
   */
  release(): void {
    if (this.limit === 0) return; // unlimited
    if (this.count > 0) this.count--;
  }
}

/**
 * Build an Express middleware that enforces the given concurrency semaphore on
 * the proxy buffering path.
 *
 * Requests that arrive when capacity is exhausted receive an immediate
 *   503 Service Unavailable
 *   Retry-After: 1
 * so that the x402 client (and any other caller) can retry after a brief wait.
 *
 * The slot is released exactly once under every termination path:
 *   - normal response finish
 *   - client disconnect before response finishes
 *   - error thrown synchronously in next middleware (via next(err))
 *   - request timeout before the handler returns
 *
 * The `settled` flag prevents double-release should multiple events fire for
 * the same request.
 */
export function proxyBufferConcurrency(
  semaphore: ProxyBufferSemaphore,
): (req: Request, res: Response, next: NextFunction) => void {
  return function proxyBufferConcurrencyMiddleware(
    _req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    if (!semaphore.tryAcquire()) {
      res.setHeader("Retry-After", "1");
      res.status(503).json({
        error: "proxy_buffer_capacity_exceeded",
        message: "The proxy is at capacity; please retry in a moment.",
        retryAfterSeconds: 1,
      });
      return;
    }

    let settled = false;
    const release = () => {
      if (settled) return;
      settled = true;
      semaphore.release();
    };

    // Release on normal completion or client-side disconnect.
    res.on("finish", release);
    res.on("close", release);

    next();
  };
}
