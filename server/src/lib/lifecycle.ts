// Process lifecycle state for graceful shutdown (issue #112).
//
// Tracks whether the server is still accepting work and how many requests are
// currently in flight, so a SIGTERM/SIGINT handler can stop accepting new
// connections, wait for outstanding requests to finish, then close resources
// without dropping anything.
//
// Module-level singleton: there is exactly one process lifecycle.

let acceptingConnections = true;
let inFlight = 0;
// Resolvers waiting for the in-flight count to reach zero.
let drainWaiters: Array<() => void> = [];
// Paid proxy calls tracked on their own, so shutdown can wait for a call that
// is still settling its payment even after the HTTP layer reports it drained (#216).
let proxyCalls = 0;
let proxyWaiters: Array<() => void> = [];

/** True until beginShutdown() is called. */
export function isAccepting(): boolean {
  return acceptingConnections;
}

/** Flip into shutting-down mode. Idempotent. */
export function beginShutdown(): void {
  acceptingConnections = false;
}

export function incInFlight(): void {
  inFlight += 1;
}

export function decInFlight(): void {
  inFlight = Math.max(0, inFlight - 1);
  if (inFlight === 0 && drainWaiters.length > 0) {
    const waiters = drainWaiters;
    drainWaiters = [];
    for (const resolve of waiters) resolve();
  }
}

export function inFlightCount(): number {
  return inFlight;
}

/** Resolves once there are no in-flight requests. Resolves immediately if already idle. */
export function whenDrained(): Promise<void> {
  if (inFlight === 0) return Promise.resolve();
  return new Promise((resolve) => {
    drainWaiters.push(resolve);
  });
}

/**
 * Mark a paid proxy call as started. The returned function marks it finished;
 * calling it more than once is harmless.
 */
export function trackProxyCall(): () => void {
  proxyCalls += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    proxyCalls = Math.max(0, proxyCalls - 1);
    if (proxyCalls === 0 && proxyWaiters.length > 0) {
      const waiters = proxyWaiters;
      proxyWaiters = [];
      for (const resolve of waiters) resolve();
    }
  };
}

export function proxyCallCount(): number {
  return proxyCalls;
}

/** Resolves once no proxy call is in flight. Shutdown races this against its deadline. */
export function whenProxyCallsSettled(): Promise<void> {
  if (proxyCalls === 0) return Promise.resolve();
  return new Promise((resolve) => {
    proxyWaiters.push(resolve);
  });
}

/** Test helper — reset all lifecycle state between cases. */
export function __resetLifecycle(): void {
  acceptingConnections = true;
  inFlight = 0;
  drainWaiters = [];
  proxyCalls = 0;
  proxyWaiters = [];
}
