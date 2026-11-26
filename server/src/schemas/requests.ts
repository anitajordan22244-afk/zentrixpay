import { z } from "zod/v4";
import { PASS_DURATION_MAX_MS, PASS_DURATION_MIN_MS } from "../lib/passDuration.js";

export const publisherRegisterSchema = z
  .object({
    name: z.string().min(1),
    email: z.email(),
    walletAddress: z.string().min(1),
  })
  .strict();

// ── Display text: names, descriptions and tags (issue #215) ──────────────────
// These strings appear in the catalog and in MCP output that AI agents read.
// Control characters, bidi overrides and zero-width characters let a name
// spoof another API or smuggle instructions, so they are rejected. Text is
// normalized to NFC first, so visually identical strings compare equal.

// Bidi embedding/override/isolate controls (incl. LRM/RLM/ALM), zero-width joiners and spaces, BOM.
const BIDI_AND_ZERO_WIDTH = /[\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/;

/** C0 and C1 controls. Tab, LF and CR are allowed only where line breaks make sense. */
function hasControlChar(value: string, multiline: boolean): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (multiline && (code === 0x09 || code === 0x0a || code === 0x0d)) continue;
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function hasUnsafeDisplayChars(value: string, multiline: boolean): boolean {
  return hasControlChar(value, multiline) || BIDI_AND_ZERO_WIDTH.test(value);
}

const UNSAFE_TEXT_MESSAGE = "must not contain control, bidi-override or zero-width characters";

/** Plain single-line text: normalized to NFC, no controls or Unicode tricks. */
const displayLine = z
  .string()
  .transform((v) => v.normalize("NFC"))
  .refine((v) => !hasUnsafeDisplayChars(v, false), UNSAFE_TEXT_MESSAGE);

/** Multi-line text (descriptions): tab and line breaks are allowed. */
const displayText = z
  .string()
  .transform((v) => v.normalize("NFC"))
  .refine((v) => !hasUnsafeDisplayChars(v, true), UNSAFE_TEXT_MESSAGE);

export const CATALOG_DEFAULT_LIMIT = 20;
export const CATALOG_MAX_LIMIT = 100;

// ── Pay-per-call APIs ─────────────────────────────────────────────────────────

export const API_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

const usdcPrice = z
  .string()
  .regex(/^\d+(\.\d{1,7})?$/, "price must be a USDC amount with at most 7 decimals")
  .refine((v) => Number(v) > 0, "price must be greater than 0");

const apiPriceRule = z
  .object({
    method: z.enum(API_METHODS),
    pathPattern: z
      .string()
      .min(1)
      .max(512)
      .refine((path) => path.startsWith("/") && !/[?#\\\r\n]/.test(path), {
        message: "pathPattern must be an absolute path without query or fragment",
      }),
    price: usdcPrice,
  })
  .strict();

const apiPriceRules = z
  .array(apiPriceRule)
  .max(100)
  .superRefine((rules, ctx) => {
    const seen = new Set<string>();
    rules.forEach((rule, index) => {
      const key = `${rule.method}:${rule.pathPattern}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: "custom",
          message: "method and pathPattern must be unique",
          path: [index, "pathPattern"],
        });
      }
      seen.add(key);
    });
  });

const stellarAddress = z
  .string()
  .regex(/^G[A-Z2-7]{55}$/, "walletAddress must be a Stellar public key (G...)");

// Headers the proxy itself controls; a provider secret may not use these names.
const RESERVED_HEADER_NAMES = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "upgrade",
  "cookie",
  "x-payment",
  "payment-signature",
]);

const upstreamHeader = z
  .object({
    name: z
      .string()
      .regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/, "header name contains invalid characters")
      .refine((n) => !RESERVED_HEADER_NAMES.has(n.toLowerCase()), "header name is reserved"),
    value: z
      .string()
      .min(1)
      .max(4096)
      .refine((v) => !/[\r\n\0]/.test(v), "header value must not contain line breaks"),
  })
  .strict();

// Query parameter names the proxy may not overwrite with a provider secret.
const upstreamQueryParam = z
  .object({
    name: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9._~-]+$/, "query parameter name contains invalid characters"),
    value: z
      .string()
      .min(1)
      .max(4096)
      .refine((v) => !/[\r\n\0]/.test(v), "query parameter value must not contain line breaks"),
  })
  .strict();

// OpenAPI 3 document: JSON/YAML text or an already-parsed JSON object. Size and
// structure are checked in services/openApiSpec.ts.
const openapiSpec = z.union([z.string().min(1), z.record(z.string(), z.unknown())]);

// Signed with HMAC-SHA256; the secret is shared with the provider's receiver.
const webhook = z
  .object({
    url: z.url(),
    secret: z.string().min(16).max(256),
  })
  .strict();

// Pinged relative to the upstream URL, like a proxied call to /api/:id<healthPath>.
const healthPath = z
  .string()
  .max(512)
  .regex(/^\/[^\s#]*$/, "healthPath must start with / and contain no spaces or fragment");

// The upper bound (PROXY_MAX_RESPONSE_BYTES) is enforced by the service.
const maxResponseBytes = z.number().int().min(1024);

const tagList = z.array(z.string().trim().min(1).max(32).toLowerCase().pipe(displayLine)).max(10);

export const PAYER_LIST_MAX = 500;

const payerList = z
  .array(z.string().regex(/^G[A-Z2-7]{55}$/, "payer lists must hold Stellar public keys (G...)"))
  .max(PAYER_LIST_MAX)
  .transform((list) => [...new Set(list)]);

/** Issue #278: access pass length in milliseconds, 1 hour .. 30 days. */
const passDurationMs = z
  .number()
  .int()
  .min(PASS_DURATION_MIN_MS, "passDurationMs must be at least 1 hour (3600000)")
  .max(PASS_DURATION_MAX_MS, "passDurationMs must be at most 30 days (2592000000)");

export const createApiSchema = z
  .object({
    name: z.string().trim().min(1).max(120).pipe(displayLine),
    description: z.string().max(2000).pipe(displayText).optional(),
    upstreamUrl: z.url(),
    price: usdcPrice,
    priceRules: apiPriceRules.default([]),
    walletAddress: stellarAddress.optional(),
    allowedMethods: z.array(z.enum(API_METHODS)).min(1).default(["GET"]),
    upstreamHeader: upstreamHeader.optional(),
    upstreamQueryParam: upstreamQueryParam.optional(),
    openapiSpec: openapiSpec.optional(),
    timeoutMs: z.number().int().min(1000).optional(),
    maxResponseBytes: maxResponseBytes.optional(),
    webhook: webhook.optional(),
    healthPath: healthPath.optional(),
    tags: tagList.default([]),
    // Only these wallets may call the API; omit to allow everyone.
    payerAllowlist: payerList.optional(),
    payerDenylist: payerList.default([]),
    // Issue #30: price of a time-limited access pass (null/omit = passes not offered).
    passPrice: usdcPrice.optional(),
    // Issue #278: how long a pass lasts, in ms (1 hour .. 30 days; default 1 hour).
    passDurationMs: passDurationMs.optional(),
    // Issue #32: how many free calls a wallet gets per day before the paywall kicks in.
    freeCallsPerDay: z.number().int().min(0).default(0),
  })
  .strict();

export const updateApiSchema = z
  .object({
    name: z.string().trim().min(1).max(120).pipe(displayLine).optional(),
    description: z.string().max(2000).pipe(displayText).nullable().optional(),
    upstreamUrl: z.url().optional(),
    price: usdcPrice.optional(),
    priceRules: apiPriceRules.nullable().optional(),
    walletAddress: stellarAddress.optional(),
    allowedMethods: z.array(z.enum(API_METHODS)).min(1).optional(),
    upstreamHeader: upstreamHeader.nullable().optional(),
    upstreamQueryParam: upstreamQueryParam.nullable().optional(),
    openapiSpec: openapiSpec.nullable().optional(),
    timeoutMs: z.number().int().min(1000).nullable().optional(),
    maxResponseBytes: maxResponseBytes.nullable().optional(),
    webhook: webhook.nullable().optional(),
    healthPath: healthPath.nullable().optional(),
    tags: tagList.optional(),
    // null removes the allowlist, opening the API to every wallet again.
    payerAllowlist: payerList.nullable().optional(),
    payerDenylist: payerList.optional(),
    listed: z.boolean().optional(),
    // Issue #30: null disables passes; a new price enables / reprices them.
    passPrice: usdcPrice.nullable().optional(),
    // Issue #278: how long a pass lasts, in ms (1 hour .. 30 days).
    passDurationMs: passDurationMs.optional(),
    // Issue #32: 0 disables free calls.
    freeCallsPerDay: z.number().int().min(0).optional(),
    // Issue #228: schedule a price change. Both fields together; null cancels a pending change.
    scheduledPrice: usdcPrice.nullable().optional(),
    effectiveAt: z.string().datetime({ offset: true }).nullable().optional(),
  })
  .strict();

export const apiCreditPurchaseSchema = z
  .object({
    calls: z.number().int().min(1).max(10_000),
  })
  .strict();

export const apiCreditBalanceQuerySchema = z
  .object({
    walletAddress: stellarAddress,
  })
  .strict();

export const apiCatalogSortValues = ["newest", "price_asc", "price_desc", "popular"] as const;

export const apiCatalogQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  // ?tag=a&tag=b — repeatable; an API must carry every requested tag.
  tag: z
    .preprocess(
      (v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v]),
      z.array(z.string().trim().min(1).max(32).toLowerCase()).max(10),
    )
    .optional(),
  sort: z.enum(apiCatalogSortValues).default("newest"),
  limit: z.coerce.number().int().min(1).max(CATALOG_MAX_LIMIT).default(CATALOG_DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
});

// ── API stats: date range + pagination (#143) ────────────────────────────────

export const STATS_DEFAULT_LIMIT = 50;
export const STATS_MAX_LIMIT = 100;
/** Longest date range a single stats request may cover. */
export const STATS_MAX_RANGE_DAYS = 366;
const DAY_MS = 24 * 60 * 60 * 1000;

/** ISO-8601 date (`2026-01-31`) or date-time (`2026-01-31T12:00:00Z`). */
const isoDateOrDateTime = z
  .string()
  .trim()
  .refine((v) => /^\d{4}-\d{2}-\d{2}(T.*)?$/.test(v) && !Number.isNaN(Date.parse(v)), {
    message: "must be an ISO-8601 date or date-time",
  })
  .transform((v) => new Date(v));

/**
 * Query for GET /apis/:id/stats. `from` is inclusive and `to` is exclusive, so
 * consecutive ranges never double-count a call. The same range is applied to
 * the aggregates and to the paged call history.
 */
export const apiStatsQuerySchema = z
  .object({
    from: isoDateOrDateTime.optional(),
    to: isoDateOrDateTime.optional(),
    limit: z.coerce.number().int().min(1).max(STATS_MAX_LIMIT).default(STATS_DEFAULT_LIMIT),
    offset: z.coerce.number().int().min(0).max(100_000).default(0),
  })
  .strict()
  .superRefine((q, ctx) => {
    // Field-level issues are reported on their own; only compare valid dates.
    if (!(q.from === undefined || q.from instanceof Date)) return;
    if (!(q.to === undefined || q.to instanceof Date)) return;
    if (q.from && q.to && q.from.getTime() > q.to.getTime()) {
      ctx.addIssue({ code: "custom", path: ["from"], message: "from must not be after to" });
    }
    const start = q.from?.getTime();
    const end = q.to?.getTime() ?? Date.now();
    if (start !== undefined && end - start > STATS_MAX_RANGE_DAYS * DAY_MS) {
      ctx.addIssue({
        code: "custom",
        path: ["from"],
        message: `range must not exceed ${STATS_MAX_RANGE_DAYS} days`,
      });
    }
  });

export type ApiStatsQuery = z.infer<typeof apiStatsQuerySchema>;

export const payerCallsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(STATS_MAX_LIMIT).default(STATS_DEFAULT_LIMIT),
    offset: z.coerce.number().int().min(0).max(100_000).default(0),
  })
  .strict();

export type PayerCallsQuery = z.infer<typeof payerCallsQuerySchema>;
