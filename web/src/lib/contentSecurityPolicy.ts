// Content-Security-Policy for the built web app (issue #213).
//
// Delivered as a <meta> tag, so directives that only work in response headers
// (frame-ancestors) are left out; set those at the host.
//
// The app renders provider-supplied names, descriptions and OpenAPI summaries,
// so a strict policy limits what an injected script could do. The policy is
// generated at build time so it can name the configured API and Sentry origins.
// Only origins the app actually calls are allowed:
//   - the ZentrixPay API (VITE_API_URL, or same origin when unset)
//   - Stellar Horizon and Soroban RPC for both networks (balance checks, contract reads)
//   - the Sentry ingest origin, when VITE_SENTRY_DSN is set

const STELLAR_HOSTS = [
  "https://horizon.stellar.org",
  "https://horizon-testnet.stellar.org",
  "https://soroban.stellar.org",
  "https://soroban-testnet.stellar.org",
];

/** Origin of an absolute URL, or null when it is missing or not a valid absolute URL. */
export function originOf(value: string | undefined | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

/** Sentry DSNs look like https://<key>@<host>/<project>; the ingest host is the DSN origin. */
function sentryOrigin(dsn: string | undefined | null): string | null {
  return originOf(dsn);
}

export interface CspOptions {
  apiBase?: string;
  sentryDsn?: string;
}

/** The full policy string. Scripts are same-origin only: no inline script, no eval. */
export function buildContentSecurityPolicy(options: CspOptions = {}): string {
  const connect = new Set<string>(["'self'", ...STELLAR_HOSTS]);
  const api = originOf(options.apiBase);
  if (api) connect.add(api);
  const sentry = sentryOrigin(options.sentryDsn);
  if (sentry) connect.add(sentry);

  const directives: Array<[string, string[]]> = [
    ["default-src", ["'self'"]],
    ["script-src", ["'self'"]],
    ["style-src", ["'self'"]],
    ["img-src", ["'self'", "data:", "https:"]],
    ["font-src", ["'self'", "data:"]],
    ["connect-src", [...connect]],
    ["worker-src", ["'self'"]],
    ["manifest-src", ["'self'"]],
    ["object-src", ["'none'"]],
    ["base-uri", ["'self'"]],
    ["form-action", ["'self'"]],
  ];
  return directives.map(([name, sources]) => `${name} ${sources.join(" ")}`).join("; ");
}
