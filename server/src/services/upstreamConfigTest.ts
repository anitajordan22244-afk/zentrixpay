import { config, upstreamKeyRing } from "../config.js";
import type { apis } from "../db/schema.js";
import {
  streamUpstream,
  UpstreamError,
  type UpstreamErrorKind,
  type UpstreamRequest,
  type UpstreamStreamResponse,
} from "../lib/upstreamClient.js";
import { decryptSecret } from "../utils/secretBox.js";

type ApiRow = typeof apis.$inferSelect;

/** A test never waits longer than this, whatever the API's own timeout is. */
export const UPSTREAM_TEST_MAX_TIMEOUT_MS = 10_000;

export type UpstreamTestErrorKind = UpstreamErrorKind | "config";

/**
 * What a provider gets back from a configuration test (#142). Only status,
 * timing and a content type: never upstream headers, body or secret values.
 */
export interface UpstreamTestResult {
  /** True when the upstream answered with a 2xx or 3xx status. */
  ok: boolean;
  /** Upstream HTTP status, or null when no response arrived. */
  status: number | null;
  /** Time until the upstream's status line and headers arrived (or the failure). */
  latencyMs: number;
  /** Media type of the upstream response, without parameters. */
  contentType: string | null;
  /** The request that was made. The path has no query string, so query secrets never appear. */
  request: { method: "GET"; path: string; usedHeaderSecret: boolean; usedQuerySecret: boolean };
  error: { kind: UpstreamTestErrorKind; message: string } | null;
  /** Short, human-readable reading of the result. */
  diagnosis: string;
  /** Tests bypass the paywall: no payment is requested or settled. */
  charged: false;
  testedAt: string;
}

export interface UpstreamTestDeps {
  stream: (req: UpstreamRequest) => Promise<UpstreamStreamResponse>;
  decrypt: (encoded: string) => string;
  now: () => number;
  allowPrivate: boolean;
  defaultTimeoutMs: number;
}

const defaultDeps: UpstreamTestDeps = {
  stream: streamUpstream,
  decrypt: (encoded) => decryptSecret(encoded, upstreamKeyRing, config.UPSTREAM_SECRET_KEY),
  now: Date.now,
  get allowPrivate() {
    return config.PROXY_ALLOW_PRIVATE_UPSTREAMS;
  },
  get defaultTimeoutMs() {
    return config.PROXY_DEFAULT_TIMEOUT_MS;
  },
};

/** The URL a test calls: the API's healthPath when set, otherwise the upstream URL itself. */
export function upstreamTestUrl(api: Pick<ApiRow, "upstreamUrl" | "healthPath">): URL {
  const base = new URL(api.upstreamUrl);
  if (!api.healthPath) return base;
  const target = new URL(base.origin);
  const basePath = base.pathname.replace(/\/+$/, "");
  const [path, query = ""] = api.healthPath.split("?", 2);
  target.pathname = `${basePath}${path}`;
  target.search = [base.search.slice(1), query].filter(Boolean).join("&");
  return target;
}

/**
 * Every form a secret can take inside text: the raw value, plus its
 * URL-encoded and form-encoded forms (what a URL or a query string echoes
 * back when the value contains reserved characters such as "+", "/" or "=").
 */
function secretForms(secret: string): string[] {
  const forms = new Set<string>([secret, encodeURIComponent(secret)]);
  forms.add(new URLSearchParams([["v", secret]]).toString().slice(2));
  forms.add(encodeURIComponent(encodeURIComponent(secret)));
  return [...forms].filter(Boolean);
}

/** Remove any secret value (in any encoded form) from text that may be shown to the provider. */
function scrub(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    // Longest forms first so a shorter form cannot break up a longer match.
    for (const form of secretForms(secret).sort((a, b) => b.length - a.length)) {
      out = out.split(form).join("***");
    }
  }
  return out;
}

