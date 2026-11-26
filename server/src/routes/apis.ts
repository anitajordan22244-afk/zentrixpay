import { createHash, randomUUID } from "node:crypto";
import express, {
  Router,
  type NextFunction,
  type Router as RouterType,
  type Request,
  type Response,
} from "express";
import multer from "multer";
import { apiKeyAuth } from "../middleware/apiKeyAuth.js";
import { writeCallsCsv } from "../services/apiCallsExport.js";
import { requestSignatureAuth } from "../middleware/requestSignatureAuth.js";
import { payeeSignatureAuth } from "../middleware/payeeSignatureAuth.js";
import { walletSignatureAuth } from "../middleware/walletSignatureAuth.js";
import { validate } from "../middleware/validate.js";
import { publishIpRateLimit, publishWalletRateLimit } from "../middleware/rateLimiters.js";
import { ownershipVerifyRateLimit } from "../middleware/ownershipVerifyRateLimit.js";
import { spendSignedApiCredit } from "../middleware/apiCreditSpend.js";
import {
  apiPaywall,
  checkPayerAccess,
  checkPayerAllowDeny,
  loadProxiedApi,
} from "../middleware/apiPaywall.js";
import { createIpRateLimiter } from "../middleware/rateLimit.js";
import { getRateLimitStore } from "../lib/rateLimit/index.js";
import {
  apiCreditBalanceQuerySchema,
  apiCreditPurchaseSchema,
  apiCatalogQuerySchema,
  apiStatsQuerySchema,
  createApiSchema,
  payerCallsQuerySchema,
  updateApiSchema,
} from "../schemas/requests.js";
import {
  ApiServiceError,
  archiveApi,
  createApi,
  effectiveMaxResponseBytes,
  getApiById,
  getApiStats,
  getApiTimeSeries,
  getOwnedApi,
  listPublicApis,
  listPayerCalls,
  listPublisherApis,
  listRecentCalls,
  recordApiCall,
  toOwnerApi,
  toPublicApi,
  toPublicOpenApi,
  updateApi,
  verifyOwnership,
  type ApiRow,
} from "../services/apiService.js";
import { getApiCreditBalance, purchaseApiCredits } from "../services/apiCredits.js";
import { listPayerEntitlements } from "../services/payerEntitlements.js";
import { statsPagination } from "../services/apiStatsQuery.js";
import { apiCreditPurchaseReference } from "../lib/apiCreditSignature.js";
import {
  confirmApiPrice,
  confirmApiRegistration,
  prepareApiPrice,
  prepareApiRegistration,
} from "../services/apiOnchain.js";
import { confirmCallRefund, prepareCallRefund } from "../services/apiRefunds.js";
import {
  sendUpstream,
  streamUpstream,
  UPSTREAM_ERROR_CODES,
  UpstreamError,
} from "../lib/upstreamClient.js";
import { filterRequestHeaders, filterResponseHeaders } from "../lib/proxyHeaders.js";
import { paymentHeader, paymentHeaderHash, payerFromPayment } from "../lib/payer.js";
import { buyAccessPass } from "./accessPassPurchase.js";
import {
  getProxyIdempotencyStore,
  type ProxyIdempotencyKey,
  type StoredProxyResponse,
} from "../lib/idempotency.js";
import { chargedCallWebhookEntry } from "../services/webhookService.js";
import { decryptSecret } from "../utils/secretBox.js";
import { stroopsToUsdc, usdcToStroops } from "../utils/usdc.js";
import { minimizeCallPath } from "../lib/callPath.js";
import { getLogger } from "../lib/logger.js";
import { withSpan } from "../lib/spans.js";
import {
  gatewayChargedCalls,
  gatewayCreditSpends,
  gatewayProxiedCalls,
  gatewayUpstreamDuration,
} from "../lib/metrics.js";
import { config, upstreamKeyRing } from "../config.js";
import { ProxyBufferSemaphore, proxyBufferConcurrency } from "../middleware/proxyBuffer.js";
import { importBulkOpenApi, previewBulkOpenApi } from "../services/openApiImport.js";
import { OpenApiSpecTooLargeError } from "../services/openApiSpec.js";
import { proxyTrackingMiddleware } from "../middleware/proxyTracking.js";

const router = Router();
const openApiUpload = multer({ limits: { fileSize: 512 * 1024, files: 1 } });

function apiCreditBundlePrice(api: ApiRow, calls: number): string {
  const highestCallPrice = (api.priceRules ?? []).reduce((highest, rule) => {
    const rulePrice = usdcToStroops(rule.price);
    return rulePrice > highest ? rulePrice : highest;
  }, usdcToStroops(api.price));
  return stroopsToUsdc(highestCallPrice * BigInt(calls));
}

