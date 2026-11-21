import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, gt, ilike, isNotNull, isNull, or, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { apiCalls, apis } from "../db/schema.js";
import { config, upstreamKeyRing } from "../config.js";
import { encryptSecret } from "../utils/secretBox.js";
import { validateUpstreamUrl } from "../lib/upstreamGuard.js";
import { sendUpstream } from "../lib/upstreamClient.js";
import { createTtlCache } from "../lib/ttlCache.js";
import type { apiCatalogSortValues } from "../schemas/requests.js";
import { statsWhere, type RecentCallsOptions, type StatsRange } from "./apiStatsQuery.js";
import {
  FileApiCallRecordOutbox,
  createApiCallRecorder,
  postgresApiCallRecordStore,
  type ApiCallRecord,
  type ApiCallRecorder,
} from "./apiCallRecorder.js";
import { apiCallRecordsPending } from "../lib/metrics.js";
import { nextHealthCheckAt } from "../lib/healthBackoff.js";
import { logger as rootLogger } from "../lib/logger.js";

export { statsWhere, type RecentCallsOptions, type StatsRange } from "./apiStatsQuery.js";

export type ApiRow = typeof apis.$inferSelect;

// Hot proxied APIs are looked up on every call (#34). Every write to an API
// goes through this module and invalidates its entry, so edits apply at once
// in this process; other replicas see them within the TTL.
const apiCache = createTtlCache<ApiRow>({
  defaultTtlMs: config.PROXY_API_CACHE_TTL_MS,
  maxSize: 1_000,
  cacheName: "proxied_api",
});

export function invalidateApiCache(id: string): void {
  apiCache.delete(id);
}

export interface ApiChangeRecord {
  id: string;
  apiId: string;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  actor: string;
  createdAt: string;
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

export interface CreateApiInput {
  publisherId: string;
  name: string;
  description?: string | null;
  upstreamUrl: string;
  upstreamMethod?: string;
  upstreamHeaderValueEnc?: string | null;
  upstreamQueryValueEnc?: string | null;
  price: string;
  walletAddress: string;
}

export interface UpdateApiInput {
  name?: string;
  description?: string | null;
  upstreamUrl?: string;
  upstreamMethod?: string;
  upstreamHeaderValueEnc?: string | null;
  upstreamQueryValueEnc?: string | null;
  price?: string;
  walletAddress?: string;
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
    // When the health worker next checks this API (#220). Null when there is no health path or it was never checked.
    nextHealthCheckAt: api.healthPath
      ? (nextHealthCheckAt(
          api,
          config.HEALTH_CHECK_INTERVAL_MS,
          config.HEALTH_CHECK_FAILURE_THRESHOLD,
          config.HEALTH_CHECK_MAX_BACKOFF_MS,
        )?.toISOString() ?? null)
      : null,
  };
}

// Fields that are audited when changed. Secrets are masked in the audit log.
const AUDITED_FIELDS: Array<keyof UpdateApiInput> = [
  "name",
  "description",
  "upstreamUrl",
  "upstreamMethod",
  "upstreamHeaderValueEnc",
  "upstreamQueryValueEnc",
  "price",
  "walletAddress",
];

const SECRET_FIELDS = new Set<string>(["upstreamHeaderValueEnc", "upstreamQueryValueEnc"]);

const MASKED_VALUE = "***";

// Injectable DNS resolver so tests can mock DNS lookups.
export type TxtResolver = (host: string) => Promise<string[][]>;

let txtResolver: TxtResolver = async (host: string) => {
  return dnsPromises.resolveTxt(host);
};

export function setTxtResolver(resolver: TxtResolver): void {
  txtResolver = resolver;
}

export function resetTxtResolver(): void {
  txtResolver = async (host: string) => {
    return dnsPromises.resolveTxt(host);
  };
}

function maskValue(field: string, value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (SECRET_FIELDS.has(field)) {
    return MASKED_VALUE;
  }
  return String(value);
}

