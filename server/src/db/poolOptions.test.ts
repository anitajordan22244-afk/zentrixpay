import { describe, expect, it } from "vitest";
import {
  DEFAULT_POOL_MAX,
  DEFAULT_SLOW_QUERY_MS,
  DEFAULT_STATEMENT_TIMEOUT_MS,
  resolvePoolOptions,
} from "./poolOptions.js";

describe("resolvePoolOptions", () => {
  it("uses documented defaults when nothing is configured", () => {
    expect(resolvePoolOptions({})).toEqual({
      max: DEFAULT_POOL_MAX,
      connection: {
        statement_timeout: DEFAULT_STATEMENT_TIMEOUT_MS,
        log_min_duration_statement: DEFAULT_SLOW_QUERY_MS,
      },
    });
  });

  it("applies configured pool size, statement timeout and slow-query threshold", () => {
    const opts = resolvePoolOptions({
      DB_POOL_MAX: 25,
      DB_STATEMENT_TIMEOUT_MS: 5_000,
      DB_SLOW_QUERY_MS: 250,
    });
    expect(opts.max).toBe(25);
    expect(opts.connection).toEqual({
      statement_timeout: 5_000,
      log_min_duration_statement: 250,
    });
  });
});