function diagnose(status: number | null, error: UpstreamTestResult["error"]): string {
  if (error) {
    switch (error.kind) {
      case "config":
        return "The saved upstream secret could not be read. Save the secret again.";
      case "blocked":
        return "The upstream host resolves to a private or reserved address and cannot be called.";
      case "timeout":
        return "The upstream did not respond in time.";
      case "too_large":
        return "The upstream response was too large.";
      default:
        return "The upstream could not be reached.";
    }
  }
  if (status === null) return "The upstream could not be reached.";
  if (status === 401 || status === 403)
    return "The upstream rejected the request. Check the saved secret header or query parameter.";
  if (status === 404)
    return "The upstream path was not found. Check the upstream URL or health path.";
  if (status >= 500) return "The upstream answered with a server error.";
  if (status >= 400) return "The upstream answered with a client error.";
  return "The upstream is reachable.";
}

/**
 * Send one unpaid GET to the API's saved upstream configuration (URL, health
 * path, secret header and query parameter) and report status and latency.
 *
 * Bounded: the wait is capped at UPSTREAM_TEST_MAX_TIMEOUT_MS and the
 * response body is never read; the connection is closed as soon as the
 * status line arrives. Private upstreams stay blocked unless the server
 * allows them.
 */
export async function testUpstreamConfig(
  api: ApiRow,
  deps: UpstreamTestDeps = defaultDeps,
): Promise<UpstreamTestResult> {
  const url = upstreamTestUrl(api);
  const headers: Record<string, string> = {
    accept: "*/*",
    "user-agent": "ZentrixPay-UpstreamTest/1.0",
  };
  const secrets: string[] = [];
  const request: UpstreamTestResult["request"] = {
    method: "GET",
    path: url.pathname,
    usedHeaderSecret: false,
    usedQuerySecret: false,
  };
  const timeoutMs = Math.min(api.timeoutMs ?? deps.defaultTimeoutMs, UPSTREAM_TEST_MAX_TIMEOUT_MS);
  const finish = (
    started: number,
    status: number | null,
    contentType: string | null,
    error: UpstreamTestResult["error"],
  ): UpstreamTestResult => ({
    ok: !error && status !== null && status >= 200 && status < 400,
    status,
    latencyMs: Math.max(0, Math.round(deps.now() - started)),
    contentType,
    request,
    error,
    diagnosis: diagnose(status, error),
    charged: false,
    testedAt: new Date(deps.now()).toISOString(),
  });

  const started = deps.now();
  try {
    if (api.upstreamHeaderName && api.upstreamHeaderValueEnc) {
      const value = deps.decrypt(api.upstreamHeaderValueEnc);
      headers[api.upstreamHeaderName] = value;
      secrets.push(value);
      request.usedHeaderSecret = true;
    }
    if (api.upstreamQueryName && api.upstreamQueryValueEnc) {
      const value = deps.decrypt(api.upstreamQueryValueEnc);
      url.searchParams.set(api.upstreamQueryName, value);
      secrets.push(value);
      request.usedQuerySecret = true;
    }
  } catch {
    return finish(started, null, null, {
      kind: "config",
      message: "saved upstream secret could not be decrypted",
    });
  }

  try {
    const upstream = await deps.stream({
      url,
      method: "GET",
      headers,
      timeoutMs,
      maxResponseBytes: 0,
      allowPrivate: deps.allowPrivate,
    });
    // Only the status line matters; drop the body unread.
    upstream.stream.destroy();
    const rawType = upstream.headers["content-type"];
    const contentType =
      typeof rawType === "string" ? rawType.split(";")[0].trim().toLowerCase() || null : null;
    return finish(started, upstream.status, contentType, null);
  } catch (err) {
    const kind: UpstreamErrorKind = err instanceof UpstreamError ? err.kind : "network";
    const message = err instanceof Error ? err.message : "upstream request failed";
    return finish(started, null, null, { kind, message: scrub(message, secrets) });
  }
}
