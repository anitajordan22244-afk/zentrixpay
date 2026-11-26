import { signedPublisherFetch } from "./requestSignature.js";

const API_BASE = import.meta.env.VITE_API_URL ?? "";

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface ApiPriceRule {
  method: HttpMethod;
  pathPattern: string;
  price: string;
}

/** A pay-per-call API as anyone sees it in the catalog. */
export interface PublicApi {
  id: string;
  name: string;
  description: string | null;
  price: string;
  priceRules: ApiPriceRule[];
  currency: "USDC";
  walletAddress: string;
  allowedMethods: HttpMethod[];
  tags: string[];
  /** Price of a time-limited access pass; null when passes are not offered. */
  passPrice?: string | null;
  /** How long a pass lasts once bought, in milliseconds (1 hour .. 30 days, #278). */
  passDurationMs?: number;
  /** False while health checks say the upstream is down; hidden from the catalog. */
  healthy: boolean;
  proxyUrl: string;
  /** Present when the provider uploaded an OpenAPI document. */
  openapiUrl: string | null;
  /** The API's record in the vault registry, so callers can check price and payee. */
  onchain: { registered: boolean; contractId: string; txHash: string | null };
  createdAt: string;
}

/** The provider's own view of an API. */
export interface OwnerApi extends PublicApi {
  upstreamUrl: string;
  upstreamHeaderName: string | null;
  hasUpstreamSecret: boolean;
  upstreamQueryParamName: string | null;
  hasUpstreamQuerySecret: boolean;
  timeoutMs: number | null;
  /** Per-API response cap in bytes; null means the server-wide limit. */
  maxResponseBytes: number | null;
  webhookUrl: string | null;
  hasWebhookSecret: boolean;
  healthPath: string | null;
  health: { healthy: boolean; consecutiveFailures: number; lastCheckedAt: string | null };
  listed: boolean;
  onchainStatus: "none" | "pending" | "registered" | "failed";
  ownershipVerified: boolean;
  ownershipVerification: { url: string; expectedContent: string };
}

export interface ApiCall {
  id: string;
  payerAddress: string;
  amount: string;
  charged: boolean;
  method: string;
  path: string;
  responseStatus: number;
  durationMs: number;
  refundStatus: "pending" | "refunded" | null;
  refundAmount: string | null;
  refundTxHash: string | null;
  refundedAt: string | null;
  createdAt: string;
}

export interface ApiStats {
  apiId: string;
  calls: number;
  chargedCalls: number;
  revenue: string;
  uniquePayers: number;
  avgDurationMs: number;
  refundedCalls: number;
  refunded: string;
  netRevenue: string;
  currency: "USDC";
  recentCalls: ApiCall[];
  /** Window the totals and recentCalls cover (#143); null bounds are open. */
  range?: { from: string | null; to: string | null };
  pagination?: { limit: number; offset: number; total: number; hasMore: boolean };
}

/** Optional window and paging for GET /apis/:id/stats (#143). */
export interface ApiStatsQuery {
  /** Inclusive ISO-8601 date or date-time. */
  from?: string;
  /** Exclusive ISO-8601 date or date-time. */
  to?: string;
  limit?: number;
  offset?: number;
}

export interface ApiInput {
  name?: string;
  description?: string | null;
  upstreamUrl?: string;
  price?: string;
  priceRules?: ApiPriceRule[] | null;
  walletAddress?: string;
  allowedMethods?: HttpMethod[];
  upstreamHeader?: { name: string; value: string } | null;
  upstreamQueryParam?: { name: string; value: string } | null;
  /** OpenAPI 3 document as JSON/YAML text; null removes it. */
  openapiSpec?: string | null;
  timeoutMs?: number | null;
  maxResponseBytes?: number | null;
  webhook?: { url: string; secret: string } | null;
  healthPath?: string | null;
  tags?: string[];
  listed?: boolean;
  /** Access pass price; null stops offering passes. */
  passPrice?: string | null;
  /** Access pass length in milliseconds, 1 hour .. 30 days (#278). */
  passDurationMs?: number;
}

export interface RegisteredPublisher {
  id: string;
  name: string;
  email: string;
  walletAddress: string;
  apiKey: string;
}

/** Turn a server error body (string or zod format tree) into one readable line. */
function errorText(body: unknown, status: number): string {
  const error = (body as { error?: unknown } | null)?.error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const messages: string[] = [];
    const walk = (node: unknown, path: string) => {
      if (!node || typeof node !== "object") return;
      const errs = (node as { _errors?: string[] })._errors;
      if (errs?.length) messages.push(path ? `${path}: ${errs.join(", ")}` : errs.join(", "));
      for (const [k, v] of Object.entries(node))
        if (k !== "_errors") walk(v, path ? `${path}.${k}` : k);
    };
    walk(error, "");
    if (messages.length) return messages.join("; ");
  }
  return `Request failed (HTTP ${status})`;
}

