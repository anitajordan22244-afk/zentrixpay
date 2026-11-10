import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, gt, ilike, isNotNull, isNull, or, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { apiCalls, apiPasses, apis, type ApiPriceRule } from "../db/schema.js";
import { config } from "../config.js";
import { encryptSecret, parseKeyRing } from "../utils/secretBox.js";
import { validateUpstreamUrl } from "../lib/upstreamGuard.js";
import { sendUpstream } from "../lib/upstreamClient.js";
import { createTtlCache } from "../lib/ttlCache.js";
import { OpenApiSpecError, parseOpenApiSpec, publicOpenApiSpec } from "./openApiSpec.js";
import {
  getApiCallRecoveryStatus,
  recordApiCallWithRecovery,
  recoverPendingApiCalls,
  type RecordCallInput,
} from "./apiCallRecovery.js";
import type { apiCatalogSortValues } from "../schemas/requests.js";

export type ApiRow = typeof apis.$inferSelect;
export { getApiCallRecoveryStatus, recoverPendingApiCalls, type RecordCallInput };

// Hot proxied APIs are looked up on every call (#34). Every write to an API
// goes through this module and invalidates its entry, so edits apply at once
// in this process; other replicas see them within the TTL.
const apiCache = createTtlCache<ApiRow>({
  defaultTtlMs: config.PROXY_API_CACHE_TTL_MS ?? 5_000,
  maxSize: 1_000,
  cacheName: "proxied_api",
});

export function invalidateApiCache(id: string): void {
  apiCache.delete(id);
}

export const OWNERSHIP_FILE_PATH = "/.well-known/zentrixpay.txt";

export class ApiServiceError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function proxyUrlOf(api: ApiRow): string {
  return `${config.BASE_URL}/api/${api.id}`;
}

/** What anyone may see about an API. Never includes the upstream URL or secret. */
export function toPublicApi(api: ApiRow) {
  return {
    id: api.id,
    name: api.name,
    description: api.description,
    price: api.price,
    currency: "USDC",
    walletAddress: api.walletAddress,
    allowedMethods: api.allowedMethods,
    priceRules: api.priceRules ?? [],
    tags: api.tags,
    healthy: api.healthy,
    // Issue #30: callers can see whether a pass is offered and at what price.
    passPrice: api.passPrice ?? null,
    // Issue #32: free calls per day this provider offers to new callers.
    freeCallsPerDay: api.freeCallsPerDay,
    proxyUrl: proxyUrlOf(api),
    openapiUrl: api.openapiSpec ? `${config.BASE_URL}/apis/${api.id}/openapi.json` : null,
    // Where callers can check price and payee for themselves.
    onchain: {
      registered: api.onchainStatus === "registered",
      contractId: config.REGISTRY_CONTRACT_ID,
      txHash: api.onchainTxHash,
    },
    createdAt: api.createdAt,
  };
}

/** The API's OpenAPI document as callers see it, or null if it has none. */
export function toPublicOpenApi(api: ApiRow) {
  if (!api.openapiSpec) return null;
  return publicOpenApiSpec(api.openapiSpec, api.upstreamUrl, proxyUrlOf(api));
}

function ownershipLine(token: string): string {
  return `zentrixpay-verification=${token}`;
}

function ownershipFileUrl(upstreamUrl: string): string {
  return new URL(OWNERSHIP_FILE_PATH, new URL(upstreamUrl).origin).toString();
}

/** What the owning provider sees. Includes the upstream URL but never the secret value. */
export function toOwnerApi(api: ApiRow) {
  return {
    ...toPublicApi(api),
    upstreamUrl: api.upstreamUrl,
    upstreamHeaderName: api.upstreamHeaderName,
    hasUpstreamSecret: Boolean(api.upstreamHeaderValueEnc),
    upstreamQueryParamName: api.upstreamQueryName,
    hasUpstreamQuerySecret: Boolean(api.upstreamQueryValueEnc),
    timeoutMs: api.timeoutMs,
    maxResponseBytes: api.maxResponseBytes,
    webhookUrl: api.webhookUrl,
    hasWebhookSecret: Boolean(api.webhookSecretEnc),
    healthPath: api.healthPath,
    health: {
      healthy: api.healthy,
      consecutiveFailures: api.healthFailures,
      lastCheckedAt: api.lastHealthCheckAt,
    },
    payerAllowlist: api.payerAllowlist,
    payerDenylist: api.payerDenylist,
    listed: api.listed,
    streamingEnabled: api.streamingEnabled,
    onchainStatus: api.onchainStatus,
    ownershipVerified: Boolean(api.ownershipVerifiedAt),
    ownershipVerification: {
      url: ownershipFileUrl(api.upstreamUrl),
      expectedContent: ownershipLine(api.ownershipToken),
    },
  };
}