function sendServiceError(res: Response, err: unknown): void {
  if (err instanceof ApiServiceError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  throw err;
}

// ── Management ────────────────────────────────────────────────────────────────

// POST /apis/import/preview — validate and group an OpenAPI JSON/YAML document without writes.
router.post(
  "/apis/import/preview",
  apiKeyAuth,
  openApiUpload.single("document"),
  async (req, res) => {
    const raw = req.file?.buffer.toString("utf8") ?? req.body?.document ?? req.body?.openapiSpec;
    if (!raw) {
      res
        .status(400)
        .json({ error: "Provide document as JSON/YAML text, document, or openapiSpec" });
      return;
    }
    const result = previewBulkOpenApi(raw);
    // Issue #214: oversized documents are 413; other validation failures stay 422.
    res
      .status(result.tooLarge ? 413 : result.errors.length > 0 ? 422 : 200)
      .json({ groups: result.groups, errors: result.errors });
  },
);

// POST /apis/import — confirm selected preview groups and register them atomically.
router.post("/apis/import", apiKeyAuth, openApiUpload.single("document"), async (req, res) => {
  const raw = req.file?.buffer.toString("utf8") ?? req.body?.document ?? req.body?.openapiSpec;
  const defaults = req.body?.defaults ?? req.body;
  if (!raw || typeof defaults?.price !== "string") {
    res.status(400).json({
      error:
        "document and defaults.price are required; walletAddress defaults to the publisher wallet",
    });
    return;
  }
  const selected = Array.isArray(req.body?.groups) ? req.body.groups : undefined;
  try {
    const result = await importBulkOpenApi(req.publisher!.id, raw, selected, {
      price: defaults.price,
      walletAddress: defaults.walletAddress ?? req.publisher!.walletAddress,
      description: defaults.description,
    });
    res.status(201).json(result);
  } catch (error) {
    res
      .status(error instanceof OpenApiSpecTooLargeError ? 413 : 422)
      .json({ error: error instanceof Error ? error.message : "OpenAPI import failed" });
  }
});

// POST /apis — register an API to sell per call (authenticated)
router.post(
  "/apis",
  apiKeyAuth,
  publishIpRateLimit,
  publishWalletRateLimit,
  requestSignatureAuth,
  validate(createApiSchema),
  async (req, res) => {
    const publisher = req.publisher!;
    try {
      const api = await createApi({
        ...req.body,
        publisherId: publisher.id,
        walletAddress: req.body.walletAddress ?? publisher.walletAddress,
      });
      const owner = toOwnerApi(api);
      res.status(201).json({
        ...owner,
        nextStep:
          `Serve "${owner.ownershipVerification.expectedContent}" at ` +
          `${owner.ownershipVerification.url}, then POST /apis/${api.id}/verify-ownership. ` +
          `Register it on-chain with GET /apis/${api.id}/register/prepare and ` +
          `POST /apis/${api.id}/register to list the API.`,
      });
    } catch (err) {
      sendServiceError(res, err);
    }
  },
);

// GET /apis — public catalog of listed APIs
router.get("/apis", async (req, res) => {
  const parsed = apiCatalogQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.format() });
    return;
  }
  res.json(await listPublicApis(parsed.data));
});

// GET /publishers/me/apis — the caller's own APIs, listed or not
router.get("/publishers/me/apis", apiKeyAuth, async (req, res) => {
  res.json(await listPublisherApis(req.publisher!.id));
});

// GET /apis/:id — public details of a listed API
router.get("/apis/:id", async (req, res) => {
  const api = await getApiById(req.params.id);
  if (!api || !api.listed) {
    res.status(404).json({ error: "API not found" });
    return;
  }
  res.json(toPublicApi(api));
});

// GET /apis/:id/openapi.json — the API's OpenAPI document, pointed at the proxy
router.get("/apis/:id/openapi.json", async (req, res) => {
  const api = await getApiById(req.params.id);
  const spec = api?.listed ? toPublicOpenApi(api) : null;
  if (!spec) {
    res.status(404).json({ error: "No OpenAPI document for this API" });
    return;
  }
  res.json(spec);
});

// PATCH /apis/:id — update price, upstream, methods, secret header, listing (owner)
// Changing walletAddress additionally requires a signature from the current payee wallet
// (X-Payee-Timestamp + X-Payee-Signature headers) to prevent a compromised API key
// from silently redirecting all revenue to an attacker-controlled address.
router.patch(
  "/apis/:id",
  apiKeyAuth,
  requestSignatureAuth,
  // Load the API and stash it in res.locals.api so payeeSignatureAuth can read
  // the current walletAddress without a second DB round-trip in the handler.
  async (req, res, next) => {
    try {
      const api = await getOwnedApi(req.params.id as string, req.publisher!.id);
      res.locals.api = api;
      next();
    } catch (err) {
      sendServiceError(res, err);
    }
  },
  validate(updateApiSchema),
  payeeSignatureAuth,
  async (req, res) => {
    try {
      const api = res.locals.api as ApiRow;
      res.json(toOwnerApi(await updateApi(api, req.body)));
    } catch (err) {
      sendServiceError(res, err);
    }
  },
);

