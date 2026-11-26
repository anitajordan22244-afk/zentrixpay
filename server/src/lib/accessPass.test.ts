import { describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({ config: { NETWORK: "stellar:testnet" } }));

import {
  PASS_DURATION_MAX_MS,
  PASS_DURATION_MIN_MS,
  formatPassDuration,
  passDurationOf,
  passPaymentOptions,
} from "./accessPass.js";
import { createApiSchema, updateApiSchema } from "../schemas/requests.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const api = {
  name: "Weather",
  walletAddress: "GPAYEE",
  passPrice: "1.50",
  passDurationMs: 7 * DAY,
};

describe("pass payment challenge (#278)", () => {
  it("advertises the gateway's Stellar network, never an EVM test network", () => {
    const options = passPaymentOptions({ ...api, network: "base-sepolia" } as typeof api);
    expect(options.network).toBe("stellar:testnet");
    expect(options.network).not.toBe("base-sepolia");
  });

  it("pays the API's payee the pass price", () => {
    const options = passPaymentOptions(api);
    expect(options.price).toBe("1.50");
    expect(options.payTo).toBe("GPAYEE");
  });

  it("uses the provider's duration and shows it in the 402 description", () => {
    const options = passPaymentOptions(api);
    expect(options.durationMs).toBe(7 * DAY);
    expect(options.description).toBe("Access pass for Weather (7 days)");
  });

  it("defaults to one hour for rows without a duration", () => {
    expect(passPaymentOptions({ ...api, passDurationMs: null }).durationMs).toBe(HOUR);
  });

  it("refuses APIs that do not offer passes", () => {
    expect(() => passPaymentOptions({ ...api, passPrice: null })).toThrow();
  });
});

describe("pass duration bounds (#278)", () => {
  it("clamps stored values into 1 hour .. 30 days", () => {
    expect(passDurationOf({ passDurationMs: 60_000 })).toBe(PASS_DURATION_MIN_MS);
    expect(passDurationOf({ passDurationMs: 365 * DAY })).toBe(PASS_DURATION_MAX_MS);
  });

  it("formats durations for people", () => {
    expect(formatPassDuration(HOUR)).toBe("1 hour");
    expect(formatPassDuration(12 * HOUR)).toBe("12 hours");
    expect(formatPassDuration(DAY + 6 * HOUR)).toBe("1 day 6 hours");
    expect(formatPassDuration(30 * DAY)).toBe("30 days");
  });

  const base = {
    name: "Weather",
    upstreamUrl: "https://weather.example.com",
    price: "0.01",
    allowedMethods: ["GET"],
  };

  it("providers can set a duration within bounds when creating or updating", () => {
    expect(createApiSchema.safeParse({ ...base, passDurationMs: 7 * DAY }).success).toBe(true);
    expect(updateApiSchema.safeParse({ passDurationMs: HOUR }).success).toBe(true);
    expect(updateApiSchema.safeParse({ passDurationMs: 30 * DAY }).success).toBe(true);
  });

  it("rejects durations outside 1 hour .. 30 days", () => {
    expect(updateApiSchema.safeParse({ passDurationMs: HOUR - 1 }).success).toBe(false);
    expect(updateApiSchema.safeParse({ passDurationMs: 30 * DAY + 1 }).success).toBe(false);
    expect(updateApiSchema.safeParse({ passDurationMs: 1.5 * HOUR }).success).toBe(true);
    expect(updateApiSchema.safeParse({ passDurationMs: 1.5 }).success).toBe(false);
  });
});
