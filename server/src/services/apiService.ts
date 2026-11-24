import { promises as dnsPromises } from "node:dns";
import { randomBytes, randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  ilike,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { db } from "../db/client.js";
import {
  apiCalls,
  apis,
  apiDailyRollups,
  apiCallFinancialRecords,
  apiPasses,
  type ApiPriceRule,
  type ApiRow,
} from "../db/schema.js";
import { config, upstreamKeyRing } from "../config.js";
import { encryptSecret } from "../utils/secretBox.js";
import { validateUpstreamUrl } from "../lib/upstreamGuard.js";
import { createTtlCache } from "../lib/ttlCache.js";
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
import { logger } from "../lib/logger.js";

export { statsWhere, type RecentCallsOptions, type StatsRange } from "./apiStatsQuery.js";

export interface ApiChangeRecord {
  id: string;
  apiId: string;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  actor: string;
  createdAt: string;
}

export interface ApiRecord {
  id: string;
  publisherId: string;
  name: string;
  description: string | null;
  upstreamUrl: string;
  upstreamMethod: string;
  upstreamHeaderValueEnc: string | null;
  upstreamQueryValueEnc: string | null;
  price: string;
  priceRules: ApiPriceRule[];
  walletAddress: string;
  allowedMethods: string[];
  timeoutMs: number | null;
  maxResponseBytes: number | null;
  healthPath: string | null;
  tags: string[];
  payerAllowlist: string[] | null;
  payerDenylist: string[];
  passPrice: string | null;
  freeCallsPerDay: number;
  ownershipToken: string;
  ownershipVerifiedAt: Date | null;
  ownershipVerified: boolean;
  listed: boolean;
  onchainStatus: string;
  onchainTxHash: string | null;
  streamingEnabled: boolean;
  network: string | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  upstreamHeaderName: string | null;
  upstreamQueryName: string | null;
  openapiSpec: Record<string, unknown> | null;
  scheduledPrice: string | null;
  effectiveAt: Date | null;
}

export interface OwnerApi {
  id: string;
  name: string;
  description: string | null;
  upstreamUrl: string;
  upstreamMethod: string;
  price: string;
  priceRules: ApiPriceRule[];
  pendingPriceChange: { price: string; effectiveAt: string; currency: "USDC" } | null;
  walletAddress: string;
  allowedMethods: string[];
  timeoutMs: number | null;
  maxResponseBytes: number | null;
  healthPath: string | null;
  tags: string[];
  payerAllowlist: string[] | null;
  payerDenylist: string[];
  passPrice: string | null;
  freeCallsPerDay: number;
  listed: boolean;
  streamingEnabled: boolean;
  onchainStatus: string;
  ownershipVerified: boolean;
  ownershipVerification: {
    url: string;
    expectedContent: string;
  };
  nextHealthCheckAt: string | null;
  createdAt: Date;
  updatedAt: Date;
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
  passPrice?: string;
  freeCallsPerDay?: number;
  streamingEnabled?: boolean;
}

export interface UpdateApiInput {
  name?: string;
  description?: string | null;
  upstreamUrl?: string;
  upstreamMethod?: string;
  upstreamHeaderValueEnc?: string | null;
  upstreamQueryValueEnc?: string | null;
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
  passPrice?: string | null;
  freeCallsPerDay?: number;
  scheduledPrice?: string | null;
  effectiveAt?: string | null;
  streamingEnabled?: boolean;
}

/**
 * Thrown by service functions to signal a known HTTP-mappable failure.
 * Routes catch this and forward `statusCode` and `message` to the response.
 */
export class ApiServiceError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiServiceError";
  }
}

const WELL_KNOWN_PATH = "/.well-known/zentrixpay.txt";
const DNS_TXT_PREFIX = "zentrixpay-verification=";

const RESET_HEALTH = {
  healthy: true,
  healthFailures: 0,
  lastHealthCheckAt: null,
} as const;

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

function proxyUrlOf(api: ApiRow): string {
  return `${config.BASE_URL}/api/${api.id}`;
}

function ownershipLine(token: string): string {
  return `${DNS_TXT_PREFIX}${token}`;
}

function ownershipFileUrl(upstreamUrl: string): string {
  return new URL(WELL_KNOWN_PATH, new URL(upstreamUrl).origin).toString();
}