// DELETE /apis/:id — archive (soft-delete): unlist and hide the API, keep its call history (owner)
router.delete("/apis/:id", apiKeyAuth, requestSignatureAuth, async (req, res) => {
  try {
    const api = await getOwnedApi(req.params.id as string, req.publisher!.id);
    const archived = await archiveApi(api);
    res.json({ id: archived.id, archived: true, archivedAt: archived.archivedAt });
  } catch (err) {
    sendServiceError(res, err);
  }
});

// POST /apis/:id/verify-ownership — check /.well-known/zentrixpay.txt, then list (owner).
// Rate-limited per provider and per API: each call makes outbound HTTP/DNS requests (#289).
router.post(
  "/apis/:id/verify-ownership",
  apiKeyAuth,
  requestSignatureAuth,
  ...ownershipVerifyRateLimit,
  async (req, res) => {
    try {
      const api = await getOwnedApi(req.params.id as string, req.publisher!.id);
      res.json(toOwnerApi(await verifyOwnership(api)));
    } catch (err) {
      sendServiceError(res, err);
    }
  },
);

// GET /apis/:id/stats?from=&to=&limit=&offset= — call counts, revenue and paged call
// history for one window (owner; archived APIs included). `from` is inclusive and
// `to` exclusive; the same window applies to the totals and to recentCalls (#143).
router.get("/apis/:id/stats", apiKeyAuth, async (req, res) => {
  const query = apiStatsQuerySchema.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.format() });
    return;
  }
  const { from, to, limit, offset } = query.data;
  try {
    const api = await getOwnedApi(req.params.id as string, req.publisher!.id, {
      includeArchived: true,
    });
    const [totals, recentCalls] = await Promise.all([
      getApiStats(api.id, { from, to }),
      listRecentCalls(api.id, { from, to, limit, offset }),
    ]);
    res.json({
      apiId: api.id,
      archivedAt: api.archivedAt,
      range: { from: from?.toISOString() ?? null, to: to?.toISOString() ?? null },
      ...totals,
      recentCalls,
      pagination: statsPagination(limit, offset, recentCalls.length, totals.calls),
    });
  } catch (err) {
    sendServiceError(res, err);
  }
});