async function readJson<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(errorText(body, res.status));
  return body as T;
}

export async function fetchApis(
  q: string,
  signal?: AbortSignal,
  limit = 20,
  offset = 0,
  tags: string[] = [],
): Promise<PublicApi[]> {
  const url = new URL(`${API_BASE}/apis`, window.location.origin);
  if (q.trim()) url.searchParams.set("q", q.trim());
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("offset", String(offset));
  // ?tag=a&tag=b — all tags must be present on the API (AND semantics).
  for (const tag of tags) url.searchParams.append("tag", tag);
  return readJson(await fetch(url, { signal }));
}

export async function fetchApiById(id: string, signal?: AbortSignal): Promise<PublicApi> {
  const url = new URL(`${API_BASE}/apis/${encodeURIComponent(id)}`, window.location.origin);
  return readJson(await fetch(url, { signal }));
}

export async function registerPublisher(input: {
  name: string;
  email: string;
  walletAddress: string;
}): Promise<RegisteredPublisher> {
  return readJson(
    await fetch(`${API_BASE}/publishers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

function absolute(path: string): string {
  return new URL(`${API_BASE}${path}`, window.location.origin).toString();
}

export async function fetchMyApis(apiKey: string): Promise<OwnerApi[]> {
  return readJson(await signedPublisherFetch(absolute("/publishers/me/apis"), apiKey));
}

export interface PayoutRow {
  payeeWallet: string;
  apiId: string;
  apiName: string;
  chargedCalls: number;
  revenue: string;
}

export interface PayoutSummary {
  from: string | null;
  to: string | null;
  currency: "USDC";
  totals: { chargedCalls: number; revenue: string };
  rows: PayoutRow[];
}

export interface PayoutRange {
  from?: string;
  to?: string;
}

function payoutsQuery(range: PayoutRange, format?: "csv"): string {
  const params = new URLSearchParams();
  if (range.from) params.set("from", new Date(range.from).toISOString());
  if (range.to) params.set("to", new Date(range.to).toISOString());
  if (format) params.set("format", format);
  const query = params.toString();
  return query ? `?${query}` : "";
}

/** Charged revenue per payee wallet and API for a date window (`to` exclusive). */
export async function fetchPayouts(
  apiKey: string,
  range: PayoutRange = {},
): Promise<PayoutSummary> {
  return readJson(
    await signedPublisherFetch(absolute(`/publishers/me/payouts${payoutsQuery(range)}`), apiKey),
  );
}

/** Fetch an owner-only CSV endpoint and save it, authenticated like other owner requests. */
export async function downloadCsv(apiKey: string, path: string, filename: string): Promise<void> {
  const res = await signedPublisherFetch(absolute(path), apiKey);
  if (!res.ok) throw new Error(errorText(await res.json().catch(() => null), res.status));
  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** Download the payouts table as CSV. */
export async function downloadPayoutsCsv(apiKey: string, range: PayoutRange = {}): Promise<void> {
  return downloadCsv(apiKey, `/publishers/me/payouts${payoutsQuery(range, "csv")}`, "payouts.csv");
}

/** Download an API's call history as CSV (streamed by the server), optionally within a window. */
export async function downloadApiCallsCsv(
  apiKey: string,
  apiId: string,
  range: PayoutRange = {},
): Promise<void> {
  return downloadCsv(
    apiKey,
    `/apis/${encodeURIComponent(apiId)}/calls.csv${payoutsQuery(range)}`,
    `api-${apiId}-calls.csv`,
  );
}

export async function createApi(apiKey: string, input: ApiInput): Promise<OwnerApi> {
  return readJson(
    await signedPublisherFetch(absolute("/apis"), apiKey, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  );
}

export async function updateApi(apiKey: string, id: string, input: ApiInput): Promise<OwnerApi> {
  return readJson(
    await signedPublisherFetch(absolute(`/apis/${id}`), apiKey, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  );
}

export async function verifyApiOwnership(apiKey: string, id: string): Promise<OwnerApi> {
  return readJson(
    await signedPublisherFetch(absolute(`/apis/${id}/verify-ownership`), apiKey, {
      method: "POST",
    }),
  );
}

/** Archive (soft-delete) an API: it disappears from the catalog and dashboard; stats remain. */
export async function archiveApi(apiKey: string, id: string): Promise<void> {
  await readJson(await signedPublisherFetch(absolute(`/apis/${id}`), apiKey, { method: "DELETE" }));
}

export async function fetchApiStats(
  apiKey: string,
  id: string,
  query: ApiStatsQuery = {},
): Promise<ApiStats> {
  const params = new URLSearchParams();
  if (query.from) params.set("from", query.from);
  if (query.to) params.set("to", query.to);
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.offset !== undefined) params.set("offset", String(query.offset));
  const qs = params.toString();
  return readJson(
    await signedPublisherFetch(absolute(`/apis/${id}/stats${qs ? `?${qs}` : ""}`), apiKey),
  );
}

export interface TimeSeriesPoint {
  date: string; // yyyy-mm-dd
  calls: number;
  revenue: string;
}

export interface ApiTimeSeries {
  apiId: string;
  days: 7 | 30 | 90;
  series: TimeSeriesPoint[];
}

export async function fetchApiTimeSeries(
  apiKey: string,
  id: string,
  days: 7 | 30 | 90,
): Promise<ApiTimeSeries> {
  return readJson(
    await signedPublisherFetch(absolute(`/apis/${id}/stats/time-series?days=${days}`), apiKey),
  );
}

// ── OpenAPI helpers (#182) ───────────────────────────────────────────────────

/** Minimal shape of an OpenAPI 3 document — only what the endpoint list reads. */
export interface OpenApiSpec {
  openapi?: string;
  paths?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ApiEndpointParameter {
  name: string;
  in: string;
  required: boolean;
  description: string | null;
}

/** One operation from an API's OpenAPI document, as shown in the detail view. */
export interface ApiEndpoint {
  method: HttpMethod;
  path: string;
  summary: string | null;
  parameters: ApiEndpointParameter[];
  hasRequestBody: boolean;
}

/**
 * Fetch an API's OpenAPI document from `GET /apis/:id/openapi.json`.
 * Accepts the API id, or the absolute `openapiUrl` the catalog returns.
 */
export async function fetchOpenApiSpec(
  idOrUrl: string,
  signal?: AbortSignal,
): Promise<OpenApiSpec> {
  const url = /^https?:\/\//i.test(idOrUrl)
    ? idOrUrl
    : absolute(`/apis/${encodeURIComponent(idOrUrl)}/openapi.json`);
  return readJson(await fetch(url, { signal }));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Resolve a local `#/components/...` reference; anything else is returned as-is. */
function deref(spec: OpenApiSpec, value: unknown): Record<string, unknown> | null {
  const node = asRecord(value);
  const ref = node && typeof node.$ref === "string" ? node.$ref : null;
  if (!ref) return node;
  if (!ref.startsWith("#/")) return null;
  let current: unknown = spec;
  for (const raw of ref.slice(2).split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    current = asRecord(current)?.[key];
  }
  return asRecord(current);
}

function parametersOf(spec: OpenApiSpec, list: unknown): ApiEndpointParameter[] {
  if (!Array.isArray(list)) return [];
  const out: ApiEndpointParameter[] = [];
  for (const item of list) {
    const param = deref(spec, item);
    const name = nonEmptyString(param?.name);
    const location = nonEmptyString(param?.in);
    if (!param || !name || !location) continue;
    out.push({
      name,
      in: location,
      required: param.required === true || location === "path",
      description: nonEmptyString(param.description),
    });
  }
  return out;
}

/**
 * List the operations in an OpenAPI document: method, path and summary, plus
 * parameters and whether a body is accepted. Path-level parameters are merged
 * into each operation (an operation's own parameter with the same name and
 * location wins). Unknown methods and malformed entries are skipped. Paths
 * keep the document's order; methods within a path follow HTTP_METHODS.
 */
export function endpointsFromSpec(spec: OpenApiSpec | null | undefined): ApiEndpoint[] {
  const paths = asRecord(spec?.paths);
  if (!spec || !paths) return [];

  const endpoints: ApiEndpoint[] = [];
  for (const [path, rawItem] of Object.entries(paths)) {
    const item = deref(spec, rawItem);
    if (!item) continue;
    const shared = parametersOf(spec, item.parameters);

    for (const method of HTTP_METHODS) {
      const operation = deref(spec, item[method.toLowerCase()]);
      if (!operation) continue;

      const own = parametersOf(spec, operation.parameters);
      const ownKeys = new Set(own.map((p) => `${p.in}:${p.name}`));
      const parameters = [...shared.filter((p) => !ownKeys.has(`${p.in}:${p.name}`)), ...own];

      endpoints.push({
        method,
        path,
        summary: nonEmptyString(operation.summary) ?? nonEmptyString(operation.description),
        parameters,
        hasRequestBody: deref(spec, operation.requestBody) !== null,
      });
    }
  }

  return endpoints;
}

/** Access pass length bounds, mirrored from the server (#278). */
export const PASS_DURATION_MIN_HOURS = 1;
export const PASS_DURATION_MAX_HOURS = 30 * 24;

/** Human-readable pass length, e.g. "1 hour", "7 days", "1 day 6 hours". */
export function formatPassDuration(ms: number): string {
  const hourMs = 60 * 60 * 1000;
  const days = Math.floor(ms / (24 * hourMs));
  const hours = Math.floor((ms % (24 * hourMs)) / hourMs);
  const parts: string[] = [];
  if (days) parts.push(`${days} ${days === 1 ? "day" : "days"}`);
  if (hours) parts.push(`${hours} ${hours === 1 ? "hour" : "hours"}`);
  return parts.join(" ") || "1 hour";
}
