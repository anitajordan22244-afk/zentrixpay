import { describe, expect, it } from "vitest";
import { classifyFacilitatorError } from "./loggingFacilitator.js";

describe("classifyFacilitatorError", () => {
  it("marks 5xx facilitator responses as facilitator_5xx", () => {
    expect(classifyFacilitatorError(new Error("Facilitator verify failed (503): busy"))).toBe(
      "facilitator_5xx",
    );
  });

  it("marks 4xx facilitator responses as facilitator_4xx", () => {
    expect(classifyFacilitatorError(new Error("Facilitator settle failed (400): bad"))).toBe(
      "facilitator_4xx",
    );
  });

  it("marks network failures as unreachable", () => {
    const cause = Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" });
    expect(classifyFacilitatorError(new TypeError("fetch failed", { cause }))).toBe("unreachable");
  });

  it("marks aborted or timed-out calls as unreachable", () => {
    expect(
      classifyFacilitatorError(Object.assign(new Error("aborted"), { name: "AbortError" })),
    ).toBe("unreachable");
  });

  it("falls back to other for anything unrecognised", () => {
    expect(classifyFacilitatorError(new Error("Invalid payment required response"))).toBe("other");
  });
});