// GET /apis/:id/calls.csv?from&to — streamed CSV of the call history (owner only)
router.get("/apis/:id/calls.csv", apiKeyAuth, async (req, res) => {
  const query = apiStatsQuerySchema.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.format() });
    return;
  }
  let api;
  try {
    api = await getOwnedApi(req.params.id as string, req.publisher!.id, { includeArchived: true });
  } catch (err) {
    sendServiceError(res, err);
    return;
  }
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="api-${api.id}-calls.csv"`);
  res.setHeader("Cache-Control", "no-store");
  res.flushHeaders();
  try {
    await writeCallsCsv(res, api.id, { from: query.data.from, to: query.data.to });
    res.end();
  } catch (err) {
    getLogger().error(
      { event: "api_calls_export_failed", apiId: api.id, err },
      "CSV export failed",
    );
    res.destroy(err instanceof Error ? err : undefined);
  }
});

// GET /apis/:id/stats/time-series?days=7|30|90 — per-day calls and revenue (owner)
router.get("/apis/:id/stats/time-series", apiKeyAuth, async (req, res) => {
  try {
    const api = await getOwnedApi(req.params.id as string, req.publisher!.id);
    const rawDays = Number(req.query.days);
    const days = [7, 30, 90].includes(rawDays) ? (rawDays as 7 | 30 | 90) : 30;
    const series = await getApiTimeSeries(api.id, days);
    res.json({ apiId: api.id, days, series });
  } catch (err) {
    sendServiceError(res, err);
  }
});

// GET /payers/:address/calls — receipts for the calls a wallet paid for (paged).
// Signed by that wallet (X-Wallet-Timestamp + X-Wallet-Signature): call
// history is private to the payer.
router.get("/payers/:address/calls", walletSignatureAuth, async (req, res) => {
  const address = req.params.address as string;
  const query = payerCallsQuerySchema.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.format() });
    return;
  }
  const { limit, offset } = query.data;
  const { calls, hasMore } = await listPayerCalls(address, { limit, offset });
  res.json({
    payer: address,
    calls,
    limit,
    offset,
    nextOffset: hasMore ? offset + limit : null,
  });
});

// GET /payers/:address/entitlements — the wallet's active passes (API, expiry)
// and prepaid credit balances per API. Signed by that wallet (#292).
router.get("/payers/:address/entitlements", walletSignatureAuth, async (req, res) => {
  const entitlements = await listPayerEntitlements(req.params.address as string);
  res.setHeader("Cache-Control", "private, no-store");
  res.json(entitlements);
});

// ── Paid proxy ────────────────────────────────────────────────────────────────

/** Extract clean path segments from req.params.path (string or string array). */
export function extractPathSegments(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.flatMap((item) => (typeof item === "string" ? item.split("/").filter(Boolean) : []));
  }
  if (typeof raw === "string") {
    return raw.split("/").filter(Boolean);
  }
  return [];
}

/**
 * Map /api/:id/<segments>?<query> onto the API's upstream URL.
 * Validates that the normalized request target stays strictly within the
 * selected API's configured boundary (origin + base pathname).
 * Returns null if any segment attempts traversal, contains invalid characters,
 * or resolves outside the API's boundary.
 */
export function buildUpstreamUrl(
  upstreamUrl: string,
  segments: string[],
  originalUrl: string,
): URL | null {
  let base: URL;
  try {
    base = new URL(upstreamUrl);
  } catch {
    return null;
  }

  // Refuse anything that could climb out of the upstream base path,
  // smuggle a separator, or introduce null bytes or control characters.
  for (const s of segments) {
    if (typeof s !== "string") return null;

    let decoded: string;
    try {
      decoded = decodeURIComponent(s);
    } catch {
      return null;
    }

    if (
      s === "." ||
      s === ".." ||
      decoded === "." ||
      decoded === ".." ||
      s.includes("/") ||
      s.includes("\\") ||
      decoded.includes("/") ||
      decoded.includes("\\") ||
      s.includes("\0") ||
      decoded.includes("\0") ||
      /%2e/i.test(s) ||
      /%252e/i.test(s)
    ) {
      return null;
    }
  }

  const basePath = base.pathname.replace(/\/+$/, "");
  const subPath = segments.map(encodeURIComponent).join("/");
  const target = new URL(base.origin);
  const targetPath = subPath ? `${basePath}/${subPath}` : basePath || "/";

  // Strict origin check: must match the configured upstream origin
  if (target.origin !== base.origin) {
    return null;
  }

  // Strict boundary check: normalized target must remain inside the API's configured basePath
  if (basePath && basePath !== "/") {
    if (targetPath !== basePath && !targetPath.startsWith(`${basePath}/`)) {
      return null;
    }
  }

  target.pathname = targetPath;

  // Preserve upstream URL's existing query parameters while appending caller-supplied query
  const queryStart = originalUrl.indexOf("?");
  const requestQuery = queryStart === -1 ? "" : originalUrl.slice(queryStart + 1);
  target.search = [base.search.slice(1), requestQuery].filter(Boolean).join("&");

  return target;
}

function decodeQueryPart(part: string): string {
  try {
    return decodeURIComponent(part.replace(/\+/g, " "));
  } catch {
    return part;
  }
}

interface SettlementInfo {
  payer?: string;
  transaction?: string;
}

/** The settlement the x402 middleware reported on the response, if any. */
function settlementFrom(res: Response): SettlementInfo {
  const header = res.getHeader("payment-response") ?? res.getHeader("x-payment-response");
  if (typeof header !== "string") return {};
  try {
    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    return {
      payer: typeof decoded?.payer === "string" ? decoded.payer : undefined,
      transaction:
        typeof decoded?.transaction === "string" && decoded.transaction
          ? decoded.transaction
          : undefined,
    };
  } catch {
    return {};
  }
}

function payerFrom(req: Request, settlement: SettlementInfo): string {
  return settlement.payer ?? payerFromPayment(paymentHeader(req)).address ?? "unknown";
}

const UPSTREAM_ERROR_STATUS = { blocked: 502, network: 502, too_large: 502, timeout: 504 } as const;

/**
 * Set the provider's secret query parameter on the upstream URL. Any value the
 * caller sent under the same name is dropped so it cannot override the
 * provider's key. The rest of the query string is left byte-for-byte as sent.
 */
export function withSecretQueryParam(target: URL, name: string, value: string): URL {
  const kept = target.search
    .slice(1)
    .split("&")
    .filter((pair) => pair && decodeQueryPart(pair.split("=")[0]) !== name);
  kept.push(`${encodeURIComponent(name)}=${encodeURIComponent(value)}`);
  target.search = kept.join("&");
  return target;
}

export interface UpstreamSecrets {
  queryName?: string;
  values: string[];
}

/** Remove a secret query parameter (by name or by value) from a URL-ish string. */
function stripSecretParam(value: string, secrets: UpstreamSecrets): string {
  const queryStart = value.indexOf("?");
  if (queryStart === -1) return value;
  const hashStart = value.indexOf("#", queryStart);
  const query = value.slice(queryStart + 1, hashStart === -1 ? undefined : hashStart);
  const kept = query.split("&").filter((pair) => {
    if (!pair) return false;
    const [rawKey, ...rest] = pair.split("=");
    const key = decodeQueryPart(rawKey);
    return key !== secrets.queryName && !secrets.values.includes(decodeQueryPart(rest.join("=")));
  });
  return (
    value.slice(0, queryStart) +
    (kept.length ? `?${kept.join("&")}` : "") +
    (hashStart === -1 ? "" : value.slice(hashStart))
  );
}

/** Replace any literal (or URL-encoded) occurrence of a secret value. */
function redactSecrets(value: string, secrets: UpstreamSecrets): string {
  let out = value;
  for (const secret of secrets.values) {
    if (secret.length < 4) continue;
    for (const form of new Set([secret, encodeURIComponent(secret)])) {
      out = out.split(form).join("[redacted]");
    }
  }
  return out;
}

// Response headers that carry URLs; secret query parameters are removed from these.
const URL_HEADERS = new Set(["location", "content-location", "link", "refresh"]);

/**
 * Rewrite or suppress a redirect target pointing to the configured upstream origin.
 * - If the redirect points to the configured upstream origin and falls within the
 *   API's configured base path, it is rewritten to the gateway proxy:
 *   `${config.BASE_URL}/api/${api.id}${subpath}`
 * - If the redirect points to the configured upstream origin but falls outside the
 *   API's configured base path, it is suppressed (returns null) so responses do not
 *   disclose private upstream origin details to callers.
 * - If the redirect points to an unrelated external destination, it is preserved as-is.
 */
export function rewriteOrSuppressRedirect(
  location: string,
  api: Pick<ApiRow, "id" | "upstreamUrl">,
): string | null {
  let base: URL;
  try {
    base = new URL(api.upstreamUrl);
  } catch {
    return null;
  }

  // Base directory with trailing slash for resolving relative subpaths accurately
  const baseDir = new URL(
    base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`,
    base.origin,
  );

  let target: URL;
  try {
    target = new URL(location, baseDir);
  } catch {
    return null;
  }

  const isUpstreamOrigin = target.origin.toLowerCase() === base.origin.toLowerCase();

  if (isUpstreamOrigin) {
    const basePath = base.pathname.replace(/\/+$/, "");
    const targetPath = target.pathname.replace(/\/+$/, "");

    const isWithinBoundary =
      !basePath ||
      basePath === "/" ||
      targetPath === basePath ||
      target.pathname.startsWith(`${basePath}/`);

    if (isWithinBoundary) {
      const subpath =
        basePath && basePath !== "/" ? target.pathname.slice(basePath.length) : target.pathname;
      const cleanSubpath = subpath ? (subpath.startsWith("/") ? subpath : `/${subpath}`) : "";
      return `${config.BASE_URL}/api/${api.id}${cleanSubpath}${target.search}${target.hash}`;
    }

    // Redirect points to the upstream origin but outside its base path:
    // Suppress it to prevent disclosing private upstream origin details.
    return null;
  }

  // Preserves redirects to unrelated external destinations according to policy
  return location;
}

