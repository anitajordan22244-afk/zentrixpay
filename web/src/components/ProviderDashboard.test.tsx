import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import {
  PROVIDER_KEY_STORAGE,
  clearProviderKey,
  isProviderKeyRemembered,
  readProviderKey,
  saveProviderKey,
} from "../lib/providerKeyStorage.js";

// Issue #137: provider API keys are session-only by default, remembering them
// on the device is an explicit opt-in, and sign-out clears every copy.

const { mockFetchMyApis, mockFetchApiStats } = vi.hoisted(() => ({
  mockFetchMyApis: vi.fn(),
  mockFetchApiStats: vi.fn(),
}));

vi.mock("../api/apis.js", () => ({
  HTTP_METHODS: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  fetchMyApis: mockFetchMyApis,
  createApi: vi.fn(),
  fetchApiStats: mockFetchApiStats,
  registerPublisher: vi.fn(),
  updateApi: vi.fn(),
  verifyApiOwnership: vi.fn(),
}));

import { ProviderDashboard } from "./ProviderDashboard.js";

function memoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}

const wallet = {
  status: "disconnected" as const,
  address: null,
  error: null,
  connect: vi.fn(),
  disconnect: vi.fn(),
};

function renderDashboard() {
  return render(<ProviderDashboard wallet={wallet as never} onCopy={vi.fn()} />);
}

function enterKey(key: string, remember: boolean) {
  fireEvent.change(screen.getByLabelText("API key"), { target: { value: key } });
  if (remember) fireEvent.click(document.getElementById("remember-pasted-key")!);
  fireEvent.click(screen.getByRole("button", { name: "Open dashboard" }));
}

beforeEach(() => {
  vi.stubGlobal("sessionStorage", memoryStorage());
  vi.stubGlobal("localStorage", memoryStorage());
  mockFetchMyApis.mockReset();
  mockFetchMyApis.mockResolvedValue([]);
  mockFetchApiStats.mockReset();
});

describe("providerKeyStorage", () => {
  it("stores the key for this session only by default", () => {
    saveProviderKey("mv_session", false);

    expect(sessionStorage.getItem(PROVIDER_KEY_STORAGE)).toBe("mv_session");
    expect(localStorage.getItem(PROVIDER_KEY_STORAGE)).toBeNull();
    expect(isProviderKeyRemembered()).toBe(false);
    expect(readProviderKey()).toBe("mv_session");
  });

  it("persists the key on the device when remember is chosen", () => {
    saveProviderKey("mv_remembered", true);

    expect(sessionStorage.getItem(PROVIDER_KEY_STORAGE)).toBe("mv_remembered");
    expect(localStorage.getItem(PROVIDER_KEY_STORAGE)).toBe("mv_remembered");
    expect(isProviderKeyRemembered()).toBe(true);
  });

  it("reads a remembered key in a new session", () => {
    localStorage.setItem(PROVIDER_KEY_STORAGE, "mv_remembered");

    expect(readProviderKey()).toBe("mv_remembered");
  });

  it("drops a previously remembered key when switching to session-only", () => {
    saveProviderKey("mv_old", true);
    saveProviderKey("mv_new", false);

    expect(localStorage.getItem(PROVIDER_KEY_STORAGE)).toBeNull();
    expect(readProviderKey()).toBe("mv_new");
  });

  it("clears the key from both storages", () => {
    saveProviderKey("mv_remembered", true);
    clearProviderKey();

    expect(sessionStorage.getItem(PROVIDER_KEY_STORAGE)).toBeNull();
    expect(localStorage.getItem(PROVIDER_KEY_STORAGE)).toBeNull();
    expect(readProviderKey()).toBe("");
  });

  it("does not throw when storage is unavailable", () => {
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    } as unknown as Storage;
    vi.stubGlobal("sessionStorage", broken);
    vi.stubGlobal("localStorage", broken);

    expect(() => saveProviderKey("mv_x", true)).not.toThrow();
    expect(() => clearProviderKey()).not.toThrow();
    expect(readProviderKey()).toBe("");
  });
});