/** What anyone may see about an API. Never includes the upstream URL or secret. */
export function toPublicApi(api: ApiRow) {
  return {
    id: api.id,
    name: api.name,
    description: api.description,
    price: api.price,
    currency: "USDC",
    pendingPriceChange: pendingPriceChangeOf(api),
    walletAddress: api.walletAddress,
    allowedMethods: api.allowedMethods,
    priceRules: api.priceRules ?? [],
    tags: api.tags,
    passPrice: api.passPrice ?? null,
    freeCallsPerDay: api.freeCallsPerDay,
    proxyUrl: proxyUrlOf(api),
    openapiUrl: api.openapiSpec ? `${config.BASE_URL}/apis/${api.id}/openapi.json` : null,
    onchain: {
      registered: api.onchainStatus === "registered",
      contractId: config.REGISTRY_CONTRACT_ID,
      txHash: api.onchainTxHash,
    },
    createdAt: api.createdAt,
  };
}

/** What the owning provider sees. Includes the upstream URL but never the secret value. */
export function toOwnerApi(api: ApiRow): OwnerApi {
  return {
    id: api.id,
    name: api.name,
    description: api.description,
    upstreamUrl: api.upstreamUrl,
    upstreamMethod: api.upstreamMethod,
    price: api.price,
    priceRules: api.priceRules ?? [],
    pendingPriceChange: pendingPriceChangeOf(api),
    walletAddress: api.walletAddress,
    allowedMethods: api.allowedMethods,
    timeoutMs: api.timeoutMs,
    maxResponseBytes: api.maxResponseBytes,
    healthPath: api.healthPath,
    tags: api.tags,
    payerAllowlist: api.payerAllowlist,
    payerDenylist: api.payerDenylist,
    passPrice: api.passPrice ?? null,
    freeCallsPerDay: api.freeCallsPerDay,
    listed: api.listed,
    streamingEnabled: api.streamingEnabled,
    onchainStatus: api.onchainStatus,
    ownershipVerified: Boolean(api.ownershipVerifiedAt),
    ownershipVerification: {
      url: ownershipFileUrl(api.upstreamUrl),
      expectedContent: ownershipLine(api.ownershipToken),
    },
    nextHealthCheckAt: api.healthPath
      ? (nextHealthCheckAt(
          api,
          config.HEALTH_CHECK_INTERVAL_MS,
          config.HEALTH_CHECK_FAILURE_THRESHOLD,
          config.HEALTH_CHECK_MAX_BACKOFF_MS,
        )?.toISOString() ?? null)
      : null,
    createdAt: api.createdAt,
    updatedAt: api.updatedAt,
  };
}

function toPublicOpenApi(api: ApiRow): Record<string, unknown> | null {
  if (!api.openapiSpec) return null;
  const spec = { ...api.openapiSpec } as Record<string, unknown>;
  const paths = spec.paths as Record<string, unknown> | undefined;
  if (paths) {
    for (const [path, pathItem] of Object.entries(paths)) {
      if (pathItem && typeof pathItem === "object") {
        const item = pathItem as Record<string, unknown>;
        for (const method of Object.keys(item)) {
          const op = item[method] as Record<string, unknown> | undefined;
          if (op && op.servers) {
            op.servers = [{ url: proxyUrlOf(api) }];
          }
        }
      }
    }
  }
  return spec;
}

