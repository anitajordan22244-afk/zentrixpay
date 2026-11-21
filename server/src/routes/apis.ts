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
import { validate } from "../middleware/validate.js";
import { publishIpRateLimit, publishWalletRateLimit } from "../middleware/rateLimiters.js";
import { apiPaywall, checkPayerAccess, loadProxiedApi } from "../middleware/apiPaywall.js";
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
  createApiPass,
  effectiveMaxResponseBytes,
  getActivePass,
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
import { statsPagination } from "../services/apiStatsQuery.js";
import { apiCreditPurchaseReference } from "../lib/apiCreditSignature.js";
import { deliverChargedCallWebhook } from "../services/webhookService.js";
import {
  confirmApiPrice,
  confirmApiRegistration,
  prepareApiPrice,
  prepareApiRegistration,
} from "../services/apiOnchain.js";
import { confirmCallRefund, prepareCallRefund } from "../services/apiRefunds.js";
import { sendUpstream, streamUpstream, UPSTREAM_ERROR_CODES, UpstreamError } from "../lib/upstreamClient.js";
import { filterRequestHeaders, filterResponseHeaders } from "../lib/proxyHeaders.js";
import { paymentHeader, paymentHeaderHash, payerFromPayment } from "../lib/payer.js";
import {
  getProxyIdempotencyStore,
  type ProxyIdempotencyKey,
  type StoredProxyResponse,
} from "../lib/idempotency.js";
import { deliverChargedCallWebhook } from "../services/webhookService.js";
import { decryptSecret } from "../utils/secretBox.js";
import { stroopsToUsdc, usdcToStroops } from "../utils/usdc.js";
import { getLogger } from "../lib/logger.js";
import { config, upstreamKeyRing } from "../config.js";
import { ProxyBufferSemaphore, proxyBufferConcurrency } from "../middleware/proxyBuffer.js";
import { importBulkOpenApi, previewBulkOpenApi } from "../services/openApiImport.js";

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
router.post("/apis/import/preview", apiKeyAuth, openApiUpload.single("document"), async (req, res) => {
  const raw = req.file?.buffer.toString("utf8") ?? req.body?.document ?? req.body?.openapiSpec;
  if (!raw) {
    res.status(400).json({ error: "Provide document as JSON/YAML text, document, or openapiSpec" });
    return;
  }
  const result = previewBulkOpenApi(raw);
  res.status(result.errors.length > 0 ? 422 : 200).json({ groups: result.groups, errors: result.errors });
});

