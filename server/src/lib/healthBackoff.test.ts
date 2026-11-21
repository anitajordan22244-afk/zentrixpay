import { describe, expect, it } from "vitest";
import { healthBackoffDelayMs, isHealthCheckDue, nextHealthCheckAt } from "./healthBackoff.js";

const INTERVAL = 60_000;
const THRESHOLD = 3;
const MAX = 3_600_000;
const T0 = new Date("2026-01-01T00:00:00Z");

describe("healthBackoffDelayMs", () => {
  it("adds no delay until the API is unhealthy", () => {
    expect(healthBackoffDelayMs(0, THRESHOLD, INTERVAL, MAX)).toBe(0);
    expect(healthBackoffDelayMs(THRESHOLD - 1, THRESHOLD, INTERVAL, MAX)).toBe(0);
  });

  it("doubles per failed check once unhealthy", () => {
    expect(healthBackoffDelayMs(THRESHOLD, THRESHOLD, INTERVAL, MAX)).toBe(2 * INTERVAL);
    expect(healthBackoffDelayMs(THRESHOLD + 1, THRESHOLD, INTERVAL, MAX)).toBe(4 * INTERVAL);
    expect(healthBackoffDelayMs(THRESHOLD + 2, THRESHOLD, INTERVAL, MAX)).toBe(8 * INTERVAL);
  });

  it("caps the delay at the maximum", () => {
    expect(healthBackoffDelayMs(100, THRESHOLD, INTERVAL, MAX)).toBe(MAX);
  });
});

describe("isHealthCheckDue", () => {
  it("is due for a healthy API on every tick", () => {
    const api = { healthFailures: 0, lastHealthCheckAt: T0 };
    expect(isHealthCheckDue(api, new Date(T0.getTime() + INTERVAL), INTERVAL, THRESHOLD, MAX)).toBe(
      true,
    );
  });

  it("is due for an API that was never checked", () => {
    const api = { healthFailures: 0, lastHealthCheckAt: null };
    expect(isHealthCheckDue(api, T0, INTERVAL, THRESHOLD, MAX)).toBe(true);
  });

  it("skips a persistently failing API until its backoff window passes", () => {
    const api = { healthFailures: THRESHOLD, lastHealthCheckAt: T0 };
    const oneTickLater = new Date(T0.getTime() + INTERVAL);
    const twoTicksLater = new Date(T0.getTime() + 2 * INTERVAL);
    expect(isHealthCheckDue(api, oneTickLater, INTERVAL, THRESHOLD, MAX)).toBe(false);
    expect(isHealthCheckDue(api, twoTicksLater, INTERVAL, THRESHOLD, MAX)).toBe(true);
  });

  it("does not skip a backed-off check because of timer jitter", () => {
    const api = { healthFailures: THRESHOLD, lastHealthCheckAt: T0 };
    const slightlyEarly = new Date(T0.getTime() + 2 * INTERVAL - 500);
    expect(isHealthCheckDue(api, slightlyEarly, INTERVAL, THRESHOLD, MAX)).toBe(true);
  });
});

describe("nextHealthCheckAt", () => {
  it("is null for an API that was never checked", () => {
    expect(
      nextHealthCheckAt({ healthFailures: 0, lastHealthCheckAt: null }, INTERVAL, THRESHOLD, MAX),
    ).toBeNull();
  });

  it("is one interval after the last check while healthy", () => {
    const next = nextHealthCheckAt(
      { healthFailures: 0, lastHealthCheckAt: T0 },
      INTERVAL,
      THRESHOLD,
      MAX,
    );
    expect(next?.getTime()).toBe(T0.getTime() + INTERVAL);
  });

  it("reflects the backoff window while failing", () => {
    const next = nextHealthCheckAt(
      { healthFailures: THRESHOLD + 1, lastHealthCheckAt: T0 },
      INTERVAL,
      THRESHOLD,
      MAX,
    );
    expect(next?.getTime()).toBe(T0.getTime() + 4 * INTERVAL);
  });
});
