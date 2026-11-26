import { wrapFetchWithPayment, decodePaymentResponseHeader } from "@x402/fetch";
import type { x402Client } from "@x402/fetch";
import type { PaymentRequirements, PaymentResponse } from "@x402/core/types";
import { createFreighterX402Client } from "./x402Buy.js";
import { explorerTxUrl } from "./stellarExplorer.js";
import { findHeader } from "./requestBody.js";

/**
 * Result of an x402-paid HTTP call.
 */
export interface X402CallResult {
  /** HTTP status code of the final response. */
  status: number;
  /** Response headers, lower-cased. */
  headers: Record<string, string>;
  /** Parsed JSON body, or raw text if the body is not JSON. */
  body: unknown;
  /** Decoded payment response header, if the server returned one. */
  payment?: PaymentResponse;
}

/**
 * Build an x402 client that pays through the connected Freighter wallet.
 */
export function createX402Client(walletAddress: string): x402Client {
  return createFreighterX402Client(walletAddress);
}

/**
 * Normalize a base URL plus path/query into a single absolute URL string.
 *
 * - Joins the base and path with exactly one slash.
 * - Preserves any query string already present on the path.
 * - Leaves absolute URLs untouched.
 */
export function callUrl(
  baseUrl: string,
  path: string,
  query?: Record<string, string | number | boolean>,
): string {
  const isAbsolute = /^https?:\/\//i.test(path);
  const base = baseUrl.replace(/\/+$/, "");
  const suffix = path.replace(/^\/+/, "");
  let url = isAbsolute ? path : `${base}/${suffix}`;

  if (query && Object.keys(query).length > 0) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      params.append(key, String(value));
    }
    const separator = url.includes("?") ? "&" : "?";
    url = `${url}${separator}${params.toString()}`;
  }

  return url;
}

/**
 * Perform an x402-paid HTTP request against a ZentrixPay API endpoint.
 *
 * GET requests are sent without a body. A string body is sent exactly as
 * given; Content-Type is only defaulted (to JSON) for non-string bodies,
 * which are JSON-encoded. A Content-Type the caller set, in any letter case,
 * is never overwritten.
 */
export async function x402Call(
  client: x402Client,
  baseUrl: string,
  path: string,
  options: {
    method?: string;
    query?: Record<string, string | number | boolean>;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<X402CallResult> {
  const method = (options.method ?? "GET").toUpperCase();
  const url = callUrl(baseUrl, path, options.query);

  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  let body: string | undefined;

  if (method !== "GET" && options.body !== undefined) {
    if (typeof options.body === "string") {
      body = options.body;
    } else {
      body = JSON.stringify(options.body);
      if (findHeader(headers, "content-type") === undefined) {
        headers["content-type"] = "application/json";
      }
    }
  }

  const fetchWithPayment = wrapFetchWithPayment(fetch, client);

  const response = await fetchWithPayment(url, {
    method,
    headers,
    body,
  });

  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key.toLowerCase()] = value;
  });

  const paymentHeader = response.headers.get("x-payment-response");
  const payment = paymentHeader ? decodePaymentResponseHeader(paymentHeader) : undefined;

  const text = await response.text();
  let parsed: unknown = text;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json") && text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  return {
    status: response.status,
    headers: responseHeaders,
    body: parsed,
    payment,
  };
}

export async function callPaidApi(
  proxyUrl: string,
  walletAddress: string,
  options: {
    method: string;
    path: string;
    body?: string;
    headers?: Record<string, string>;
    price: string;
  },
): Promise<{
  status: number;
  charged: boolean;
  price: string;
  contentType: string;
  body: unknown;
  explorerUrl?: string;
}> {
  const client = createX402Client(walletAddress);
  const result = await x402Call(client, proxyUrl, options.path, {
    method: options.method,
    body: options.body,
    headers: options.headers,
  });
  const transaction = result.payment?.transaction;
  return {
    status: result.status,
    charged: result.status < 400 && Boolean(result.payment),
    price: options.price,
    contentType: result.headers["content-type"] ?? "",
    body: result.body,
    explorerUrl: transaction ? explorerTxUrl(transaction) : undefined,
  };
}

/**
 * Convenience helper: create a Freighter-backed client and perform a paid call.
 */
export async function x402CallWithWallet(
  walletAddress: string,
  baseUrl: string,
  path: string,
  options: {
    method?: string;
    query?: Record<string, string | number | boolean>;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<X402CallResult> {
  const client = createX402Client(walletAddress);
  return x402Call(client, baseUrl, path, options);
}

export type { PaymentRequirements, PaymentResponse };