describe("ProviderDashboard key storage", () => {
  it("leaves 'remember' unticked by default and keeps the key session-only", async () => {
    renderDashboard();
    const remember = document.getElementById("remember-pasted-key") as HTMLInputElement;
    expect(remember.checked).toBe(false);

    enterKey("mv_session", false);

    await waitFor(() => expect(mockFetchMyApis).toHaveBeenCalledWith("mv_session"));
    expect(sessionStorage.getItem(PROVIDER_KEY_STORAGE)).toBe("mv_session");
    expect(localStorage.getItem(PROVIDER_KEY_STORAGE)).toBeNull();
    expect(screen.getByText(/kept for this browser tab only/)).toBeTruthy();
  });

  it("remembers the key on the device when the provider opts in", async () => {
    renderDashboard();

    enterKey("mv_remembered", true);

    await waitFor(() => expect(mockFetchMyApis).toHaveBeenCalledWith("mv_remembered"));
    expect(localStorage.getItem(PROVIDER_KEY_STORAGE)).toBe("mv_remembered");
    expect(screen.getByText(/remembered on this device until you sign out/)).toBeTruthy();
  });

  it("opens the dashboard with a remembered key in a new session", async () => {
    localStorage.setItem(PROVIDER_KEY_STORAGE, "mv_remembered");

    renderDashboard();

    await waitFor(() => expect(mockFetchMyApis).toHaveBeenCalledWith("mv_remembered"));
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });

  it.each([
    { label: "session-only", remember: false },
    { label: "remembered", remember: true },
  ])("sign-out clears a $label key from all storage", async ({ remember }) => {
    renderDashboard();
    enterKey("mv_key", remember);
    await waitFor(() => expect(mockFetchMyApis).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    expect(sessionStorage.getItem(PROVIDER_KEY_STORAGE)).toBeNull();
    expect(localStorage.getItem(PROVIDER_KEY_STORAGE)).toBeNull();
    expect(screen.getByRole("button", { name: "Open dashboard" })).toBeTruthy();
  });
});

describe("ProviderDashboard API stats filters & pagination (#143)", () => {
  const sampleApi = {
    id: "api-143",
    name: "Weather Forecast",
    description: "Hourly weather",
    price: "0.01",
    priceRules: [],
    currency: "USDC" as const,
    walletAddress: "G" + "A".repeat(55),
    allowedMethods: ["GET" as const],
    tags: ["weather"],
    healthy: true,
    proxyUrl: "https://gw.test/api/api-143",
    openapiUrl: null,
    onchain: { registered: true, contractId: "C1", txHash: "tx1" },
    createdAt: "2026-03-01T00:00:00.000Z",
    upstreamUrl: "https://api.weather.test/v1",
    upstreamHeaderName: null,
    hasUpstreamSecret: false,
    upstreamQueryParamName: null,
    hasUpstreamQuerySecret: false,
    timeoutMs: null,
    maxResponseBytes: null,
    webhookUrl: null,
    hasWebhookSecret: false,
    healthPath: null,
    health: { healthy: true, consecutiveFailures: 0, lastCheckedAt: null },
    listed: true,
    onchainStatus: "registered" as const,
    ownershipVerified: true,
    ownershipVerification: {
      url: "https://api.weather.test/.well-known/zentrixpay.txt",
      expectedContent: "zentrixpay-verification=tok",
    },
  };

  function makeStatsResponse(overrides: Record<string, unknown> = {}) {
    return {
      apiId: "api-143",
      calls: 3,
      chargedCalls: 2,
      revenue: "0.02",
      uniquePayers: 2,
      avgDurationMs: 110,
      refundedCalls: 0,
      refunded: "0",
      netRevenue: "0.02",
      currency: "USDC" as const,
      recentCalls: [
        {
          id: "c1",
          payerAddress: "G" + "B".repeat(55),
          amount: "0.01",
          charged: true,
          method: "GET",
          path: "/lagos",
          responseStatus: 200,
          durationMs: 100,
          refundStatus: null,
          refundAmount: null,
          refundTxHash: null,
          refundedAt: null,
          createdAt: "2026-03-10T10:00:00.000Z",
        },
        {
          id: "c2",
          payerAddress: "G" + "C".repeat(55),
          amount: "0.01",
          charged: true,
          method: "GET",
          path: "/accra",
          responseStatus: 200,
          durationMs: 120,
          refundStatus: null,
          refundAmount: null,
          refundTxHash: null,
          refundedAt: null,
          createdAt: "2026-03-09T10:00:00.000Z",
        },
      ],
      range: { from: null, to: null },
      pagination: {
        limit: 2,
        offset: 0,
        total: 3,
        hasMore: true,
        nextOffset: 2,
      },
      ...overrides,
    };
  }

  it("applies date range filters, validates inverted ranges, and paginates calls", async () => {
    saveProviderKey("mv_stats", false);
    mockFetchMyApis.mockResolvedValue([sampleApi]);
    mockFetchApiStats.mockResolvedValueOnce(makeStatsResponse());

    renderDashboard();
    await waitFor(() => expect(screen.getByText("Weather Forecast")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Stats" }));
    await waitFor(() => expect(mockFetchApiStats).toHaveBeenCalledWith("mv_stats", "api-143"));
    expect(screen.getByText("Showing 1–2 of 3 calls")).toBeTruthy();

    // Paginate to next page
    mockFetchApiStats.mockResolvedValueOnce(
      makeStatsResponse({
        recentCalls: [
          {
            id: "c3",
            payerAddress: "G" + "D".repeat(55),
            amount: "0.00",
            charged: false,
            method: "GET",
            path: "/nairobi",
            responseStatus: 502,
            durationMs: 110,
            refundStatus: null,
            refundAmount: null,
            refundTxHash: null,
            refundedAt: null,
            createdAt: "2026-03-08T10:00:00.000Z",
          },
        ],
        pagination: { limit: 2, offset: 2, total: 3, hasMore: false, nextOffset: null },
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() =>
      expect(mockFetchApiStats).toHaveBeenLastCalledWith("mv_stats", "api-143", {
        from: undefined,
        to: undefined,
        limit: 2,
        offset: 2,
      }),
    );
    expect(screen.getByText("Showing 3–3 of 3 calls")).toBeTruthy();

    // Apply a date range filter
    mockFetchApiStats.mockResolvedValueOnce(
      makeStatsResponse({
        calls: 0,
        chargedCalls: 0,
        revenue: "0",
        uniquePayers: 0,
        avgDurationMs: 0,
        recentCalls: [],
        range: { from: "2026-03-01T00:00:00.000Z", to: "2026-03-05T23:59:59.999Z" },
        pagination: { limit: 2, offset: 0, total: 0, hasMore: false, nextOffset: null },
      }),
    );

    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-03-01" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-03-05" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply filter" }));

    await waitFor(() =>
      expect(mockFetchApiStats).toHaveBeenLastCalledWith("mv_stats", "api-143", {
        from: "2026-03-01",
        to: "2026-03-05",
        limit: 2,
        offset: 0,
      }),
    );
    expect(screen.getByText("No calls recorded for this range.")).toBeTruthy();

    // Reject inverted date range client-side
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-03-20" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-03-05" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply filter" }));
    expect(screen.getByText("From date must be earlier than or equal to To date")).toBeTruthy();
  });
});
