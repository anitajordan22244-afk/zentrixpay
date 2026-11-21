/**
 * Health-check backoff (#220). APIs that keep failing are checked less often,
 * so dead upstreams stop costing an outbound request every interval. A success
 * resets `healthFailures` to 0 (see recordHealthCheck), which returns the API
 * to the normal cadence at once.
 */

export interface HealthBackoffApi {
  healthFailures: number;
  lastHealthCheckAt: Date | null;
}

/**
 * Extra wait before the next check, in ms, on top of the normal interval.
 * Zero until the API is unhealthy (failures reach the threshold). From then on
 * the wait doubles per failed check, up to `maxBackoffMs`.
 */
export function healthBackoffDelayMs(
  healthFailures: number,
  failureThreshold: number,
  intervalMs: number,
  maxBackoffMs: number,
): number {
  if (healthFailures < failureThreshold) return 0;
  const exponent = Math.min(healthFailures - failureThreshold + 1, 30);
  return Math.min(intervalMs * 2 ** exponent, maxBackoffMs);
}

/** Whether a check is due at `now`. A check is due immediately if the API was never checked. */
export function isHealthCheckDue(
  api: HealthBackoffApi,
  now: Date,
  intervalMs: number,
  failureThreshold: number,
  maxBackoffMs: number,
): boolean {
  if (!api.lastHealthCheckAt) return true;
  const delay = healthBackoffDelayMs(
    api.healthFailures,
    failureThreshold,
    intervalMs,
    maxBackoffMs,
  );
  // Half an interval of slack absorbs timer jitter, so a check is never skipped
  // just because the previous one finished a few ms after its tick started.
  return now.getTime() >= api.lastHealthCheckAt.getTime() + delay - intervalMs / 2;
}

/** When the owner should expect the next check, or null if it has not been checked yet. */
export function nextHealthCheckAt(
  api: HealthBackoffApi,
  intervalMs: number,
  failureThreshold: number,
  maxBackoffMs: number,
): Date | null {
  if (!api.lastHealthCheckAt) return null;
  const delay = healthBackoffDelayMs(
    api.healthFailures,
    failureThreshold,
    intervalMs,
    maxBackoffMs,
  );
  return new Date(api.lastHealthCheckAt.getTime() + Math.max(delay, intervalMs));
}
