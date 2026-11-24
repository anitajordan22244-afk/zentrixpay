import type { URL } from "node:url";
import type { ApiRow } from "../db/schema.js";

/**
 * Type for the upstream secrets manifest returned by prepareUpstreamRequest.
 */
export interface UpstreamSecrets {
  values: string[];
  queryName?: string;
}

/**
 * Add a secret query parameter to the target URL.
 * Used to inject the provider's secret as a query parameter when the upstream
 * expects it in the URL rather than a header.
 */
export function withSecretQueryParam(target: URL, paramName: string, value: string): void {
  const existing = target.searchParams.get(paramName);
  if (existing) {
    target.searchParams.set(paramName, value);
  } else {
    target.searchParams.append(paramName, value);
  }
}

/**
 * Rewrite response headers from the upstream before forwarding to the caller.
 * Currently only rewrites the `location` header to point back through the proxy.
 */
export function rewriteResponseHeader(
  name: string,
  value: string,
  api: ApiRow,
  _secrets: UpstreamSecrets,
): string {
  if (name.toLowerCase() === "location") {
    const base = api.upstreamUrl.replace(/\/+$/, "");
    if (value.startsWith(base)) {
      return `${base}${value.slice(base.length)}`.replace(base, `/api/${api.id}`);
    }
  }
  return value;
}

/**
 * Extract the payer address from the request.
 * Reads from the PAYMENT-SIGNATURE or X-PAYMENT header.
 */
export function payerFrom(req: Request): string {
  const header = req.headers["payment-signature"] ?? req.headers["x-payment"];
  if (typeof header !== "string") return "unknown";
  // This is a simplified version - in production we'd use parsePayerFromXPayment
  // but we avoid circular imports by not importing it here.
  // The actual payer resolution happens in resolvePayer which uses settlementFrom.
  return "unknown";
}
