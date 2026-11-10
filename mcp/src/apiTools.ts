/**
 * Pay-per-call API tool definitions and handler for ZentrixPay MCP.
 *
 * Exports:
 *   API_TOOL_DEFINITIONS — tool descriptors merged into TOOL_DEFINITIONS in tools.ts
 *   API_TOOL_NAMES       — Set<string> used by the dispatcher in index.ts
 *   createApiToolHandler — factory that wires injected deps into a tool dispatcher
 */

import { assertWithinSessionSpendLimit, recordSessionSpend } from "./paymentCeiling.js";
import { ZENTRIXPAY_CALL_OUTPUT_SCHEMA } from "./outputSchemas.js";
import type { ToolDefinition } from "./tools.js";
import type { ApiResponse } from "./apiResponse.js";

// ── Shared schema fragments ───────────────────────────────────────────────────

const API_ID = {
  type: "string",
  description: "The API id, from zentrixpay_list_apis or zentrixpay_my_apis.",
  examples: ["k3v9x2m1q8w7e6r5t4y3u2i1"],
};

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

const CONFIRM_MAINNET = {
  type: "boolean",
  description: "Required on mainnet. Confirm you intend to spend real USDC. Ignored on testnet.",
} as const;

const CONFIRM_PAID = {
  type: "boolean",
  description:
    "Required when the server runs with ZENTRIXPAY_CONFIRM_PAID_OPERATIONS=usdc or =all. Explicitly confirm this call may spend from the agent wallet.",
} as const;

const API_FIELDS = {
  name: { type: "string", description: "API name.", examples: ["Weather API"] },
  description: {
    type: "string",
    description: "Short description shown in the catalog.",
  },
  upstreamUrl: {
    type: "string",
    description: "The upstream API URL this proxy will forward calls to.",
    examples: ["https://api.provider.com/v1"],
  },
  price: {
    type: "string",
    description: "Per-call price in USDC (decimal string).",
    examples: ["0.01", "0.50"],
  },
  allowedMethods: {
    type: "array",
    items: { type: "string", enum: [...HTTP_METHODS] },
    description: "HTTP methods callers may use.",
    examples: [["GET", "POST"]],
  },
  upstreamHeaderName: {
    type: "string",
    description: "Name of the secret header injected into upstream requests.",
  },
  upstreamHeaderValue: {
    type: "string",
    description: "Value of the secret header (stored encrypted).",
  },
  tags: {
    type: "array",
    items: { type: "string" },
    description: "Discovery tags attached to the API (e.g. ['weather', 'ai']).",
    examples: [["weather"], ["ai", "nlp"]],
  },
  timeoutMs: {
    type: "integer",
    description: "Per-call upstream timeout in milliseconds.",
    examples: [5000, 15000],
  },
  maxResponseBytes: {
    type: "integer",
    description: "Maximum upstream response size in bytes.",
  },
  listed: {
    type: "boolean",
    description: "List or unlist the API in the catalog.",
  },
};

// ── Tool definitions ──────────────────────────────────────────────────────────

