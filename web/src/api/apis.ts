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

export async function fetchApiStats(apiKey: string, id: string): Promise<ApiStats> {
  return readJson(await signedPublisherFetch(absolute(`/apis/${id}/stats`), apiKey));
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