export function effectiveMaxResponseBytes(api: ApiRow): number {
  const cap = config.PROXY_MAX_RESPONSE_BYTES;
  return api.maxResponseBytes !== null && api.maxResponseBytes !== undefined
    ? Math.min(api.maxResponseBytes, cap)
    : cap;
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

function normalizeForCompare(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
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
  return {
    upstreamQueryName: param.name,
    upstreamQueryValueEnc: encryptSecret(param.value, activeKeyRing()),
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

function clampTimeout(ms: number | null | undefined): number | null {
  if (ms === undefined || ms === null) return null;
  const min = config.PROXY_MIN_TIMEOUT_MS ?? 1000;
  const max = config.PROXY_MAX_TIMEOUT_MS ?? 120_000;
  return Math.min(Math.max(ms, min), max);
}

function checkedMaxResponseBytes(bytes: number | null | undefined): number | null {
  if (bytes === undefined || bytes === null) return null;
  const cap = config.PROXY_MAX_RESPONSE_BYTES ?? 10 * 1024 * 1024;
  return Math.min(Math.max(bytes, 0), cap);
}

function checkedOpenApiSpec(spec: string | Record<string, unknown> | null | undefined) {
  if (spec === undefined || spec === null) return spec;
  if (typeof spec === "string") {
    try {
      return JSON.parse(spec);
    } catch {
      throw new ApiServiceError(400, "openapiSpec must be valid JSON");
    }
  }
  return spec;
}

function getUpstreamHost(upstreamUrl: string): string {
  try {
    return new URL(upstreamUrl).hostname;
  } catch {
    return upstreamUrl;
  }
}

async function checkWellKnownFile(upstreamUrl: string, token: string): Promise<boolean> {
  try {
    const url = new URL(WELL_KNOWN_PATH, upstreamUrl);
    const response = await fetch(url.toString(), {
      method: "GET",
      redirect: "follow",
    });
    if (!response.ok) {
      return false;
    }
    const body = await response.text();
    const expectedLine = `${DNS_TXT_PREFIX}${token}`;
    const lines = body.split(/\r?\n/).map((line) => line.trim());
    return lines.includes(expectedLine) || body.trim() === expectedLine;
  } catch (err) {
    logger.warn({ err, upstreamUrl }, "Failed to check well-known ownership file");
    return false;
  }
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

export async function verifyOwnership(upstreamUrl: string, token: string): Promise<boolean> {
  const [fileOk, dnsOk] = await Promise.all([
    checkWellKnownFile(upstreamUrl, token),
    checkDnsTxt(upstreamUrl, token),
  ]);
  return fileOk || dnsOk;
}

export async function verifyOwnership(api: ApiRow): Promise<ApiRow> {
  const verified = await verifyOwnership(api.upstreamUrl, api.ownershipToken);
  const now = new Date();
  if (verified) {
    if (!api.ownershipVerified) {
      const [row] = await db
        .update(apis)
        .set({ ownershipVerifiedAt: now, listed: true, updatedAt: now })
        .where(eq(apis.id, api.id))
        .returning();
      return row;
    }
    return api;
  }

  const [row] = await db
    .update(apis)
    .set({ ownershipVerifiedAt: null, listed: false, updatedAt: now })
    .where(eq(apis.id, api.id))
    .returning();
  return row;
}

async function recordChange(
  apiId: string,
  field: string,
  oldValue: unknown,
  newValue: unknown,
  actor: string,
): Promise<void> {
  const oldMasked = maskValue(field, oldValue);
  const newMasked = maskValue(field, newValue);
  if (oldMasked === newMasked) {
    return;
  }
  await db
    .insert(apiCalls)
    .values({
      id: randomUUID(),
      apiId,
      field,
      oldValue: oldMasked,
      newValue: newMasked,
      actor,
      createdAt: new Date(),
    })
    .catch(() => {});
}

export async function createApi(input: CreateApiInput): Promise<OwnerApi> {
  const now = new Date();
  const id = randomUUID();
  const ownershipToken = randomBytes(16).toString("hex");

  const [row] = await db
    .insert(apis)
    .values({
      id,
      publisherId: input.publisherId,
      name: input.name,
      description: input.description,
      upstreamUrl: checkedUpstreamUrl(input.upstreamUrl),
      upstreamMethod: input.upstreamMethod ?? "GET",
      price: input.price,
      priceRules: input.priceRules ?? [],
      walletAddress: input.walletAddress,
      allowedMethods: input.allowedMethods ?? ["GET"],
      timeoutMs: clampTimeout(input.timeoutMs),
      maxResponseBytes: checkedMaxResponseBytes(input.maxResponseBytes),
      healthPath: input.healthPath ?? null,
      tags: input.tags ?? [],
      payerAllowlist: input.payerAllowlist ?? null,
      payerDenylist: input.payerDenylist ?? [],
      passPrice: input.passPrice ?? null,
      freeCallsPerDay: input.freeCallsPerDay ?? 0,
      ownershipToken,
      ownershipVerified: false,
      ownershipVerifiedAt: null,
      listed: false,
      streamingEnabled: input.streamingEnabled ?? false,
      network: null,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
      upstreamHeaderName: null,
      upstreamHeaderValueEnc: null,
      upstreamQueryName: null,
      upstreamQueryValueEnc: null,
      openapiSpec: checkedOpenApiSpec(input.openapiSpec),
      scheduledPrice: null,
      effectiveAt: null,
      ...encryptedHeader(input.upstreamHeader),
      ...encryptedQueryParam(input.upstreamQueryParam),
    })
    .returning();

  const verified = await verifyOwnership(row.upstreamUrl, ownershipToken);
  if (verified) {
    const [updated] = await db
      .update(apis)
      .set({ ownershipVerifiedAt: now, listed: true, updatedAt: now })
      .where(eq(apis.id, row.id))
      .returning();
    return toOwnerApi(updated);
  }

  return toOwnerApi(row);
}

export async function getApiById(id: string): Promise<ApiRow | null> {
  const [row] = await db.select().from(apis).where(eq(apis.id, id)).limit(1);
  return row ?? null;
}

export async function getOwnedApi(id: string, publisherId: string): Promise<OwnerApi | null> {
  const api = await getApiById(id);
  if (!api || api.publisherId !== publisherId) {
    return null;
  }
  return toOwnerApi(api);
}

export async function listOwnerApis(publisherId: string): Promise<OwnerApi[]> {
  const rows = await db
    .select()
    .from(apis)
    .where(eq(apis.publisherId, publisherId))
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
  return row;
}

export async function updateApi(api: ApiRow, input: UpdateApiInput): Promise<ApiRow> {
  if (api.onchainStatus === "registered" || api.onchainStatus === "pending") {
    if (input.price !== undefined && input.price !== api.price) {
      throw new ApiServiceError(
        409,
        `This API's price is anchored on-chain; change it with POST /apis/${api.id}/price/prepare`,
      );
    }
    if (input.scheduledPrice !== undefined) {
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

  const schedule = scheduledPriceChanges(api, input);

  const changes: Partial<typeof apis.$inferInsert> = {
    name: input.name,
    description: input.description,
    price: input.price,
    ...schedule,
    priceRules: input.priceRules === null ? [] : input.priceRules,
    walletAddress: input.walletAddress,
    allowedMethods: input.allowedMethods,
    upstreamMethod: input.upstreamMethod,
    timeoutMs: clampTimeout(input.timeoutMs),
    maxResponseBytes: checkedMaxResponseBytes(input.maxResponseBytes),
    tags: input.tags,
    payerAllowlist: input.payerAllowlist,
    payerDenylist: input.payerDenylist,
    passPrice: input.passPrice,
    freeCallsPerDay: input.freeCallsPerDay,
    listed: input.listed,
    streamingEnabled: input.streamingEnabled,
    ...encryptedHeader(input.upstreamHeader),
    ...encryptedQueryParam(input.upstreamQueryParam),
  };

  if (input.healthPath !== undefined && input.healthPath !== api.healthPath) {
    Object.assign(changes, { healthPath: input.healthPath }, RESET_HEALTH);
  }

  if (input.openapiSpec !== undefined) {
    changes.openapiSpec = checkedOpenApiSpec(input.openapiSpec);
  }

  const updates: Partial<ApiRow> = {};
  const auditChanges: Array<{ field: string; oldValue: unknown; newValue: unknown }> = [];

  for (const field of AUDITED_FIELDS) {
    if (!(field in input)) {
      continue;
    }
    const newValue = (input as Record<string, unknown>)[field];
    const oldValue = api[field as keyof ApiRow];
    if (normalizeForCompare(oldValue) !== normalizeForCompare(newValue)) {
      updates[field as keyof ApiRow] = newValue as never;
      auditChanges.push({ field, oldValue, newValue });
    }
  }

  if (auditChanges.length === 0) {
    return api;
  }

  const now = new Date();
  updates.updatedAt = now;

  const upstreamChanged = auditChanges.some((c) => c.field === "upstreamUrl");
  if (upstreamChanged) {
    const verified = await verifyOwnership(
      (updates.upstreamUrl as string) ?? api.upstreamUrl,
      api.ownershipToken,
    );
    updates.ownershipVerifiedAt = verified ? now : null;
    updates.listed = verified;
  }

  await db.update(apis).set(updates).where(eq(apis.id, api.id));

  for (const change of auditChanges) {
    await recordChange(api.id, change.field, change.oldValue, change.newValue, api.publisherId);
  }

  const [updated] = await db.select().from(apis).where(eq(apis.id, api.id)).limit(1);
  return updated!;
}

export async function listApiChanges(apiId: string): Promise<ApiChangeRecord[]> {
  const rows = await db
    .select()
    .from(apiCalls)
    .where(eq(apiCalls.apiId, apiId))
    .orderBy(desc(apiCalls.createdAt));
  return rows as ApiChangeRecord[];
}

export async function getApiChangesForOwner(
  apiId: string,
  publisherId: string,
): Promise<ApiChangeRecord[] | null> {
  const api = await getOwnedApi(apiId, publisherId);
  if (!api) {
    return null;
  }
  return listApiChanges(apiId);
}

export async function listPublicApis(query: {
  q?: string;
  tags?: string[];
  sort?: string;
  limit?: number;
  offset?: number;
}): Promise<ReturnType<typeof toPublicApi>[]> {
  const conditions = [eq(apis.listed, true)];
  if (query.q) {
    conditions.push(ilike(apis.name, `%${query.q}%`));
  }
  if (query.tags && query.tags.length > 0) {
    conditions.push(sql`${apis.tags} @> ${query.tags}`);
  }

  let orderBy = desc(apis.createdAt);
  if (query.sort === "price_asc") orderBy = asc(apis.price);
  if (query.sort === "price_desc") orderBy = desc(apis.price);

  const rows = await db
    .select()
    .from(apis)
    .where(and(...conditions))
    .orderBy(orderBy)
    .limit(query.limit ?? 50)
    .offset(query.offset ?? 0);

  return rows.map(toPublicApi);
}

export async function listPublisherApis(publisherId: string): Promise<OwnerApi[]> {
  const rows = await db
    .select()
    .from(apis)
    .where(eq(apis.publisherId, publisherId))
    .orderBy(desc(apis.createdAt));
  return rows.map(toOwnerApi);
}

export async function listPayerCalls(
  payerAddress: string,
  opts: { limit: number; offset: number },
): Promise<{ calls: ApiRow[]; hasMore: boolean }> {
  const rows = await db
    .select()
    .from(apiCalls)
    .where(eq(apiCalls.payerAddress, payerAddress))
    .orderBy(desc(apiCalls.createdAt))
    .limit(opts.limit + 1)
    .offset(opts.offset);

  const hasMore = rows.length > opts.limit;
  const calls = hasMore ? rows.slice(0, -1) : rows;
  return { calls: calls as ApiRow[], hasMore };
}

/**
 * The pending price change shown to callers and the owner, or null when none is scheduled.
 */
export function pendingPriceChangeOf(api: Pick<ApiRow, "scheduledPrice" | "effectiveAt">) {
  if (!api.scheduledPrice || !api.effectiveAt) return null;
  return {
    price: api.scheduledPrice,
    effectiveAt: api.effectiveAt.toISOString(),
    currency: "USDC" as const,
  };
}

/**
 * Issue #228: validate a scheduled price change and return the column values to
 * write. Returns {} when the update does not touch the schedule.
 * A new `price` supersedes any pending change, so the schedule is cleared with it.
 */
export function scheduledPriceChanges(
  api: Pick<ApiRow, "price" | "scheduledPrice" | "effectiveAt">,
  input: Pick<UpdateApiInput, "price" | "scheduledPrice" | "effectiveAt">,
  now: Date = new Date(),
): { scheduledPrice: string | null; effectiveAt: Date | null } | Record<string, never> {
  if (input.scheduledPrice === undefined && input.effectiveAt === undefined) {
    if (input.price !== undefined && input.price !== api.price && api.scheduledPrice) {
      return { scheduledPrice: null, effectiveAt: null };
    }
    return {};
  }
  if (input.scheduledPrice === null) {
    return { scheduledPrice: null, effectiveAt: null };
  }
  if (
    input.scheduledPrice === undefined ||
    input.effectiveAt === undefined ||
    input.effectiveAt === null
  ) {
    throw new ApiServiceError(422, "scheduledPrice and effectiveAt must be provided together");
  }
  const effectiveAt = new Date(input.effectiveAt);
  const minNoticeMs = config.PRICE_CHANGE_MIN_NOTICE_HOURS * 60 * 60 * 1000;
  if (effectiveAt.getTime() < now.getTime() + minNoticeMs) {
    throw new ApiServiceError(
      422,
      `effectiveAt must be at least ${config.PRICE_CHANGE_MIN_NOTICE_HOURS} hours from now`,
    );
  }
  if (input.scheduledPrice === api.price) {
    throw new ApiServiceError(422, "scheduledPrice must differ from the current price");
  }
  return { scheduledPrice: input.scheduledPrice, effectiveAt };
}

/** Issue #228: promote every scheduled price whose effective time has passed. Returns the number applied. */
export async function applyDuePriceChanges(now: Date = new Date()): Promise<number> {
  const due = await db
    .update(apis)
    .set({
      price: sql`${apis.scheduledPrice}`,
      scheduledPrice: null,
      effectiveAt: null,
    })
    .where(
      and(isNotNull(apis.scheduledPrice), isNotNull(apis.effectiveAt), lte(apis.effectiveAt, now)),
    )
    .returning({ id: apis.id });
  return due.length;
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
  const [recentTotals] = await db
    .select({
      calls: sql<number>`count(*)::int`,
      chargedCalls: sql<number>`count(*) filter (where ${apiCalls.charged})::int`,
      revenue: sql<string>`coalesce(sum(${apiCalls.amount}::numeric) filter (where ${apiCalls.charged}), 0)::text`,
    })
    .from(apiCalls)
    .innerJoin(apis, eq(apiCalls.apiId, apis.id))
    .where(eq(apis.publisherId, publisherId));

  const [rollupTotals] = await db
    .select({
      calls: sql<number>`coalesce(sum(${apiDailyRollups.calls}), 0)::int`,
      chargedCalls: sql<number>`coalesce(sum(${apiDailyRollups.chargedCalls}), 0)::int`,
      revenue: sql<string>`coalesce(sum(${apiDailyRollups.revenue}::numeric), 0)::text`,
    })
    .from(apiDailyRollups)
    .innerJoin(apis, eq(apiDailyRollups.apiId, apis.id))
    .where(eq(apis.publisherId, publisherId));

  const perApiRecent = await db
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

  const perApiRollup = await db
    .select({
      id: apis.id,
      calls: sql<number>`coalesce(sum(${apiDailyRollups.calls}), 0)::int`,
      chargedCalls: sql<number>`coalesce(sum(${apiDailyRollups.chargedCalls}), 0)::int`,
      revenue: sql<string>`coalesce(sum(${apiDailyRollups.revenue}::numeric), 0)::text`,
    })
    .from(apis)
    .leftJoin(apiDailyRollups, eq(apiDailyRollups.apiId, apis.id))
    .where(eq(apis.publisherId, publisherId))
    .groupBy(apis.id);

  const rollupMap = new Map(perApiRollup.map((r) => [r.id, r]));

  const perApi = perApiRecent.map((api) => {
    const roll = rollupMap.get(api.id);
    const calls = (api.calls ?? 0) + (roll?.calls ?? 0);
    const chargedCalls = (api.chargedCalls ?? 0) + (roll?.chargedCalls ?? 0);
    const revNum = (Number(api.revenue) || 0) + (Number(roll?.revenue) || 0);
    return {
      id: api.id,
      name: api.name,
      archivedAt: api.archivedAt,
      calls,
      chargedCalls,
      revenue: revNum.toString(),
    };
  });

  const [totalCalc] = await db.execute<{ revenue: string }>(sql`
    SELECT (coalesce(${rollupTotals?.revenue ?? "0"}::numeric, 0) + coalesce(${recentTotals?.revenue ?? "0"}::numeric, 0))::text as revenue
  `);

  return {
    totals: {
      apis: perApi.length,
      calls: (recentTotals?.calls ?? 0) + (rollupTotals?.calls ?? 0),
      chargedCalls: (recentTotals?.chargedCalls ?? 0) + (rollupTotals?.chargedCalls ?? 0),
      revenue: totalCalc?.revenue ?? "0",
      currency: "USDC" as const,
    },
    apis: perApi,
  };
}

export interface PayoutRange {
  from?: Date;
  to?: Date;
}

export interface PayoutRow {
  payeeWallet: string;
  apiId: string;
  apiName: string;
  chargedCalls: number;
  revenue: string;
}

/**
 * Charged revenue for a publisher, grouped by the payee wallet each API pays
 * out to and by API. `from` is inclusive and `to` exclusive, matching the
 * stats windows, so back-to-back periods never double count a call.
 */
export async function getPublisherPayouts(publisherId: string, range: PayoutRange = {}) {
  const conditions = [eq(apis.publisherId, publisherId), eq(apiCalls.charged, true)];
  if (range.from) conditions.push(gte(apiCalls.createdAt, range.from));
  if (range.to) conditions.push(lt(apiCalls.createdAt, range.to));

  const rows: PayoutRow[] = await db
    .select({
      payeeWallet: apis.walletAddress,
      apiId: sql<string>`${apis.id}::text`,
      apiName: apis.name,
      chargedCalls: sql<number>`count(${apiCalls.id})::int`,
      revenue: sql<string>`coalesce(sum(${apiCalls.amount}::numeric), 0)::text`,
    })
    .from(apiCalls)
    .innerJoin(apis, eq(apiCalls.apiId, apis.id))
    .where(and(...conditions))
    .groupBy(apis.walletAddress, apis.id, apis.name)
    .orderBy(apis.walletAddress, apis.name);

  const [total] = await db
    .select({
      chargedCalls: sql<number>`count(${apiCalls.id})::int`,
      revenue: sql<string>`coalesce(sum(${apiCalls.amount}::numeric), 0)::text`,
    })
    .from(apiCalls)
    .innerJoin(apis, eq(apiCalls.apiId, apis.id))
    .where(and(...conditions));

  return {
    from: range.from?.toISOString() ?? null,
    to: range.to?.toISOString() ?? null,
    currency: "USDC" as const,
    totals: { chargedCalls: total?.chargedCalls ?? 0, revenue: total?.revenue ?? "0" },
    rows,
  };
}

export async function getApiStats(apiId: string, range: StatsRange = {}) {
  const [recentTotals] = await db
    .select({
      calls: sql<number>`count(*)::int`,
      chargedCalls: sql<number>`count(*) filter (where ${apiCalls.charged})::int`,
      revenue: sql<string>`coalesce(sum(${apiCalls.amount}::numeric) filter (where ${apiCalls.charged}), 0)::text`,
      totalDurationMs: sql<number>`coalesce(sum(${apiCalls.durationMs}), 0)::bigint`,
      refundedCalls: sql<number>`count(*) filter (where ${apiCalls.refundStatus} = 'refunded')::int`,
      refunded: sql<string>`coalesce(sum(${apiCalls.refundAmount}::numeric) filter (where ${apiCalls.refundStatus} = 'refunded'), 0)::text`,
    })
    .from(apiCalls)
    .where(statsWhere(apiId, range));

  const from = range.from ?? range.since;
  const rollupConditions = [eq(apiDailyRollups.apiId, apiId)];
  if (from) {
    rollupConditions.push(gte(apiDailyRollups.date, from.toISOString().slice(0, 10)));
  }
  if (range.to) {
    rollupConditions.push(lt(apiDailyRollups.date, range.to.toISOString().slice(0, 10)));
  }

  const [rollupTotals] = await db
    .select({
      calls: sql<number>`coalesce(sum(${apiDailyRollups.calls}), 0)::int`,
      chargedCalls: sql<number>`coalesce(sum(${apiDailyRollups.chargedCalls}), 0)::int`,
      revenue: sql<string>`coalesce(sum(${apiDailyRollups.revenue}::numeric), 0)::text`,
      totalDurationMs: sql<number>`coalesce(sum(${apiDailyRollups.totalDurationMs}), 0)::bigint`,
      refundedCalls: sql<number>`coalesce(sum(${apiDailyRollups.refundedCalls}), 0)::int`,
      refunded: sql<string>`coalesce(sum(${apiDailyRollups.refundedAmount}::numeric), 0)::text`,
    })
    .from(apiDailyRollups)
    .where(and(...rollupConditions));

  const finConditions = [eq(apiCallFinancialRecords.apiId, apiId)];
  if (from) finConditions.push(gte(apiCallFinancialRecords.createdAt, from));
  if (range.to) finConditions.push(lt(apiCallFinancialRecords.createdAt, range.to));

  const [uniqueResult] = await db.execute<{ count: number }>(sql`
    SELECT count(distinct payer_address)::int as count FROM (
      SELECT ${apiCalls.payerAddress} as payer_address
      FROM ${apiCalls}
      WHERE ${statsWhere(apiId, range)} AND ${apiCalls.charged}
      UNION
      SELECT ${apiCallFinancialRecords.payerAddress} as payer_address
      FROM ${apiCallFinancialRecords}
      WHERE ${and(...finConditions)}
    ) combined_payers
  `);

  const calls = (rollupTotals?.calls ?? 0) + (recentTotals?.calls ?? 0);
  const chargedCalls = (rollupTotals?.chargedCalls ?? 0) + (recentTotals?.chargedCalls ?? 0);
  const totalDuration =
    Number(rollupTotals?.totalDurationMs ?? 0) + Number(recentTotals?.totalDurationMs ?? 0);
  const avgDurationMs = calls > 0 ? Math.round(totalDuration / calls) : 0;
  const refundedCalls = (rollupTotals?.refundedCalls ?? 0) + (recentTotals?.refundedCalls ?? 0);

  const [calc] = await db.execute<{ revenue: string; refunded: string; netRevenue: string }>(sql`
    SELECT
      (coalesce(${rollupTotals?.revenue ?? "0"}::numeric, 0) + coalesce(${recentTotals?.revenue ?? "0"}::numeric, 0))::text as revenue,
      (coalesce(${rollupTotals?.refunded ?? "0"}::numeric, 0) + coalesce(${recentTotals?.refunded ?? "0"}::numeric, 0))::text as refunded,
      (coalesce(${rollupTotals?.revenue ?? "0"}::numeric, 0) + coalesce(${recentTotals?.revenue ?? "0"}::numeric, 0) - (coalesce(${rollupTotals?.refunded ?? "0"}::numeric, 0) + coalesce(${recentTotals?.refunded ?? "0"}::numeric, 0)))::text as "netRevenue"
  `);

  return {
    calls,
    chargedCalls,
    revenue: calc?.revenue ?? "0",
    uniquePayers: uniqueResult?.count ?? 0,
    avgDurationMs,
    refundedCalls,
    refunded: calc?.refunded ?? "0",
    netRevenue: calc?.netRevenue ?? "0",
    currency: "USDC" as const,
  };
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
  const recentRows = await db
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

  const rollupRows = await db
    .select({
      date: apiDailyRollups.date,
      calls: sql<number>`coalesce(sum(${apiDailyRollups.calls}), 0)::int`,
      revenue: sql<string>`coalesce(sum(${apiDailyRollups.revenue}::numeric), 0)::text`,
    })
    .from(apiDailyRollups)
    .where(
      and(
        eq(apiDailyRollups.apiId, apiId),
        sql`${apiDailyRollups.date} >= to_char(now() - interval '${sql.raw(String(days))} days', 'YYYY-MM-DD')`,
      ),
    )
    .groupBy(apiDailyRollups.date)
    .orderBy(apiDailyRollups.date);

  const byDate = new Map<string, { calls: number; revenue: number }>();
  for (const r of rollupRows) {
    byDate.set(r.date, { calls: r.calls, revenue: Number(r.revenue) || 0 });
  }
  for (const r of recentRows) {
    const existing = byDate.get(r.date);
    if (existing) {
      existing.calls += r.calls;
      existing.revenue += Number(r.revenue) || 0;
    } else {
      byDate.set(r.date, { calls: r.calls, revenue: Number(r.revenue) || 0 });
    }
  }

  const result: TimeSeriesPoint[] = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    const dateStr = d.toISOString().slice(0, 10);
    const row = byDate.get(dateStr);
    result.push({ date: dateStr, calls: row?.calls ?? 0, revenue: (row?.revenue ?? 0).toString() });
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
    logger,
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
