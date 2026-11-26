// Access pass length (#278): providers choose how long a pass lasts within
// these bounds. No config dependency, so request schemas can import it.

export const PASS_DURATION_MIN_MS = 60 * 60 * 1000; // 1 hour
export const PASS_DURATION_MAX_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const PASS_DURATION_DEFAULT_MS = PASS_DURATION_MIN_MS;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Human-readable pass length, e.g. "1 hour", "12 hours", "7 days", "1 day 6 hours". */
export function formatPassDuration(ms: number): string {
  const days = Math.floor(ms / DAY_MS);
  const hours = Math.floor((ms % DAY_MS) / HOUR_MS);
  const minutes = Math.round((ms % HOUR_MS) / 60_000);
  const parts: string[] = [];
  if (days) parts.push(`${days} ${days === 1 ? "day" : "days"}`);
  if (hours) parts.push(`${hours} ${hours === 1 ? "hour" : "hours"}`);
  if (minutes) parts.push(`${minutes} ${minutes === 1 ? "minute" : "minutes"}`);
  return parts.join(" ") || "0 minutes";
}

/** The duration to grant, falling back to the default for rows without one. */
export function passDurationOf(api: { passDurationMs?: number | null }): number {
  const ms = api.passDurationMs ?? PASS_DURATION_DEFAULT_MS;
  return Math.min(Math.max(ms, PASS_DURATION_MIN_MS), PASS_DURATION_MAX_MS);
}