/**
 * Prepare an upstream response header for the caller: rewrite or suppress upstream URLs,
 * preserve external destinations, and make sure no provider secret is echoed back.
 */
export function rewriteResponseHeader(
  name: string,
  value: string,
  api: ApiRow,
  secrets: UpstreamSecrets,
): string | null {
  const lowerName = name.toLowerCase();
  let out = value;

  if (lowerName === "location" || lowerName === "content-location") {
    const rewritten = rewriteOrSuppressRedirect(out, api);
    if (!rewritten) return null;
    out = rewritten;
  }

  if (URL_HEADERS.has(lowerName)) {
    out = stripSecretParam(out, secrets);
  }

  return redactSecrets(out, secrets);
}

/** Build and inject upstream secrets into headers/url, returning the secrets manifest. */
function prepareUpstreamRequest(
  api: ApiRow,
  target: URL,
  reqHeaders: ReturnType<typeof filterRequestHeaders>,
): UpstreamSecrets {
  const secrets: UpstreamSecrets = { values: [] };
  if (api.upstreamHeaderName && api.upstreamHeaderValueEnc && upstreamKeyRing.length > 0) {
    const value = decryptSecret(
      api.upstreamHeaderValueEnc,
      upstreamKeyRing,
      config.UPSTREAM_SECRET_KEY,
    );
    reqHeaders[api.upstreamHeaderName] = value;
    secrets.values.push(value);
  }
  if (api.upstreamQueryName && api.upstreamQueryValueEnc && upstreamKeyRing.length > 0) {
    const value = decryptSecret(
      api.upstreamQueryValueEnc,
      upstreamKeyRing,
      config.UPSTREAM_SECRET_KEY,
    );
    withSecretQueryParam(target, api.upstreamQueryName, value);
    secrets.queryName = api.upstreamQueryName;
    secrets.values.push(value);
  }
  return secrets;
}

