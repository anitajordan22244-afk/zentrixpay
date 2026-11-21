import type { Sql } from "postgres";

// Single-instance background work (#207). Every replica starts the same
// workers, so each tick first takes a Postgres session-level advisory lock with
// pg_try_advisory_lock. A replica that does not get the lock skips the tick
// rather than waiting, so with N instances each tick runs once.
//
// The lock is held on one reserved connection for the length of the tick and
// released on that same connection, which session-level locks require.

export const WORKER_LOCK_KEYS = {
  healthCheck: 720_001,
  apiCallRetention: 720_002,
  apiCallRecovery: 720_003,
  webhookDelivery: 720_004,
} as const;

/**
 * Runs `fn` only if this process wins the advisory lock for `key`.
 * Resolves to true when `fn` ran, false when another instance held the lock.
 * `fn` errors propagate after the lock is released.
 */
export async function runWithAdvisoryLock(
  sql: Sql,
  key: number,
  fn: () => Promise<void>,
): Promise<boolean> {
  const conn = await sql.reserve();
  try {
    const [row] = await conn`select pg_try_advisory_lock(${key}) as locked`;
    if (!row?.locked) return false;
    try {
      await fn();
    } finally {
      await conn`select pg_advisory_unlock(${key})`;
    }
    return true;
  } finally {
    conn.release();
  }
}
