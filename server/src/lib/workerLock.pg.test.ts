import { describe, expect, it } from "vitest";
import postgres from "postgres";
import { runWithAdvisoryLock } from "./workerLock.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describePg = testDatabaseUrl ? describe : describe.skip;

describePg("worker advisory lock (real Postgres, two instances)", () => {
  it("runs a tick once when two instances start it together, and again after release", async () => {
    // Two independent connection pools stand in for two server instances.
    const instanceA = postgres(testDatabaseUrl!, { max: 2, onnotice: () => {} });
    const instanceB = postgres(testDatabaseUrl!, { max: 2, onnotice: () => {} });
    const key = 720_999;
    try {
      let runs = 0;
      const tick = async () => {
        runs++;
        await new Promise((resolve) => setTimeout(resolve, 100));
      };

      const results = await Promise.all([
        runWithAdvisoryLock(instanceA, key, tick),
        runWithAdvisoryLock(instanceB, key, tick),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(runs).toBe(1);

      // Lock is released after the tick, so the next tick can run.
      expect(await runWithAdvisoryLock(instanceB, key, tick)).toBe(true);
      expect(runs).toBe(2);
    } finally {
      await instanceA.end();
      await instanceB.end();
    }
  });

  it("releases the lock when the tick throws", async () => {
    const sql = postgres(testDatabaseUrl!, { max: 2, onnotice: () => {} });
    const key = 720_998;
    try {
      await expect(
        runWithAdvisoryLock(sql, key, async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(await runWithAdvisoryLock(sql, key, async () => {})).toBe(true);
    } finally {
      await sql.end();
    }
  });
});