/**
 * Validate that caller-supplied sub-path stays strictly within the selected API's
 * boundary and contains no path traversal or separator smuggling.
 * Runs early in the proxy middleware pipeline before charging or buffering.
 */
export function validateProxyPath(req: Request, res: Response, next: NextFunction): void {
  const api = res.locals.api as ApiRow;
  if (!api) {
    res.status(404).json({ error: "API not found" });
    return;
  }
  const segments = extractPathSegments(req.params.path);
  const target = buildUpstreamUrl(api.upstreamUrl, segments, req.originalUrl);
  if (!target) {
    res.status(400).json({ error: "Invalid path", code: "invalid_path" });
    return;
  }
  res.locals.upstreamTarget = target;
  next();
}

async function proxyHandler(req: Request, res: Response) {
  const api = res.locals.api as ApiRow;
  const segments = extractPathSegments(req.params.path);
  const target =
    (res.locals.upstreamTarget as URL | undefined) ??
    buildUpstreamUrl(api.upstreamUrl, segments, req.originalUrl);
  if (!target) {
    res.status(400).json({ error: "Invalid path", code: "invalid_path" });
    return;
  }

  const headers = filterRequestHeaders(req.headers);
  const secrets = prepareUpstreamRequest(api, target, headers);
  const body = Buffer.isBuffer(req.body) && req.body.length > 0 ? req.body : undefined;

  const started = Date.now();

  // Recorded once the response (and settlement) is complete: a final status
  // below 400 means the x402 middleware settled the payment.
  res.on("finish", () => {
    const settlement = settlementFrom(res);
    const charged = res.statusCode < 400;
    gatewayProxiedCalls.inc({ status_class: `${Math.floor(res.statusCode / 100)}xx` });
    gatewayChargedCalls.inc({ charged: String(charged) });
    if (charged && res.locals.creditPayer) gatewayCreditSpends.inc();
    const callId = randomUUID();
    const payerAddress =
      (res.locals.creditPayer as string | undefined) ??
      // Verified wallet of a pass or free-quota call (#276).
      (res.locals.accessPayer as string | undefined) ??
      payerFrom(req, settlement);
    const amount = (res.locals.apiCallPrice as string | undefined) ?? api.price;
    // Stored minimized: identifiers and the query string are dropped (#144).
    const path = minimizeCallPath(
      target.pathname.slice(new URL(api.upstreamUrl).pathname.replace(/\/+$/, "").length) || "/",
    );
    const durationMs = Date.now() - started;
    recordApiCall({
      callId,
      apiId: api.id,
      charged,
      payerAddress,
      amount,
      method: req.method,
      path,
      txHash: settlement.transaction ?? null,
      responseStatus: res.statusCode,
      durationMs,
      // Charged-call webhook goes to the outbox in the same transaction (#208).
      webhook: charged
        ? chargedCallWebhookEntry(api, {
            callId,
            payerAddress,
            amount,
            method: req.method,
            path,
            responseStatus: res.statusCode,
            durationMs,
          })
        : undefined,
    }).catch((err) =>
      // Only reached when the recovery spool itself could not be written (#134).
      getLogger().error(
        { event: "api_call_record_lost", apiId: api.id, callId, err },
        "failed to record or spool API call",
      ),
    );
  });

  const upstreamOpts = {
    url: target,
    method: req.method,
    headers,
    body,
    timeoutMs: api.timeoutMs ?? config.PROXY_DEFAULT_TIMEOUT_MS,
    maxResponseBytes: effectiveMaxResponseBytes(api),
    allowPrivate: config.PROXY_ALLOW_PRIVATE_UPSTREAMS,
  };

  // ── Streaming path (SSE / chunked) ─────────────────────────────────────────
  // settle-before-stream: the x402 middleware already collected payment before
  // this handler runs. If the upstream fails before the first byte we never
  // write a 2xx status to the caller, so the caller is not charged
  // (see the "finish" listener above — charged = statusCode < 400).
  if ("streamingEnabled" in api && api.streamingEnabled) {
    let upstream;
    try {
      upstream = await streamUpstream(upstreamOpts);
    } catch (err) {
      if (err instanceof UpstreamError) {
        getLogger().warn(
          {
            event: "api_upstream_stream_failed",
            apiId: api.id,
            kind: err.kind,
            error: err.message,
          },
          "upstream stream failed before first byte; caller not charged",
        );
        res.status(UPSTREAM_ERROR_STATUS[err.kind]).json({
          error: "upstream_failed",
          reason: err.kind,
          code: UPSTREAM_ERROR_CODES[err.kind],
        });
        return;
      }
      throw err;
    }

    // Mirror useful response headers (no buffering, no content-length).
    const responseHeaders = filterResponseHeaders(upstream.headers);
    res.status(upstream.status);
    for (const [name, value] of Object.entries(responseHeaders)) {
      if (typeof value === "string") {
        const rewritten = rewriteResponseHeader(name, value, api, secrets);
        if (rewritten !== null) res.setHeader(name, rewritten);
      } else if (Array.isArray(value)) {
        const rewritten = value
          .map((v) => (typeof v === "string" ? rewriteResponseHeader(name, v, api, secrets) : v))
          .filter((v): v is string => v !== null);
        if (rewritten.length > 0) res.setHeader(name, rewritten);
      } else {
        res.setHeader(name, value);
      }
    }

    // For SSE: disable compression / buffering on the Express response so
    // events reach the caller immediately.
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    upstream.stream.pipe(res);

    upstream.stream.on("error", (err) => {
      getLogger().warn(
        { event: "api_upstream_stream_error", apiId: api.id, error: err.message },
        "upstream stream error mid-flight",
      );
      if (!res.writableEnded) res.end();
    });

    req.on("close", () => {
      // Client disconnected early — destroy the upstream socket too.
      upstream.stream.destroy();
    });

    return;
  }

  // ── Buffered path (default) ─────────────────────────────────────────────────
  let upstream;
  const upstreamStarted = performance.now();
  try {
    upstream = await withSpan("upstream.call", { "zentrixpay.api.id": api.id }, () =>
      sendUpstream(upstreamOpts),
    );
    gatewayUpstreamDuration.observe((performance.now() - upstreamStarted) / 1000);
  } catch (err) {
    gatewayUpstreamDuration.observe((performance.now() - upstreamStarted) / 1000);
    if (err instanceof UpstreamError) {
      getLogger().warn(
        { event: "api_upstream_failed", apiId: api.id, kind: err.kind, error: err.message },
        "upstream call failed; caller not charged",
      );
      res
        .status(UPSTREAM_ERROR_STATUS[err.kind])
        .json({ error: "upstream_failed", reason: err.kind, code: UPSTREAM_ERROR_CODES[err.kind] });
      return;
    }
    throw err;
  }

  const responseHeaders: StoredProxyResponse["headers"] = {};
  for (const [name, value] of Object.entries(filterResponseHeaders(upstream.headers))) {
    if (typeof value === "string") {
      const rewritten = rewriteResponseHeader(name, value, api, secrets);
      if (rewritten !== null) responseHeaders[name] = rewritten;
    } else if (Array.isArray(value)) {
      const rewritten = value
        .map((v) => (typeof v === "string" ? rewriteResponseHeader(name, v, api, secrets) : v))
        .filter((v): v is string => v !== null);
      if (rewritten.length > 0) responseHeaders[name] = rewritten;
    } else {
      responseHeaders[name] = value;
    }
  }
  // Kept for Idempotency-Key replay once the call is known to be charged.
  res.locals.proxyResponse = {
    status: upstream.status,
    headers: responseHeaders,
    body: upstream.body,
  } satisfies StoredProxyResponse;

  const completeProxyIdempotency = res.locals.completeProxyIdempotency as
    ((response: StoredProxyResponse) => Promise<void>) | undefined;
  if (completeProxyIdempotency && upstream.status < 400) {
    res.locals.preserveProxyIdempotencyClaim = true;
    await completeProxyIdempotency({
      status: upstream.status,
      headers: responseHeaders,
      body: upstream.body,
    });
  }

  res.status(upstream.status);
  for (const [name, value] of Object.entries(responseHeaders)) res.setHeader(name, value);
  // res.end, not res.send: send() would add an ETag and could turn the reply
  // into a bodiless 304 that still counts as a successful (charged) call.
  res.setHeader("Content-Length", String(upstream.body.length));
  res.end(upstream.body);
}