function checkedUpstreamUrl(raw: string): string {
  try {
    return validateUpstreamUrl(raw, {
      allowPrivate: config.PROXY_ALLOW_PRIVATE_UPSTREAMS,
    }).toString();
  } catch (err) {
    throw new ApiServiceError(400, (err as Error).message);
  }
}

/** Returns the active key ring or legacy hex key, or throws 503 if no key is configured. */
function activeKeyRing() {
  if (config.UPSTREAM_SECRET_KEYS) {
    const ring = parseKeyRing(config.UPSTREAM_SECRET_KEYS);
    if (ring.length > 0) return ring;
  }
  if (config.UPSTREAM_SECRET_KEY) {
    return config.UPSTREAM_SECRET_KEY;
  }
  throw new ApiServiceError(
    503,
    "This server cannot store upstream secrets (UPSTREAM_SECRET_KEY / UPSTREAM_SECRET_KEYS is not configured)",
  );
}

function encryptedHeader(header: { name: string; value: string } | null | undefined) {
  if (header === undefined) return {};
  if (header === null) return { upstreamHeaderName: null, upstreamHeaderValueEnc: null };
  return {
    upstreamHeaderName: header.name.toLowerCase(),
    upstreamHeaderValueEnc: encryptSecret(header.value, activeKeyRing()),
  };
}

function encryptedQueryParam(param: { name: string; value: string } | null | undefined) {
  if (param === undefined) return {};
  if (param === null) return { upstreamQueryName: null, upstreamQueryValueEnc: null };
  // Query parameter names are case-sensitive, so the name is kept as given.
  return {
    upstreamQueryName: param.name,
    upstreamQueryValueEnc: encryptSecret(param.value, activeKeyRing()),
  };
}

function encryptedWebhook(webhook: { url: string; secret: string } | null | undefined) {
  if (webhook === undefined) return {};
  if (webhook === null) return { webhookUrl: null, webhookSecretEnc: null };
  let url: string;
  try {
    url = validateUpstreamUrl(webhook.url, {
      allowPrivate: config.PROXY_ALLOW_PRIVATE_UPSTREAMS,
      field: "webhook.url",
    }).toString();
  } catch (err) {
    throw new ApiServiceError(400, (err as Error).message);
  }
  return { webhookUrl: url, webhookSecretEnc: encryptSecret(webhook.secret, activeKeyRing()) };
}

function checkedOpenApiSpec(spec: string | Record<string, unknown> | null | undefined) {
  if (spec === undefined || spec === null) return spec;
  try {
    return parseOpenApiSpec(spec);
  } catch (err) {
    if (err instanceof OpenApiSpecError) throw new ApiServiceError(400, err.message);
    throw err;
  }
}

function clampTimeout(timeoutMs: number | undefined | null): number | null | undefined {
  if (timeoutMs === undefined || timeoutMs === null) return timeoutMs;
  return Math.min(timeoutMs, config.PROXY_MAX_TIMEOUT_MS);
}

function checkedMaxResponseBytes(bytes: number | undefined | null): number | null | undefined {
  if (bytes !== undefined && bytes !== null && bytes > config.PROXY_MAX_RESPONSE_BYTES) {
    throw new ApiServiceError(
      400,
      `maxResponseBytes must not exceed the server limit of ${config.PROXY_MAX_RESPONSE_BYTES} bytes`,
    );
  }
  return bytes;
}

/** The response cap applied to a proxied call; the global cap always wins. */
export function effectiveMaxResponseBytes(api: ApiRow): number {
  return Math.min(
    api.maxResponseBytes ?? config.PROXY_MAX_RESPONSE_BYTES,
    config.PROXY_MAX_RESPONSE_BYTES,
  );
}

// A new health target starts out healthy until checks say otherwise.
const RESET_HEALTH = { healthy: true, healthFailures: 0, lastHealthCheckAt: null };