/** Returns the active key ring, or throws 503 if no key is configured. */
function activeKeyRing() {
  if (upstreamKeyRing.length === 0) {
    throw new ApiServiceError(
      503,
      "This server cannot store upstream secrets (UPSTREAM_SECRET_KEY / UPSTREAM_SECRET_KEYS is not configured)",
    );
  }
  return upstreamKeyRing;
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

async function checkDnsTxt(upstreamUrl: string, token: string): Promise<boolean> {
  try {
    const host = getUpstreamHost(upstreamUrl);
    const records = await txtResolver(host);
    const expectedRecord = `${DNS_TXT_PREFIX}${token}`;
    for (const chunks of records) {
      const joined = chunks.join("");
      if (joined.trim() === expectedRecord) {
        return true;
      }
    }
    return false;
  } catch (err) {
    logger.warn({ err, upstreamUrl }, "Failed to check DNS TXT ownership record");
    return false;
  }
}

async function verifyOwnership(upstreamUrl: string, token: string): Promise<boolean> {
  const [fileOk, dnsOk] = await Promise.all([
    checkWellKnownFile(upstreamUrl, token),
    checkDnsTxt(upstreamUrl, token),
  ]);
  return fileOk || dnsOk;
}

function toOwnerApi(api: ApiRecord): OwnerApi {
  const host = getUpstreamHost(api.upstreamUrl);
  let wellKnownUrl: string;
  try {
    wellKnownUrl = new URL(WELL_KNOWN_PATH, api.upstreamUrl).toString();
  } catch {
    wellKnownUrl = `${api.upstreamUrl.replace(/\/+$/, "")}${WELL_KNOWN_PATH}`;
  }
  return {
    id: api.id,
    name: api.name,
    description: api.description,
    upstreamUrl: api.upstreamUrl,
    upstreamMethod: api.upstreamMethod,
    price: api.price,
    walletAddress: api.walletAddress,
    listed: api.listed,
    ownershipVerified: api.ownershipVerified,
    ownershipVerification: {
      token: api.ownershipToken,
      methods: ["well-known-file", "dns-txt"],
      wellKnownFile: {
        url: wellKnownUrl,
        expectedLine: `${DNS_TXT_PREFIX}${api.ownershipToken}`,
      },
      dnsTxt: {
        host,
        expectedRecord: `${DNS_TXT_PREFIX}${api.ownershipToken}`,
      },
    },
    createdAt: api.createdAt,
    updatedAt: api.updatedAt,
  };
}

export async function createApi(input: CreateApiInput): Promise<OwnerApi> {
  const now = new Date().toISOString();
  const id = randomUUID();
  const ownershipToken = randomUUID().replace(/-/g, "");
  const record: ApiRecord = {
    id,
    publisherId: input.publisherId,
    name: input.name,
    description: input.description ?? null,
    upstreamUrl: input.upstreamUrl,
    upstreamMethod: input.upstreamMethod ?? "GET",
    upstreamHeaderValueEnc: input.upstreamHeaderValueEnc ?? null,
    upstreamQueryValueEnc: input.upstreamQueryValueEnc ?? null,
    price: input.price,
    walletAddress: input.walletAddress,
    ownershipToken,
    ownershipVerified: false,
    listed: false,
    createdAt: now,
    updatedAt: now,
  };

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
      })
      .returning();
    return row;
  }

  return toOwnerApi(record);
}

export async function getApiById(id: string): Promise<ApiRecord | null> {
  const row = await db<ApiRecord>("apis").where({ id }).first();
  return row ?? null;
}

export async function getOwnerApi(id: string, publisherId: string): Promise<OwnerApi | null> {
  const row = await db<ApiRecord>("apis").where({ id, publisherId }).first();
  return row ? toOwnerApi(row) : null;
}

export async function listOwnerApis(publisherId: string): Promise<OwnerApi[]> {
  const rows = await db<ApiRecord>("apis").where({ publisherId }).orderBy("createdAt", "desc");
  return rows.map(toOwnerApi);
}