// POST /apis/import — confirm selected preview groups and register them atomically.
router.post("/apis/import", apiKeyAuth, openApiUpload.single("document"), async (req, res) => {
  const raw = req.file?.buffer.toString("utf8") ?? req.body?.document ?? req.body?.openapiSpec;
  const defaults = req.body?.defaults ?? req.body;
  if (!raw || typeof defaults?.price !== "string") {
    res.status(400).json({ error: "document and defaults.price are required; walletAddress defaults to the publisher wallet" });
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
    res.status(422).json({ error: error instanceof Error ? error.message : "OpenAPI import failed" });
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

// POST /apis/:id/verify-ownership — check /.well-known/zentrixpay.txt, then list (owner)
router.post("/apis/:id/verify-ownership", apiKeyAuth, requestSignatureAuth, async (req, res) => {
  try {
    const api = await getOwnedApi(req.params.id as string, req.publisher!.id);
    res.json(toOwnerApi(await verifyOwnership(api)));
  } catch (err) {
    sendServiceError(res, err);
  }
});

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
    getLogger().error({ event: "api_calls_export_failed", apiId: api.id, err }, "CSV export failed");
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

// GET /payers/:address/calls — receipts for the calls a wallet paid for (paged)
router.get("/payers/:address/calls", async (req, res) => {
  const address = req.params.address as string;
  if (!/^G[A-Z2-7]{55}$/.test(address)) {
    res.status(400).json({ error: "address must be a Stellar public key (G...)" });
    return;
  }
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

// ── Paid proxy ────────────────────────────────────────────────────────────────

/** Map /api/:id/<segments>?<query> onto the API's upstream URL. */
export function buildUpstreamUrl(
  upstreamUrl: string,
  segments: string[],
  originalUrl: string,
): URL | null {
  // Segments arrive decoded. Refuse anything that could climb out of the
  // upstream base path or smuggle a separator.
  if (segments.some((s) => s === "." || s === ".." || /[/\\]/.test(s))) return null;

  const base = new URL(upstreamUrl);
  const basePath = base.pathname.replace(/\/+$/, "");
  const subPath = segments.map(encodeURIComponent).join("/");
  const target = new URL(base.origin);
  target.pathname = subPath ? `${basePath}/${subPath}` : basePath || "/";

  const queryStart = originalUrl.indexOf("?");
  const requestQuery = queryStart === -1 ? "" : originalUrl.slice(queryStart + 1);
  target.search = [base.search.slice(1), requestQuery].filter(Boolean).join("&");
  return target;
}

function decodeQueryPart(part: string): string {
  try {
    const decoded = Buffer.from(raw, "base64").toString("utf8");
    const parsed = JSON.parse(decoded);
    if (parsed && typeof parsed === "object") {
      return {
        success: typeof parsed.success === "boolean" ? parsed.success : undefined,
        transaction: typeof parsed.transaction === "string" ? parsed.transaction : undefined,
        network: typeof parsed.network === "string" ? parsed.network : undefined,
        payer: typeof parsed.payer === "string" ? parsed.payer : undefined,
      };
    }
  } catch {
    // ignore malformed header
  }
  return {};
}

/**
 * Resolve the payer address for a charged call.
 * Prefer the verified settlement payer from the PAYMENT-RESPONSE header,
 * then fall back to parsing the PAYMENT-SIGNATURE payload.
 */
function resolvePayer(req: Request, res: Response): string {
  const settlement = settlementFrom(res);
  if (settlement.payer && settlement.payer !== "unknown") {
    return settlement.payer;
  }
  const signature = req.get("PAYMENT-SIGNATURE") || req.get("X-PAYMENT") || undefined;
  const parsed = parsePayerFromXPayment(signature);
  return parsed || "unknown";
}

/**
 * Proxy finish handler: records the completed call.
 * Called after the upstream provider responds.
 */
export async function finishHandler(req: Request, res: Response) {
  const apiId = req.params.id;
  const startedAt: number = (req as any).callStartedAt ?? Date.now();
  const statusCode = res.statusCode;
  const charged = Boolean((req as any).callCharged);
  const latencyMs = Date.now() - startedAt;

  let payerAddress: string | null = null;
  let settlementTx: string | null = null;

  if (charged) {
    payerAddress = resolvePayer(req, res);
    const settlement = settlementFrom(res);
    settlementTx = settlement.transaction ?? null;
  }

  try {
    await db.insert(apiCalls).values({
      apiId,
      statusCode,
      latencyMs,
      charged,
      payerAddress,
      settlementTx,
      createdAt: new Date(),
    });
  } catch (err) {
    console.error("Failed to record api call", err);
  }
}

/**
 * GET /apis/:id/stats
 * Returns aggregate stats plus recent calls including settlement_tx.
 */
router.get("/:id/stats", async (req: Request, res: Response) => {
  const apiId = req.params.id;
  const sinceParam = req.query.since as string | undefined;
  const since = sinceParam ? new Date(sinceParam) : undefined;

  try {
    const [api] = await db.select().from(apis).where(eq(apis.id, apiId)).limit(1);
    if (!api) {
      return res.status(404).json({ error: "API not found" });
    }
    const [totals, recentCalls] = await Promise.all([
      getApiStats(api.id, { since }),
      listRecentCalls(api.id, 50),
    ]);
    return res.json({ apiId: api.id, ...totals, recentCalls });
  } catch (err) {
    console.error("Failed to fetch API stats", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

const UPSTREAM_ERROR_STATUS = { blocked: 502, network: 502, too_large: 502, timeout: 504 } as const;

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
    headers[api.upstreamHeaderName] = value;
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

async function proxyHandler(req: Request, res: Response) {
  const api = res.locals.api as ApiRow;
  const segments = (req.params.path as unknown as string[] | undefined) ?? [];
  const target = buildUpstreamUrl(api.upstreamUrl, segments, req.originalUrl);
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
    const callId = randomUUID();
    recordApiCall({
      callId,
      apiId: api.id,
      charged,
      payerAddress: (res.locals.creditPayer as string | undefined) ?? payerFrom(req, settlement),
      amount: (res.locals.apiCallPrice as string | undefined) ?? api.price,
      method: req.method,
      // Stored minimized: identifiers and the query string are dropped (#144).
      path: minimizeCallPath(
        target.pathname.slice(new URL(api.upstreamUrl).pathname.replace(/\/+$/, "").length) || "/",
      ),
      responseStatus: res.statusCode,
      durationMs: Date.now() - started,
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
        res
          .status(UPSTREAM_ERROR_STATUS[err.kind])
          .json({ error: "upstream_failed", reason: err.kind, code: UPSTREAM_ERROR_CODES[err.kind] });
        return;
      }
      throw err;
    }

    // Mirror useful response headers (no buffering, no content-length).
    const responseHeaders = filterResponseHeaders(upstream.headers);
    res.status(upstream.status);
    for (const [name, value] of Object.entries(responseHeaders)) {
      const rewritten =
        typeof value === "string" ? rewriteResponseHeader(name, value, api, secrets) : value;
      res.setHeader(name, rewritten);
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
  try {
    upstream = await sendUpstream(upstreamOpts);
  } catch (err) {
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
    responseHeaders[name] =
      typeof value === "string" ? rewriteResponseHeader(name, value, api, secrets) : value;
  }
  // Kept for Idempotency-Key replay once the call is known to be charged.
  res.locals.proxyResponse = {
    status: upstream.status,
    headers: responseHeaders,
    body: upstream.body,
  } satisfies StoredProxyResponse;

  const completeProxyIdempotency = res.locals.completeProxyIdempotency as
    | ((response: StoredProxyResponse) => Promise<void>)
    | undefined;
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
// The caller pays passPrice once; subsequent calls are free until the pass
// expires. Pass duration is 1 hour by default; providers may configure it via
// the passPrice field (a future PATCH /apis/:id update can carry durationMs).
const PASS_DURATION_MS = 60 * 60 * 1000; // 1 hour

router.post("/api/:id/pass", loadProxiedApi, async (req: Request, res: Response) => {
  const api = res.locals.api as ApiRow;

  if (!api.passPrice) {
    res.status(404).json({ error: "This API does not offer access passes" });
    return;
  }

  // Derive the payer from the payment header.
  const header = paymentHeader(req);
  const { address: payerAddress } = payerFromPayment(header);

  if (!payerAddress) {
    // No payment yet — return the 402 challenge so the caller knows how much
    // to pay. We reuse the same x402 resource-server path.
    const network = api.network ?? "base-sepolia";
    const payTo = api.walletAddress;
    const price = api.passPrice;

    try {
      const resourceServer = await (
        await import("../lib/x402.js")
      ).sharedX402ResourceServer({
        network,
        payTo,
        price,
      });
      const middleware = resourceServer.middleware({
        price,
        network,
        payTo,
        description: `Access pass for ${api.name} (1 hour)`,
      });
      middleware(req, res, () => {
        // Settlement happened synchronously (unlikely in x402 flow but
        // handle it by creating the pass).
        createApiPass({
          apiId: api.id,
          payerAddress: payerAddress ?? "unknown",
          amount: price,
          txHash: null,
          durationMs: PASS_DURATION_MS,
        })
          .then((pass) => {
            if (!res.headersSent) {
              res.status(201).json({
                passId: pass.id,
                expiresAt: pass.expiresAt,
                message: "Pass activated",
              });
            }
          })
          .catch(() => {
            if (!res.headersSent) res.status(500).json({ error: "Failed to activate pass" });
          });
      });
    } catch (err) {
      if (!res.headersSent) res.status(500).json({ error: "Failed to build payment challenge" });
    }
    return;
  }

  // Payment header is present: check if a pass was already active (idempotent
  // re-purchase within the same window).
  const existing = await getActivePass(api.id, payerAddress);
  if (existing) {
    res.json({
      passId: existing.id,
      expiresAt: existing.expiresAt,
      message: "Pass already active",
    });
    return;
  }

  // Record the new pass (the x402 payment has already been validated by the
  // middleware above on the previous request cycle; here we trust the header
  // was settled — in production this is confirmed by the facilitator before
  // we ever get to this handler for a valid payment).
  try {
    const pass = await createApiPass({
      apiId: api.id,
      payerAddress,
      amount: api.passPrice,
      txHash: null,
      durationMs: PASS_DURATION_MS,
    });
    res.status(201).json({
      passId: pass.id,
      expiresAt: pass.expiresAt,
      message: "Pass activated",
    });
  } catch (err) {
    getLogger().error(
      { event: "api_pass_create_failed", apiId: api.id, err },
      "failed to create pass",
    );
    res.status(500).json({ error: "Failed to create pass" });
  }
});

// ANY /api/:id[/*path] — one paid call to the provider's API
router.all(
  "/api/:id{/*path}",
  proxyIpRateLimit,
  proxyBufferLimit,
  loadProxiedApi,
  express.raw({ type: () => true, limit: config.PROXY_MAX_REQUEST_BODY }),
  checkPayerAccess,
  proxyIdempotency,
  spendSignedApiCredit,
  apiPaywall,
  proxyHandler,
);

export default router;