export interface CreateApiInput {
  publisherId: string;
  name: string;
  description?: string;
  upstreamUrl: string;
  price: string;
  priceRules?: ApiPriceRule[];
  walletAddress: string;
  allowedMethods: string[];
  upstreamHeader?: { name: string; value: string };
  upstreamQueryParam?: { name: string; value: string };
  openapiSpec?: string | Record<string, unknown>;
  timeoutMs?: number;
  maxResponseBytes?: number;
  webhook?: { url: string; secret: string };
  healthPath?: string;
  tags: string[];
  payerAllowlist?: string[];
  payerDenylist?: string[];
  streamingEnabled?: boolean;
  /** Issue #30: price of a time-limited access pass (undefined = passes not offered). */
  passPrice?: string;
  /** Issue #32: free calls per wallet per day before the paywall applies (0 = disabled). */
  freeCallsPerDay?: number;
}

export async function createApi(input: CreateApiInput): Promise<ApiRow> {
  const [row] = await db
    .insert(apis)
    .values({
      publisherId: input.publisherId,
      name: input.name,
      description: input.description,
      upstreamUrl: checkedUpstreamUrl(input.upstreamUrl),
      price: input.price,
      priceRules: input.priceRules ?? [],
      walletAddress: input.walletAddress,
      allowedMethods: input.allowedMethods,
      timeoutMs: clampTimeout(input.timeoutMs),
      maxResponseBytes: checkedMaxResponseBytes(input.maxResponseBytes),
      healthPath: input.healthPath,
      tags: input.tags,
      payerAllowlist: input.payerAllowlist ?? null,
      payerDenylist: input.payerDenylist ?? [],
      passPrice: input.passPrice ?? null,
      freeCallsPerDay: input.freeCallsPerDay ?? 0,
      ownershipToken: randomBytes(16).toString("hex"),
      openapiSpec: checkedOpenApiSpec(input.openapiSpec),
      streamingEnabled: input.streamingEnabled ?? false,
      ...encryptedHeader(input.upstreamHeader),
      ...encryptedQueryParam(input.upstreamQueryParam),
      ...encryptedWebhook(input.webhook),
    })
    .returning();
  return row;
}

/** Load an API by id. Archived APIs are treated as missing unless `includeArchived` is set. */
export async function getApiById(
  id: string,
  opts: { includeArchived?: boolean } = {},
): Promise<ApiRow | null> {
  const rows = await db.select().from(apis).where(eq(apis.id, id));
  const api = rows[0] ?? null;
  if (api?.archivedAt && !opts.includeArchived) return null;
  return api;
}

/** getApiById behind a short TTL cache, for the per-call proxy path (#34). */
export async function getProxiedApi(id: string): Promise<ApiRow | null> {
  const cached = apiCache.get(id);
  if (cached) return cached;
  const api = await getApiById(id);
  if (api) apiCache.set(id, api);
  return api;
}

/** Load an API and require that `publisherId` owns it (404 otherwise, to avoid leaking ids). */
export async function getOwnedApi(
  id: string,
  publisherId: string,
  opts: { includeArchived?: boolean } = {},
): Promise<ApiRow> {
  const api = await getApiById(id, opts);
  if (!api || api.publisherId !== publisherId) throw new ApiServiceError(404, "API not found");
  return api;
}

export type ApiCatalogSort = (typeof apiCatalogSortValues)[number];

export interface ApiCatalogOptions {
  q?: string;
  tag?: string[];
  sort?: ApiCatalogSort;
  limit: number;
  offset: number;
}

/** Window used to rank APIs by popularity (charged calls). */
export const POPULARITY_WINDOW_DAYS = 7;

