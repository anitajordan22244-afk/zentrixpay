export interface PoolEnv {
  DB_POOL_MAX?: number;
  DB_STATEMENT_TIMEOUT_MS?: number;
  DB_SLOW_QUERY_MS?: number;
}

export interface PoolOptions {
  max: number;
  connection: Record<string, string | number>;
}

export const DEFAULT_POOL_MAX = 10;
export const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;
export const DEFAULT_SLOW_QUERY_MS = 500;

/**
 * Builds postgres.js pool options from validated env values.
 *
 * - `max` caps pool connections so slow queries cannot starve the proxy path.
 * - `statement_timeout` cancels any request query running longer than the limit.
 * - `log_min_duration_statement` makes Postgres log every statement slower than
 *   the threshold (0 disables statement logging, a negative value disables it too).
 */
export function resolvePoolOptions(env: PoolEnv): PoolOptions {
  const max = env.DB_POOL_MAX ?? DEFAULT_POOL_MAX;
  const statementTimeout = env.DB_STATEMENT_TIMEOUT_MS ?? DEFAULT_STATEMENT_TIMEOUT_MS;
  const slowQuery = env.DB_SLOW_QUERY_MS ?? DEFAULT_SLOW_QUERY_MS;
  return {
    max,
    connection: {
      statement_timeout: statementTimeout,
      log_min_duration_statement: slowQuery,
    },
  };
}