export const API_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "zentrixpay_list_apis",
    description:
      "List pay-per-call APIs in the ZentrixPay catalog, newest first. Supports keyword search and tag filtering. Multiple tags are ANDed: all listed tags must be present on the API.",
    inputSchema: {
      type: "object",
      properties: {
        q: {
          type: "string",
          description: "Keyword to search name and description.",
          examples: ["weather"],
        },
        // ?tag=a&tag=b — repeatable; all requested tags must be present on the API.
        tag: {
          type: "array",
          items: { type: "string" },
          description:
            "Filter by tag(s). Repeat for AND semantics: all specified tags must be present on the API. Example: ['ai', 'nlp'] returns only APIs tagged with both 'ai' and 'nlp'.",
          examples: [["weather"], ["ai", "nlp"]],
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          default: 20,
          description: "Maximum number of APIs to return.",
        },
        offset: {
          type: "integer",
          minimum: 0,
          default: 0,
          description: "Number of APIs to skip, for paging.",
        },
      },
      required: [],
    },
    annotations: {
      title: "List APIs",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "zentrixpay_api_info",
    description:
      "Show one API's details: price per call, allowed methods, payee wallet and proxy URL.",
    inputSchema: {
      type: "object",
      properties: { apiId: API_ID },
      required: ["apiId"],
    },
    annotations: {
      title: "API Info",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "zentrixpay_call",
    description:
      "Call a pay-per-call API, paying its per-call price in USDC via x402 from the agent wallet. The caller is not charged when the API returns an error (status >= 400) or times out. Calls above ZENTRIXPAY_MAX_AUTO_PAY_USDC need maxAutoPayUsdc.",
    inputSchema: {
      type: "object",
      properties: {
        apiId: API_ID,
        path: {
          type: "string",
          description: "Path under the API, appended to its base URL.",
          examples: ["/weather/lagos", "users/42"],
        },
        method: {
          type: "string",
          enum: [...HTTP_METHODS],
          default: "GET",
          description: "HTTP method. Must be one the API allows.",
        },
        query: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Query parameters to send.",
          examples: [{ units: "metric" }],
        },
        body: {
          type: ["object", "array", "string"],
          description: "Request body. Objects are sent as JSON; strings are sent as-is.",
        },
        headers: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Extra request headers for the API.",
        },
        maxAutoPayUsdc: {
          type: "string",
          description:
            "Per-call maximum automatic payment in USDC. Required when the price is above ZENTRIXPAY_MAX_AUTO_PAY_USDC.",
        },
        dryRun: {
          type: "boolean",
          description:
            "When true, resolve the request (URL, method, price) and return a preview without making any paid call or spending USDC.",
        },
        confirmPaid: CONFIRM_PAID,
        confirmMainnet: CONFIRM_MAINNET,
      },
      required: ["apiId"],
    },
    outputSchema: ZENTRIXPAY_CALL_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
    annotations: {
      title: "Call API (paid)",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  {
    name: "zentrixpay_register_api",
    description:
      "Register an API to sell per call (requires zentrixpay_register first). Returns the proxy URL and an ownership token: serve it at /.well-known/zentrixpay.txt on the upstream domain, then run zentrixpay_verify_api_ownership to list the API.",
    inputSchema: {
      type: "object",
      properties: { ...API_FIELDS, confirmMainnet: CONFIRM_MAINNET },
      required: ["name", "upstreamUrl", "price"],
    },
    annotations: {
      title: "Register API",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  {
    name: "zentrixpay_update_api",
    description:
      "Update one of your APIs: price, upstream, methods, secret header, limits, health path, webhook, tags, or listing (listed: false hides it from the catalog and stops calls). Pass removeUpstreamHeader, removeWebhook or removeHealthPath: true to clear those settings.",
    inputSchema: {
      type: "object",
      properties: {
        apiId: API_ID,
        ...API_FIELDS,
        removeUpstreamHeader: {
          type: "boolean",
          description: "Delete the stored secret header.",
        },
        removeWebhook: { type: "boolean", description: "Stop sending webhooks for this API." },
        removeHealthPath: {
          type: "boolean",
          description: "Turn off health checks (the API is treated as healthy).",
        },
        confirmMainnet: CONFIRM_MAINNET,
      },
      required: ["apiId"],
    },
    annotations: {
      title: "Update API",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "zentrixpay_verify_api_ownership",
    description:
      "Check that the upstream serves your ownership token at /.well-known/zentrixpay.txt and, if so, list the API in the catalog.",
    inputSchema: {
      type: "object",
      properties: { apiId: API_ID },
      required: ["apiId"],
    },
    annotations: {
      title: "Verify API Ownership",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "zentrixpay_my_apis",
    description:
      "List the APIs you registered, including unlisted ones, upstream URLs and ownership status.",
    inputSchema: { type: "object", properties: {}, required: [] },
    annotations: {
      title: "My APIs",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: "zentrixpay_api_stats",
    description:
      "Usage and earnings for one of your APIs: total and charged calls, USDC revenue, unique payers, average latency and paginated recent calls. Supports optional from/to ISO-8601 date filters and limit/offset pagination.",
    inputSchema: {
      type: "object",
      properties: {
        apiId: API_ID,
        from: {
          type: "string",
          description:
            "Optional start of the date range (inclusive), as YYYY-MM-DD or ISO-8601 timestamp.",
          examples: ["2026-03-01", "2026-03-01T00:00:00Z"],
        },
        to: {
          type: "string",
          description:
            "Optional end of the date range (inclusive), as YYYY-MM-DD or ISO-8601 timestamp.",
          examples: ["2026-03-31", "2026-03-31T23:59:59Z"],
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          default: 50,
          description: "Maximum number of recent calls to return (1–200, default 50).",
        },
        offset: {
          type: "integer",
          minimum: 0,
          default: 0,
          description: "Number of recent calls to skip for pagination (default 0).",
        },
      },
      required: ["apiId"],
    },
    annotations: {
      title: "API Stats",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
];

export const API_TOOL_NAMES = new Set(API_TOOL_DEFINITIONS.map((t) => t.name));

// ── Handler types ─────────────────────────────────────────────────────────────

export interface ApiToolDeps {
  baseUrl: () => string;
  network: () => string;
  /** Authenticated JSON fetch to the ZentrixPay server. */
  jsonFetch: (url: string, init?: RequestInit) => Promise<ApiResponse<any>>;
  /** Returns the current publisher API key, or throws if not registered. */
  requireApiKey: () => string;
  /** Returns the current agent wallet, or throws if not set up. */
  requireWallet: () => { publicKey: string; secretKey: string };
  /** Returns a paid-fetch bound to the given wallet (wraps x402 payment). */
  paidFetch: (wallet: { publicKey: string; secretKey: string }) => typeof fetch;
  /** Throws when the call price would exceed the configured auto-pay ceiling. */
  assertWithinCeiling: (price: string, maxAutoPayUsdc: string | undefined) => void;
  /** Returns an error message string when the wallet lacks enough USDC, null if funded. */
  insufficientFundsMessage: (
    wallet: { publicKey: string; secretKey: string },
    amount: string,
    action: string,
  ) => Promise<string | null>;
  recordPurchase: (purchase: {
    resourceId: string;
    amount: string;
    network: string;
    txHash: string | null;
    receiptRef: null;
    title: string;
  }) => void;
}

export type ApiToolDefinition = (typeof API_TOOL_DEFINITIONS)[number];

// ── Internal helpers ──────────────────────────────────────────────────────────

const MAX_BODY_CHARS = 8_000;

/**
 * Binary content-type prefixes and patterns that should not be decoded as text.
 * When matched, `call()` returns size, type and a base64 payload instead of
 * attempting to render the raw bytes as a string (#101).
 */
const BINARY_CONTENT_TYPE_PATTERNS = [
  /^image\//,
  /^audio\//,
  /^video\//,
  /^application\/pdf/,
  /^application\/zip/,
  /^application\/gzip/,
  /^application\/octet-stream/,
  /^application\/x-tar/,
  /^application\/x-bzip/,
  /^application\/wasm/,
  /^font\//,
];

/** Returns true when `contentType` signals binary (non-text) content. */
function isBinaryContentType(contentType: string | null): boolean {
  if (!contentType) return false;
  const ct = contentType.toLowerCase().split(";")[0].trim();
  return BINARY_CONTENT_TYPE_PATTERNS.some((p) => p.test(ct));
}

function str(args: Record<string, unknown>, key: string, required = false): string | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === "") {
    if (required) throw new Error(`${key} is required`);
    return undefined;
  }
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value;
}

function stringMap(args: Record<string, unknown>, key: string): Record<string, string> {
  const value = args[key];
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") result[k] = v;
  }
  return result;
}

/** Extract the settlement transaction hash from the payment-response header. */
function settlementTx(header: string | null): string | null {
  if (!header) return null;
  try {
    const parsed: unknown = JSON.parse(header);
    if (parsed && typeof parsed === "object") {
      const tx = (parsed as Record<string, unknown>).transaction;
      return typeof tx === "string" ? tx : null;
    }
  } catch {
    // ignore malformed header
  }
  return null;
}

const STATS_DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const STATS_ISO_DATETIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

function parseStatsDateArg(raw: string, bound: "from" | "to"): Date {
  const value = raw.trim();
  const match = STATS_DATE_ONLY_RE.exec(value) ?? STATS_ISO_DATETIME_RE.exec(value);
  if (!match) {
    throw new Error(`${bound} must be a valid ISO-8601 date (YYYY-MM-DD) or timestamp`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    throw new Error(`${bound} must be a valid ISO-8601 date (YYYY-MM-DD) or timestamp`);
  }
  const parsed = STATS_DATE_ONLY_RE.test(value)
    ? new Date(bound === "from" ? `${value}T00:00:00.000Z` : `${value}T23:59:59.999Z`)
    : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${bound} must be a valid ISO-8601 date (YYYY-MM-DD) or timestamp`);
  }
  return parsed;
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

// ── Handler factory ───────────────────────────────────────────────────────────

/**
 * Create the single dispatch function that handles all API tool calls.
 * Receives all external dependencies via injection so the logic can be
 * tested without a live server or wallet.
 *
 * Returns `(name, args) => Promise<string>` (JSON payload) for most tools,
 * throwing on unrecoverable errors so the MCP dispatcher can wrap them as
 * tool errors.
 */
export function createApiToolHandler(
  deps: ApiToolDeps,
): (name: string, args: Record<string, unknown>) => Promise<string> {
  const base = () => deps.baseUrl();

  async function getApi(id: string): Promise<{
    id: string;
    name: string;
    price: string;
    allowedMethods: string[];
    proxyUrl: string;
  }> {
    const res = await deps.jsonFetch(`${base()}/apis/${encodeURIComponent(id)}`);
    if (!res.ok) {
      throw new Error(`API not found: ${id} (HTTP ${res.status})`);
    }
    return res.data as any;
  }

  // ── zentrixpay_list_apis ──────────────────────────────────────────────────

  async function listApis(args: Record<string, unknown>): Promise<string> {
    const url = new URL(`${base()}/apis`);

    const q = str(args, "q");
    if (q) url.searchParams.set("q", q);

    // tag: array of strings — forwards as repeated ?tag= query params.
    // Multiple tags are ANDed server-side (all must match).
    const rawTags = args.tag;
    if (rawTags !== undefined && rawTags !== null) {
      const tags = Array.isArray(rawTags)
        ? rawTags.filter((t) => typeof t === "string")
        : typeof rawTags === "string"
          ? rawTags
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean)
          : [];
      for (const tag of tags) url.searchParams.append("tag", tag);
    }

    const limit = args.limit !== undefined ? Number(args.limit) : 20;
    const offset = args.offset !== undefined ? Number(args.offset) : 0;
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));

    const res = await deps.jsonFetch(url.toString());
    if (!res.ok) throw new Error(`Failed to list APIs (HTTP ${res.status})`);
    return json(res.data);
  }

  // ── zentrixpay_api_info ───────────────────────────────────────────────────

  async function apiInfo(args: Record<string, unknown>): Promise<string> {
    const id = str(args, "apiId", true)!;
    const api = await getApi(id);
    return json(api);
  }

  // ── zentrixpay_call ───────────────────────────────────────────────────────

  async function call(args: Record<string, unknown>): Promise<string> {
    const id = str(args, "apiId", true)!;
    const method = (str(args, "method") ?? "GET").toUpperCase();
    const wallet = deps.requireWallet();

    const api = await getApi(id);
    if (!api.allowedMethods.includes(method)) {
      throw new Error(
        `${api.name} does not accept ${method}; allowed: ${api.allowedMethods.join(", ")}`,
      );
    }

    const path = (str(args, "path") ?? "").replace(/^\/+/, "");
    const url = new URL(`${api.proxyUrl}${path ? `/${path}` : ""}`);
    for (const [k, v] of Object.entries(stringMap(args, "query"))) url.searchParams.append(k, v);

    // Dry-run: return the resolved request details and price without paying.
    if (args.dryRun === true) {
      return json({
        dryRun: true,
        api: { id: api.id, name: api.name },
        request: { method, url: url.toString() },
        price: `${api.price} USDC`,
        note: "No payment was made. Pass dryRun: false (or omit it) to execute the call.",
      });
    }

    deps.assertWithinCeiling(api.price, str(args, "maxAutoPayUsdc"));
    assertWithinSessionSpendLimit({ price: api.price });

    const insufficientMsg = await deps.insufficientFundsMessage(wallet, api.price, "call this API");
    if (insufficientMsg) return insufficientMsg;

    const extraHeaders = stringMap(args, "headers");
    const rawBody = args.body;
    const headers: Record<string, string> = { ...extraHeaders };
    let body: string | undefined;
    if (rawBody !== undefined && rawBody !== null) {
      if (typeof rawBody === "string") {
        body = rawBody;
      } else {
        body = JSON.stringify(rawBody);
        headers["content-type"] = "application/json";
      }
    }

    const paidFetch = deps.paidFetch(wallet);
    const res = await paidFetch(url.toString(), { method, headers, body });
    const contentType = res.headers.get("content-type");
    const charged = res.status < 400;
    const txHash = settlementTx(
      res.headers.get("payment-response") ?? res.headers.get("x-payment-response"),
    );

    let bodyPayload: unknown;
    if (isBinaryContentType(contentType)) {
      // Binary response: return size, type and base64 instead of raw bytes (#101).
      const buffer = await res.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      const base64 = Buffer.from(bytes).toString("base64");
      bodyPayload = {
        encoding: "base64",
        sizeBytes: bytes.byteLength,
        data:
          base64.length > MAX_BODY_CHARS
            ? `${base64.slice(0, MAX_BODY_CHARS)}…[truncated ${base64.length - MAX_BODY_CHARS} base64 chars]`
            : base64,
      };
    } else {
      const text = await res.text();
      bodyPayload =
        text.length > MAX_BODY_CHARS
          ? `${text.slice(0, MAX_BODY_CHARS)}\n…[truncated ${text.length - MAX_BODY_CHARS} chars]`
          : text;
    }

    if (charged) {
      deps.recordPurchase({
        resourceId: api.id,
        amount: api.price,
        network: deps.network(),
        txHash,
        receiptRef: null,
        title: api.name,
      });
      recordSessionSpend(api.price);
    }

    return json({
      api: { id: api.id, name: api.name },
      request: { method, url: url.toString() },
      status: res.status,
      charged,
      amount: charged ? `${api.price} USDC` : "0 USDC (not charged: the call failed)",
      txHash,
      contentType,
      body: bodyPayload,
    });
  }

  // ── Provider management tools ─────────────────────────────────────────────

  async function registerApi(args: Record<string, unknown>): Promise<string> {
    const apiKey = deps.requireApiKey();
    const body: Record<string, unknown> = {
      name: str(args, "name", true),
      upstreamUrl: str(args, "upstreamUrl", true),
      price: str(args, "price", true),
    };
    if (str(args, "description")) body.description = str(args, "description");
    if (Array.isArray(args.allowedMethods)) body.allowedMethods = args.allowedMethods;
    if (Array.isArray(args.tags)) body.tags = args.tags;
    if (args.timeoutMs !== undefined) body.timeoutMs = Number(args.timeoutMs);

    const headerName = str(args, "upstreamHeaderName");
    const headerValue = str(args, "upstreamHeaderValue");
    if (headerName && headerValue) {
      body.upstreamHeader = { name: headerName, value: headerValue };
    } else if (headerName || headerValue) {
      throw new Error("upstreamHeaderName and upstreamHeaderValue must be provided together.");
    }

    const res = await deps.jsonFetch(`${base()}/apis`, {
      method: "POST",
      headers: { "x-api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok)
      throw new Error(`Failed to register API (HTTP ${res.status}): ${JSON.stringify(res.data)}`);
    return json(res.data);
  }

  async function updateApi(args: Record<string, unknown>): Promise<string> {
    const apiKey = deps.requireApiKey();
    const id = str(args, "apiId", true)!;
    const body: Record<string, unknown> = {};

    if (str(args, "name")) body.name = str(args, "name");
    if (str(args, "description") !== undefined) body.description = str(args, "description");
    if (str(args, "upstreamUrl")) body.upstreamUrl = str(args, "upstreamUrl");
    if (str(args, "price")) body.price = str(args, "price");
    if (Array.isArray(args.allowedMethods)) body.allowedMethods = args.allowedMethods;
    if (Array.isArray(args.tags)) body.tags = args.tags;
    if (args.listed !== undefined) body.listed = Boolean(args.listed);
    if (args.timeoutMs !== undefined) body.timeoutMs = Number(args.timeoutMs);
    if (args.removeUpstreamHeader === true) body.upstreamHeader = null;

    const headerName = str(args, "upstreamHeaderName");
    const headerValue = str(args, "upstreamHeaderValue");
    if (headerName && headerValue) {
      body.upstreamHeader = { name: headerName, value: headerValue };
    } else if (headerName || headerValue) {
      throw new Error("upstreamHeaderName and upstreamHeaderValue must be provided together.");
    }

    const res = await deps.jsonFetch(`${base()}/apis/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "x-api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok)
      throw new Error(`Failed to update API (HTTP ${res.status}): ${JSON.stringify(res.data)}`);
    return json(res.data);
  }

  async function verifyApiOwnership(args: Record<string, unknown>): Promise<string> {
    const apiKey = deps.requireApiKey();
    const id = str(args, "apiId", true)!;
    const res = await deps.jsonFetch(`${base()}/apis/${encodeURIComponent(id)}/verify-ownership`, {
      method: "POST",
      headers: { "x-api-key": apiKey },
    });
    if (!res.ok)
      throw new Error(
        `Ownership verification failed (HTTP ${res.status}): ${JSON.stringify(res.data)}`,
      );
    return json(res.data);
  }

  async function myApis(): Promise<string> {
    const apiKey = deps.requireApiKey();
    const res = await deps.jsonFetch(`${base()}/publishers/me/apis`, {
      headers: { "x-api-key": apiKey },
    });
    if (!res.ok) throw new Error(`Failed to list your APIs (HTTP ${res.status})`);
    return json(res.data);
  }

  async function apiStats(args: Record<string, unknown>): Promise<string> {
    const apiKey = deps.requireApiKey();
    const id = str(args, "apiId", true)!;
    const fromRaw = str(args, "from");
    const toRaw = str(args, "to");

    const fromDate = fromRaw ? parseStatsDateArg(fromRaw, "from") : undefined;
    const toDate = toRaw ? parseStatsDateArg(toRaw, "to") : undefined;
    if (fromDate && toDate && fromDate.getTime() > toDate.getTime()) {
      throw new Error("from must be earlier than or equal to to");
    }

    const params = new URLSearchParams();
    if (fromRaw) params.set("from", fromRaw.trim());
    if (toRaw) params.set("to", toRaw.trim());

    if (args.limit !== undefined && args.limit !== null) {
      const limit = Number(args.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
        throw new Error("limit must be an integer between 1 and 200");
      }
      params.set("limit", String(limit));
    }

    if (args.offset !== undefined && args.offset !== null) {
      const offset = Number(args.offset);
      if (!Number.isInteger(offset) || offset < 0) {
        throw new Error("offset must be an integer >= 0");
      }
      params.set("offset", String(offset));
    }

    const qs = params.toString();
    const url = `${base()}/apis/${encodeURIComponent(id)}/stats${qs ? `?${qs}` : ""}`;
    const res = await deps.jsonFetch(url, {
      headers: { "x-api-key": apiKey },
    });
    if (!res.ok) throw new Error(`Failed to get API stats (HTTP ${res.status})`);
    return json(res.data);
  }

  // ── Dispatcher ────────────────────────────────────────────────────────────

  return async function handleApiTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    switch (name) {
      case "zentrixpay_list_apis":
        return listApis(args);
      case "zentrixpay_api_info":
        return apiInfo(args);
      case "zentrixpay_call":
        return call(args);
      case "zentrixpay_register_api":
        return registerApi(args);
      case "zentrixpay_update_api":
        return updateApi(args);
      case "zentrixpay_verify_api_ownership":
        return verifyApiOwnership(args);
      case "zentrixpay_my_apis":
        return myApis();
      case "zentrixpay_api_stats":
        return apiStats(args);
      default:
        throw new Error(`Unknown API tool: ${name}`);
    }
  };
}