export async function listPublicApis(opts: ApiCatalogOptions) {
  const conditions = [eq(apis.listed, true), isNull(apis.archivedAt)];
  if (opts.q) {
    const pattern = `%${opts.q.replace(/[%_\\]/g, "\\$&")}%`;
    conditions.push(or(ilike(apis.name, pattern), ilike(apis.description, pattern))!);
  }
  if (opts.tag?.length) {
    // jsonb containment: the API's tags must include every requested tag.
    conditions.push(sql`${apis.tags} @> ${JSON.stringify(opts.tag)}::jsonb`);
  }

  // Charged calls in the popularity window; correlated so it only runs for this sort.
  const recentChargedCalls = sql`(
    select count(*) from ${apiCalls}
    where ${apiCalls.apiId} = ${apis.id}
      and ${apiCalls.charged}
      and ${apiCalls.createdAt} >= now() - make_interval(days => ${POPULARITY_WINDOW_DAYS})
  )`;
  const price = sql`${apis.price}::numeric`;
  const order = {
    newest: [desc(apis.createdAt)],
    price_asc: [asc(price), desc(apis.createdAt)],
    price_desc: [desc(price), desc(apis.createdAt)],
    popular: [desc(recentChargedCalls), desc(apis.createdAt)],
  }[opts.sort ?? "newest"];

  const rows = await db
    .select()
    .from(apis)
    .where(and(...conditions))
    // id breaks ties so offset pagination is stable.
    .orderBy(...order, asc(apis.id))
    .limit(opts.limit)
    .offset(opts.offset);
  return rows.map(toPublicApi);
}

export async function listPublisherApis(publisherId: string) {
  const rows = await db
    .select()
    .from(apis)
    .where(and(eq(apis.publisherId, publisherId), isNull(apis.archivedAt)))
    .orderBy(desc(apis.createdAt));
  return rows.map(toOwnerApi);
}

/** Soft-delete: unlist and hide the API everywhere. Its call history is kept for stats. */
export async function archiveApi(api: ApiRow): Promise<ApiRow> {
  const [row] = await db
    .update(apis)
    .set({ archivedAt: new Date(), listed: false })
    .where(eq(apis.id, api.id))
    .returning();
  invalidateApiCache(api.id);
  return row;
}

export interface UpdateApiInput {
  name?: string;
  description?: string | null;
  upstreamUrl?: string;
  price?: string;
  priceRules?: ApiPriceRule[] | null;
  walletAddress?: string;
  allowedMethods?: string[];
  upstreamHeader?: { name: string; value: string } | null;
  upstreamQueryParam?: { name: string; value: string } | null;
  openapiSpec?: string | Record<string, unknown> | null;
  timeoutMs?: number | null;
  maxResponseBytes?: number | null;
  webhook?: { url: string; secret: string } | null;
  healthPath?: string | null;
  tags?: string[];
  payerAllowlist?: string[] | null;
  payerDenylist?: string[];
  listed?: boolean;
  streamingEnabled?: boolean;
  /** Issue #30: null disables passes; a new price enables / reprices them. */
  passPrice?: string | null;
  /** Issue #32: 0 disables free calls. */
  freeCallsPerDay?: number;
}

export async function updateApi(api: ApiRow, input: UpdateApiInput): Promise<ApiRow> {
  // Once anchored on-chain, price and payee change only through the registry
  // so the on-chain record never drifts from what callers are charged.
  if (api.onchainStatus === "registered" || api.onchainStatus === "pending") {
    if (input.price !== undefined && input.price !== api.price) {
      throw new ApiServiceError(
        409,
        `This API's price is anchored on-chain; change it with POST /apis/${api.id}/price/prepare`,
      );
    }
    if (input.walletAddress !== undefined && input.walletAddress !== api.walletAddress) {
      throw new ApiServiceError(
        409,
        "The payout wallet of an API registered on-chain cannot change",
      );
    }
  }

  const changes: Partial<typeof apis.$inferInsert> = {
    name: input.name,
    description: input.description,
    price: input.price,
    priceRules: input.priceRules === null ? [] : input.priceRules,
    walletAddress: input.walletAddress,
    allowedMethods: input.allowedMethods,
    timeoutMs: clampTimeout(input.timeoutMs),
    maxResponseBytes: checkedMaxResponseBytes(input.maxResponseBytes),
    openapiSpec: checkedOpenApiSpec(input.openapiSpec),
    tags: input.tags,
    payerAllowlist: input.payerAllowlist,
    payerDenylist: input.payerDenylist,
    streamingEnabled: input.streamingEnabled,
    passPrice: input.passPrice,
    freeCallsPerDay: input.freeCallsPerDay,
    ...encryptedHeader(input.upstreamHeader),
    ...encryptedQueryParam(input.upstreamQueryParam),
    ...encryptedWebhook(input.webhook),
  };

  if (input.healthPath !== undefined && input.healthPath !== api.healthPath) {
    Object.assign(changes, { healthPath: input.healthPath }, RESET_HEALTH);
  }

  if (input.upstreamUrl !== undefined) {
    const upstreamUrl = checkedUpstreamUrl(input.upstreamUrl);
    changes.upstreamUrl = upstreamUrl;
    if (upstreamUrl !== api.upstreamUrl) Object.assign(changes, RESET_HEALTH);
    // Ownership was proven for the old origin; a new origin must be proven again.
    if (new URL(upstreamUrl).origin !== new URL(api.upstreamUrl).origin) {
      changes.ownershipVerifiedAt = null;
      changes.listed = false;
    }
  }

  if (input.listed !== undefined) {
    const verified =
      changes.ownershipVerifiedAt === null ? false : Boolean(api.ownershipVerifiedAt);
    if (input.listed && !verified) {
      throw new ApiServiceError(409, "Verify ownership of the upstream before listing this API");
    }
    if (input.listed && api.onchainStatus !== "registered") {
      throw new ApiServiceError(
        409,
        `Register this API on-chain before listing it (GET /apis/${api.id}/register/prepare)`,
      );
    }
    changes.listed = input.listed;
  }

  for (const key of Object.keys(changes) as Array<keyof typeof changes>) {
    if (changes[key] === undefined) delete changes[key];
  }
  if (Object.keys(changes).length === 0) return api;

  const [row] = await db.update(apis).set(changes).where(eq(apis.id, api.id)).returning();
  invalidateApiCache(api.id);
  return row;
}