/** Soft-delete: unlist and hide the API everywhere. Its call history is kept for stats. */
export async function archiveApi(api: ApiRow): Promise<ApiRow> {
  const [row] = await db
    .update(apis)
    .set({ archivedAt: new Date(), listed: false })
    .where(eq(apis.id, api.id))
    .returning();
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
    tags: input.tags,
    payerAllowlist: input.payerAllowlist,
    payerDenylist: input.payerDenylist,
    passPrice: input.passPrice,
    freeCallsPerDay: input.freeCallsPerDay,
    ...encryptedHeader(input.upstreamHeader),
    ...encryptedQueryParam(input.upstreamQueryParam),
  };

  if (input.healthPath !== undefined && input.healthPath !== api.healthPath) {
    Object.assign(changes, { healthPath: input.healthPath }, RESET_HEALTH);
  }

  const updates: Partial<ApiRecord> = {};
  const changes: Array<{ field: string; oldValue: unknown; newValue: unknown }> = [];

  for (const field of AUDITED_FIELDS) {
    if (!(field in input)) {
      continue;
    }
    const newValue = input[field];
    const oldValue = existing[field as keyof ApiRecord];
    if (normalizeForCompare(oldValue) !== normalizeForCompare(newValue)) {
      updates[field as keyof ApiRecord] = newValue as never;
      changes.push({ field, oldValue, newValue });
    }
  }

  if (changes.length === 0) {
    return toOwnerApi(existing);
  }

  const now = new Date().toISOString();
  updates.updatedAt = now;

  // If the upstream URL changed, ownership must be re-verified.
  const upstreamChanged = changes.some((c) => c.field === "upstreamUrl");
  if (upstreamChanged) {
    const verified = await verifyOwnership(
      (updates.upstreamUrl as string) ?? existing.upstreamUrl,
      existing.ownershipToken,
    );
    updates.ownershipVerified = verified;
    updates.listed = verified;
  }

  await db("apis").where({ id }).update(updates);

  for (const change of changes) {
    await recordChange(id, change.field, change.oldValue, change.newValue, publisherId);
  }

  const updated = await db<ApiRecord>("apis").where({ id }).first();
  return updated ? toOwnerApi(updated) : null;
}

export async function listApiChanges(apiId: string): Promise<ApiChangeRecord[]> {
  const rows = await db<ApiChangeRecord>("api_changes")
    .where({ apiId })
    .orderBy("createdAt", "desc");
  return rows;
}

export async function getApiChangesForOwner(
  apiId: string,
  publisherId: string,
): Promise<ApiChangeRecord[] | null> {
  const existing = await db<ApiRecord>("apis").where({ id: apiId, publisherId }).first();
  if (!existing) {
    return null;
  }
  return listApiChanges(apiId);
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

export async function getApiStats(apiId: string, range: StatsRange = {}) {
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
    .where(statsWhere(apiId, range));
  return { ...totals, currency: "USDC" };
}

/**
 * Newest-first call history for one API. Accepts a bare limit (legacy) or a
 * range + pagination object using the same window as getApiStats.
 */
export async function listRecentCalls(apiId: string, opts: number | RecentCallsOptions) {
  const options: RecentCallsOptions = typeof opts === "number" ? { limit: opts } : opts;
  return db
    .select()
    .from(apiCalls)
    .where(statsWhere(apiId, options))
    .orderBy(desc(apiCalls.createdAt), desc(apiCalls.id))
    .limit(options.limit)
    .offset(options.offset ?? 0);
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
// ── API-call records (#134) ─────────────────────────────────────────────────

let callRecorder: ApiCallRecorder | null = null;

/** Shared recorder: database first, durable outbox on failure. */
export function getApiCallRecorder(): ApiCallRecorder {
  callRecorder ??= createApiCallRecorder({
    store: postgresApiCallRecordStore(db as never),
    outbox: new FileApiCallRecordOutbox(config.API_CALL_OUTBOX_DIR),
    logger: rootLogger,
    onPending: (pending) => apiCallRecordsPending.set(pending),
  });
  return callRecorder;
}

/**
 * Record one proxied call. A failed insert is spooled and retried by the
 * recovery worker, so the row is not lost; this rejects only when the spool
 * itself cannot be written.
 */
export async function recordApiCall(
  call: Omit<ApiCallRecord, "createdAt"> & { createdAt?: string },
): Promise<void> {
  await getApiCallRecorder().record({
    ...call,
    createdAt: call.createdAt ?? new Date().toISOString(),
  });
}
