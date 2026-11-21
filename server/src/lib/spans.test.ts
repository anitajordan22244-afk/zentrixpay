import { describe, expect, it } from "vitest";
import { withSpan } from "./spans.js";

describe("withSpan", () => {
  it("returns the wrapped result", async () => {
    await expect(withSpan("test.ok", { a: 1 }, async () => 42)).resolves.toBe(42);
  });

  it("rethrows the wrapped error unchanged", async () => {
    const boom = new Error("boom");
    await expect(
      withSpan("test.fail", {}, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });
});