/**
 * Prove the provider controls the upstream origin: it must serve
 * `zentrixpay-verification=<token>` at /.well-known/zentrixpay.txt.
 * On success the API is marked verified, and listed once it is also
 * registered on-chain.
 */
export async function verifyOwnership(api: ApiRow): Promise<ApiRow> {
  let body: string;
  let status: number;
  try {
    const res = await sendUpstream({
      url: new URL(ownershipFileUrl(api.upstreamUrl)),
      method: "GET",
      headers: { accept: "text/plain", "user-agent": "ZentrixPay-Verifier/1" },
      timeoutMs: 5_000,
      maxResponseBytes: 64 * 1024,
      allowPrivate: config.PROXY_ALLOW_PRIVATE_UPSTREAMS,
    });
    status = res.status;
    body = res.body.toString("utf8");
  } catch (err) {
    throw new ApiServiceError(
      422,
      `Could not fetch ${OWNERSHIP_FILE_PATH}: ${(err as Error).message}`,
    );
  }

  const expected = ownershipLine(api.ownershipToken);
  const found = body.split(/\r?\n/).some((line) => line.trim() === expected);
  if (status !== 200 || !found) {
    throw new ApiServiceError(
      422,
      `${OWNERSHIP_FILE_PATH} must return 200 and contain the line "${expected}"`,
    );
  }

  const [row] = await db
    .update(apis)
    .set({ ownershipVerifiedAt: new Date(), listed: api.onchainStatus === "registered" })
    .where(eq(apis.id, api.id))
    .returning();
  invalidateApiCache(api.id);
  return row;
}

/**
 * Record a proxied API call, queuing the record for idempotent recovery (#134)
 * if the primary database write fails.
 */
export async function recordApiCall(input: RecordCallInput): Promise<void> {
  await recordApiCallWithRecovery(input);
}

// ── Access passes (#30) ──────────────────────────────────────────────────────

export interface CreatePassInput {
  apiId: string;
  payerAddress: string;
  /** USDC amount paid for the pass. */
  amount: string;
  /** Settlement transaction hash. */
  txHash: string | null;
  /** Pass duration in milliseconds. */
  durationMs: number;
}

/**
 * Record a newly purchased access pass. The pass is immediately active and
 * expires after `durationMs` from now.
 */
export async function createApiPass(input: CreatePassInput) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + input.durationMs);
  const [row] = await db
    .insert(apiPasses)
    .values({
      apiId: input.apiId,
      payerAddress: input.payerAddress,
      amount: input.amount,
      txHash: input.txHash,
      activeFrom: now,
      expiresAt,
    })
    .returning();
  return row;
}

/**
 * Find the most-recently purchased active pass for a payer + API combination.
 * Returns null when no active pass exists.
 */
export async function getActivePass(apiId: string, payerAddress: string) {
  const now = new Date();
  const [row] = await db
    .select()
    .from(apiPasses)
    .where(
      and(
        eq(apiPasses.apiId, apiId),
        eq(apiPasses.payerAddress, payerAddress),
        gt(apiPasses.expiresAt, now),
        sql`${apiPasses.activeFrom} <= now()`,
      ),
    )
    .orderBy(desc(apiPasses.expiresAt))
    .limit(1);
  return row ?? null;
}

