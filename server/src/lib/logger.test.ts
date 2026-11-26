import { describe, expect, it } from "vitest";
import logger, {
  getLogger,
  getRequestId,
  rootLogger,
  runWithRequestContext,
  logger as namedLogger,
} from "./logger.js";

describe("logger API reconciliation (#162)", () => {
  it("exports rootLogger, logger, default, getLogger, getRequestId, runWithRequestContext", () => {
    expect(rootLogger).toBeDefined();
    expect(namedLogger).toBe(rootLogger);
    expect(logger).toBe(rootLogger);
    expect(typeof getLogger).toBe("function");
    expect(typeof getRequestId).toBe("function");
    expect(typeof runWithRequestContext).toBe("function");
  });

  it("returns root logger without requestId outside request context", () => {
    expect(getRequestId()).toBeUndefined();
    const l = getLogger();
    expect(l.bindings().requestId).toBeUndefined();
  });

  it("binds requestId inside runWithRequestContext and isolates contexts", () => {
    expect(getRequestId()).toBeUndefined();

    runWithRequestContext("req-123", () => {
      expect(getRequestId()).toBe("req-123");
      const scopedLogger = getLogger();
      expect(scopedLogger.bindings()).toMatchObject({ requestId: "req-123" });

      // Nested or parallel context
      runWithRequestContext("req-456", () => {
        expect(getRequestId()).toBe("req-456");
        expect(getLogger().bindings()).toMatchObject({ requestId: "req-456" });
      });

      // Context restored
      expect(getRequestId()).toBe("req-123");
      expect(getLogger().bindings()).toMatchObject({ requestId: "req-123" });
    });

    expect(getRequestId()).toBeUndefined();
  });

  it("returns value from runWithRequestContext", () => {
    const result = runWithRequestContext("req-abc", () => {
      return 42;
    });
    expect(result).toBe(42);
  });
});