// Issue #33: IP rate limiter for the proxy route. Applied before loadProxiedApi
// so the DB is never touched when an IP is over the limit.
const proxyIpRateLimit = createIpRateLimiter(
  getRateLimitStore(),
  "proxy",
  config.PROXY_402_RATE_LIMIT_MAX,
  config.PROXY_402_RATE_LIMIT_WINDOW_MS,
  "proxy_ip",
);

// Issue #132: limit concurrent buffered proxy responses so aggregate memory
// use is bounded. The semaphore is applied early in the proxy chain so that
// rejected requests are never charged.  A 503 with Retry-After: 1 is returned
// when capacity is exhausted so the x402 client (and any caller) can retry.
export const proxyBufferSemaphore = new ProxyBufferSemaphore(config.PROXY_BUFFER_CONCURRENCY);
const proxyBufferLimit = proxyBufferConcurrency(proxyBufferSemaphore);

async function proxyIdempotency(req: Request, res: Response, next: NextFunction): Promise<void> {
  const idempotencyKey = req.get("Idempotency-Key");
  if (!idempotencyKey) {
    next();
    return;
  }
  if (idempotencyKey.length > 255) {
    res.status(400).json({ error: "Idempotency-Key must be 255 characters or fewer" });
    return;
  }

  const api = res.locals.api as ApiRow;
  if (api.streamingEnabled) {
    res.status(409).json({ error: "Idempotency-Key is not supported for streaming APIs" });
    return;
  }

  const payment = paymentHeader(req);
  const payer = payerFromPayment(payment);
  if (!payment || !payer.address || !payer.signed) {
    next();
    return;
  }

  const key: ProxyIdempotencyKey = {
    apiId: api.id,
    payer: payer.address,
    key: idempotencyKey,
  };
  const fingerprint = createHash("sha256")
    .update(req.method)
    .update("\n")
    .update(req.originalUrl)
    .update("\n")
    .update(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0))
    .digest("hex");
  const paymentHash = paymentHeaderHash(payment);
  const store = getProxyIdempotencyStore();

  const replayOrConflict = (record: Awaited<ReturnType<typeof store.get>>): boolean => {
    if (!record) return false;
    if (record.fingerprint !== fingerprint) {
      res.status(409).json({ error: "Idempotency-Key was already used for a different request" });
      return true;
    }
    if (record.inProgress || record.paymentHash !== paymentHash || record.response === null) {
      res.status(409).json({ error: "Idempotency-Key is in use or cannot be replayed" });
      return true;
    }

    res.status(record.response.status);
    for (const [name, value] of Object.entries(record.response.headers)) {
      res.setHeader(name, value);
    }
    res.setHeader("Idempotent-Replayed", "true");
    res.setHeader("Content-Length", String(record.response.body.length));
    res.end(record.response.body);
    return true;
  };

  try {
    const existing = await store.get(key);
    if (replayOrConflict(existing)) return;

    if (!(await store.claim(key, fingerprint))) {
      const current = await store.get(key);
      if (!replayOrConflict(current)) {
        res.status(409).json({ error: "Idempotency-Key is in use" });
      }
      return;
    }

    res.locals.completeProxyIdempotency = async (response: StoredProxyResponse) => {
      const cacheResponse =
        response.body.length <= config.PROXY_IDEMPOTENCY_MAX_BODY_BYTES ? response : null;
      await store.complete(key, {
        inProgress: false,
        fingerprint,
        paymentHash,
        response: cacheResponse,
        txHash: null,
      });
      res.locals.preserveProxyIdempotencyClaim = false;
    };

    res.once("finish", () => {
      if (res.locals.preserveProxyIdempotencyClaim) return;
      void store
        .delete(key)
        .catch((err) =>
          getLogger().error(
            { event: "proxy_idempotency_release_failed", apiId: api.id, err },
            "failed to release proxy idempotency claim",
          ),
        );
    });
    next();
  } catch (err) {
    next(err);
  }
}

// Issue #30: POST /api/:id/pass — buy a time-limited access pass via x402.
// The payment is verified and settled by the x402 facilitator before a pass is
// created (#275); the pass length is set by the provider (#278). See
// routes/accessPassPurchase.ts.
router.post("/api/:id/pass", loadProxiedApi, checkPayerAllowDeny, buyAccessPass);

// ANY /api/:id[/*path] — one paid call to the provider's API
router.all(
  "/api/:id{/*path}",
  proxyTrackingMiddleware,
  proxyIpRateLimit,
  proxyBufferLimit,
  loadProxiedApi,
  validateProxyPath,
  express.raw({ type: () => true, limit: config.PROXY_MAX_REQUEST_BODY }),
  checkPayerAllowDeny,
  checkPayerAccess,
  proxyIdempotency,
  spendSignedApiCredit,
  apiPaywall,
  proxyHandler,
);

export default router;