// ── Free calls quota (#32) ───────────────────────────────────────────────────

/**
 * Count the free (uncharged) calls a payer has already made to an API today
 * (UTC calendar day).
 */
export async function countFreeCallsToday(apiId: string, payerAddress: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(apiCalls)
    .where(
      and(
        eq(apiCalls.apiId, apiId),
        eq(apiCalls.payerAddress, payerAddress),
        eq(apiCalls.charged, false),
        sql`${apiCalls.createdAt} >= date_trunc('day', now() at time zone 'UTC')`,
      ),
    );
  return row?.count ?? 0;
}

// ── Health checks (#35) ──────────────────────────────────────────────────────

/** Listed APIs with a health path, healthy or not (unhealthy ones must be able to recover). */
export async function listApisForHealthCheck(): Promise<ApiRow[]> {
  return db
    .select()
    .from(apis)
    .where(and(eq(apis.listed, true), isNotNull(apis.healthPath)));
}

/** Map an API's healthPath onto its upstream, the same way the proxy maps /api/:id<path>. */
export function healthCheckUrl(api: ApiRow): URL {
  const base = new URL(api.upstreamUrl);
  const raw = api.healthPath ?? "/";
  const queryStart = raw.indexOf("?");
  const path = queryStart === -1 ? raw : raw.slice(0, queryStart);
  const query = queryStart === -1 ? "" : raw.slice(queryStart + 1);
  const target = new URL(base.origin);
  target.pathname = `${base.pathname.replace(/\/+$/, "")}${path}`;
  target.search = [base.search.slice(1), query].filter(Boolean).join("&");
  return target;
}

/**
 * Record one health check. A success makes the API healthy at once; it turns
 * unhealthy only after `failureThreshold` consecutive failures.
 */
export async function recordHealthCheck(
  api: ApiRow,
  ok: boolean,
  failureThreshold: number,
): Promise<ApiRow> {
  const now = new Date();
  const [row] = await db
    .update(apis)
    .set(
      ok
        ? { healthy: true, healthFailures: 0, lastHealthCheckAt: now }
        : {
            healthFailures: sql`${apis.healthFailures} + 1`,
            healthy: sql`case when ${apis.healthFailures} + 1 >= ${failureThreshold} then false else ${apis.healthy} end`,
            lastHealthCheckAt: now,
          },
    )
    .where(eq(apis.id, api.id))
    .returning();
  if (row && row.healthy !== api.healthy) invalidateApiCache(api.id);
  return row ?? api;
}

/**
 * Totals across every API a provider owns (archived ones included, since their
 * calls were real), plus a per-API breakdown. APIs with no calls show zeros.
 */
export async function getPublisherAnalytics(publisherId: string) {
  const [totals] = await db
    .select({
      calls: sql<number>`count(*)::int`,
      chargedCalls: sql<number>`count(*) filter (where ${apiCalls.charged})::int`,
      revenue: sql<string>`coalesce(sum(${apiCalls.amount}::numeric) filter (where ${apiCalls.charged}), 0)::text`,
    })
    .from(apiCalls)
    .innerJoin(apis, eq(apiCalls.apiId, apis.id))
    .where(eq(apis.publisherId, publisherId));

  const perApi = await db
    .select({
      id: apis.id,
      name: apis.name,
      archivedAt: apis.archivedAt,
      calls: sql<number>`count(${apiCalls.id})::int`,
      chargedCalls: sql<number>`count(${apiCalls.id}) filter (where ${apiCalls.charged})::int`,
      revenue: sql<string>`coalesce(sum(${apiCalls.amount}::numeric) filter (where ${apiCalls.charged}), 0)::text`,
    })
    .from(apis)
    .leftJoin(apiCalls, eq(apiCalls.apiId, apis.id))
    .where(eq(apis.publisherId, publisherId))
    .groupBy(apis.id)
    .orderBy(desc(apis.createdAt));

  return {
    totals: {
      apis: perApi.length,
      calls: totals?.calls ?? 0,
      chargedCalls: totals?.chargedCalls ?? 0,
      revenue: totals?.revenue ?? "0",
      currency: "USDC" as const,
    },
    apis: perApi,
  };
}

export async function getApiStats(apiId: string) {
  const [totals] = await db
    .select({
      calls: sql<number>`count(*)::int`,
      chargedCalls: sql<number>`count(*) filter (where ${apiCalls.charged})::int`,
      revenue: sql<string>`coalesce(sum(${apiCalls.amount}::numeric) filter (where ${apiCalls.charged}), 0)::text`,
      uniquePayers: sql<number>`count(distinct ${apiCalls.payerAddress}) filter (where ${apiCalls.charged})::int`,
      avgDurationMs: sql<number>`coalesce(avg(${apiCalls.durationMs}), 0)::int`,
      refundedCalls: sql<number>`count(*) filter (where ${apiCalls.refundStatus} = 'refunded')::int`,
      refunded: sql<string>`coalesce(sum(${apiCalls.refundAmount}::numeric) filter (where ${apiCalls.refundStatus} = 'refunded'), 0)::text`,
      netRevenue: sql<string>`(coalesce(sum(${apiCalls.amount}::numeric) filter (where ${apiCalls.charged}), 0) - coalesce(sum(${apiCalls.refundAmount}::numeric) filter (where ${apiCalls.refundStatus} = 'refunded'), 0))::text`,
    })
    .from(apiCalls)
    .where(eq(apiCalls.apiId, apiId));
  return { ...totals, currency: "USDC" };
}

export async function listRecentCalls(apiId: string, limit: number) {
  return db
    .select()
    .from(apiCalls)
    .where(eq(apiCalls.apiId, apiId))
    .orderBy(desc(apiCalls.createdAt))
    .limit(limit);
}

/** One data point in a time-series response: calls and revenue for a single calendar day. */
export interface TimeSeriesPoint {
  date: string; // ISO date yyyy-mm-dd in UTC
  calls: number;
  revenue: string; // USDC, as decimal string
}

/**
 * Returns one row per UTC calendar day, covering the last `days` days (today
 * inclusive). Days with no calls are filled in with zeros so the caller always
 * gets a contiguous series.
 */
export async function getApiTimeSeries(
  apiId: string,
  days: 7 | 30 | 90,
): Promise<TimeSeriesPoint[]> {
  const rows = await db
    .select({
      date: sql<string>`to_char(date_trunc('day', ${apiCalls.createdAt} at time zone 'UTC'), 'YYYY-MM-DD')`,
      calls: sql<number>`count(*)::int`,
      revenue: sql<string>`coalesce(sum(${apiCalls.amount}::numeric) filter (where ${apiCalls.charged}), 0)::text`,
    })
    .from(apiCalls)
    .where(
      and(
        eq(apiCalls.apiId, apiId),
        sql`${apiCalls.createdAt} >= now() - interval '${sql.raw(String(days))} days'`,
      ),
    )
    .groupBy(sql`1`)
    .orderBy(sql`1`);

  // Build a map so we can fill in missing dates with zeros.
  const byDate = new Map(rows.map((r) => [r.date, r]));

  const result: TimeSeriesPoint[] = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    const dateStr = d.toISOString().slice(0, 10);
    const row = byDate.get(dateStr);
    result.push({ date: dateStr, calls: row?.calls ?? 0, revenue: row?.revenue ?? "0" });
  }
  return result;
}

/** A payer's charged calls, newest first, as receipts. */
export async function listPayerCalls(
  payerAddress: string,
  opts: { limit: number; offset: number },
) {
  const rows = await db
    .select({
      id: apiCalls.id,
      apiId: apiCalls.apiId,
      apiName: apis.name,
      amount: apiCalls.amount,
      txHash: apiCalls.txHash,
      method: apiCalls.method,
      responseStatus: apiCalls.responseStatus,
      createdAt: apiCalls.createdAt,
    })
    .from(apiCalls)
    .innerJoin(apis, eq(apis.id, apiCalls.apiId))
    .where(and(eq(apiCalls.payerAddress, payerAddress), eq(apiCalls.charged, true)))
    .orderBy(desc(apiCalls.createdAt), desc(apiCalls.id))
    .limit(opts.limit + 1)
    .offset(opts.offset);
  const hasMore = rows.length > opts.limit;
  return {
    calls: rows.slice(0, opts.limit).map((r) => ({ ...r, currency: "USDC" })),
    hasMore,
  };
}
