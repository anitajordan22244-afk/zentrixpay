import { withSpan } from "../lib/spans.js";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { Router } from "express";
import { and, eq, gt, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { apiCalls, apis, apiPasses } from "../db/schema.js";
import { config } from "../config.js";
import { paymentHeader, payerFromPayment } from "../lib/payer.js";
import { verifiedPayerFromRequest } from "../lib/payerAccessProof.js";
import { sharedX402ResourceServer } from "../lib/x402.js";
import { logger } from "../lib/logger.js";

type ApiRow = typeof apis.$inferSelect;

export interface ApiPaywallOptions {
  /** Fixed price that overrides the API's default and its price rules. */
  price?: string;
  /** Per-request price; takes precedence over the API's price rules. */
  priceForRequest?: (req: Request, api: ApiRow) => string;
  network?: string;
  description?: string;
  mimeType?: string;
  // x402 Bazaar discovery fields (#50)
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  category?: string;
}

type ResolvedPaywallOptions = ApiPaywallOptions & { price: string; network: string };

const middlewareCache = new Map<string, ReturnType<typeof buildMiddleware>>();

// One x402 middleware per (api, price, network). The price is resolved per
// request by the caller, so a cached middleware never changes price.
function buildMiddleware(api: ApiRow, options: ResolvedPaywallOptions) {
  const { price, network } = options;
  const payTo = api.walletAddress;

  const router = Router();

  router.use(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const resourceServer = await sharedX402ResourceServer({
        network,
        payTo,
        price,
      });

      const middleware = resourceServer.middleware({
        price,
        network,
        payTo,
        description: options.description ?? api.description ?? undefined,
        mimeType: options.mimeType ?? undefined,
        // Discovery metadata forwarded to the x402 resource server when supported
        ...(options.inputSchema !== undefined && { inputSchema: options.inputSchema }),
        ...(options.outputSchema !== undefined && { outputSchema: options.outputSchema }),
        ...(options.category !== undefined && { category: options.category }),
      });

      return middleware(req, res, next);
    } catch (err) {
      return next(err);
    }
  });

  return router;
}

/** The provider-facing path of a proxied call (`/` when the route has no `*path`). */
export function proxiedCallPath(req: Request): string {
  const pathParam = req.params.path as unknown;
  if (Array.isArray(pathParam)) {
    return pathParam.length ? `/${(pathParam as string[]).join("/")}` : "/";
  }
  return typeof pathParam === "string" && pathParam ? `/${pathParam}` : "/";
}

/**
 * Builds the x402 paywall for a proxied call. The price advertised in the 402
 * challenge is, in order: `options.price`, `options.priceForRequest`, the API's
 * most specific per-endpoint price rule for the method and path, and finally
 * the API's default price.
 */
export function createApiPaywall(options: ApiPaywallOptions = {}): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const api = res.locals.api as ApiRow | undefined;

    if (!api) {
      res.status(500).json({ error: "apiPaywall requires res.locals.api" });
      return;
    }

    // Already paid for or free: signed credit spend, active pass, free quota
    // or the owner's sandbox call.
    if (
      res.locals.creditPayer ||
      res.locals.passId ||
      res.locals.freeCall ||
      res.locals.ownerSandbox
    ) {
      next();
      return;
    }

    const price =
      options.price ??
      options.priceForRequest?.(req, api) ??
      resolveApiPrice(api, req.method, proxiedCallPath(req));
    res.locals.apiCallPrice = price;
    const network = options.network ?? config.NETWORK;
    const cacheKey = `${api.id}:${price}:${network}`;

    let middleware = middlewareCache.get(cacheKey);
    if (!middleware) {
      middleware = buildMiddleware(api, { ...options, price, network });
      middlewareCache.set(cacheKey, middleware);
    }

    middleware(req, res, next);
  };
}

/** The paywall with default options, mounted on the proxy route. */
export const apiPaywall: RequestHandler = createApiPaywall();

function matchesPathPattern(pattern: string, path: string): boolean {
  if (!pattern.includes("*")) return pattern === path;

  const parts = pattern.split("*");
  let offset = 0;
  if (parts[0]) {
    if (!path.startsWith(parts[0])) return false;
    offset = parts[0].length;
  }

  for (let index = 1; index < parts.length; index++) {
    const part = parts[index];
    if (!part) continue;
    if (index === parts.length - 1 && !pattern.endsWith("*")) {
      return path.endsWith(part) && path.length - part.length >= offset;
    }
    const foundAt = path.indexOf(part, offset);
    if (foundAt === -1) return false;
    offset = foundAt + part.length;
  }
  return pattern.endsWith("*") || offset === path.length;
}

export function resolveApiPrice(
  api: Pick<ApiRow, "price" | "priceRules">,
  method: string,
  path: string,
) {
  const matched = (api.priceRules ?? [])
    .filter((rule) => rule.method === method.toUpperCase())
    .filter((rule) => matchesPathPattern(rule.pathPattern, path))
    .sort((a, b) => {
      const wildcards =
        (a.pathPattern.match(/\*/g)?.length ?? 0) - (b.pathPattern.match(/\*/g)?.length ?? 0);
      if (wildcards !== 0) return wildcards;
      const literalLength =
        b.pathPattern.replace(/\*/g, "").length - a.pathPattern.replace(/\*/g, "").length;
      return literalLength;
    })[0];

  return matched?.price ?? api.price;
}

/**
 * Decides whether the payer may call this API and whether the x402 paywall can
 * be skipped for this request.
 *
 * Resolution order:
 *  1. Allow / deny lists — a signed payer on the deny list, or missing from a
 *     non-empty allow list, gets a 403.
 *  2. Owner sandbox (#229) — the provider's own key skips payment.
 *  3. Active pass (#30) — payer bought a time-limited pass; skip paywall.
 *  4. Free quota (#32)  — payer is within the provider's daily free-call
 *     allowance; consume one free call and skip paywall.
 *  Steps 1, 3 and 4 only use a wallet whose control is proven by a valid
 *  signature (#276); see lib/payerAccessProof.ts.
 *  5. Otherwise         — fall through to the normal x402 paywall.
 */
export async function checkPayerAccess(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const api = res.locals.api as ApiRow | undefined;

  if (!api) {
    res.status(500).json({ error: "checkPayerAccess requires res.locals.api" });
    return;
  }

  // Only a wallet the caller has proven control of (a signed X-Access-*
  // request or a signed x402 payment) can use a pass or free quota (#276).
  // A payment header that merely names a wallet is ignored here: addresses
  // are public, so trusting one would let anyone ride on a pass holder's pass
  // or mint fresh free quota with made-up addresses.
  const proof = verifiedPayerFromRequest(req, String(api.id));
  if (!proof.ok && proof.reason === "invalid") {
    res.status(401).json({ error: `Invalid access signature: ${proof.error}` });
    return;
  }
  const payerAddress = proof.ok ? proof.address : undefined;

  // ── Allow / deny lists ────────────────────────────────────────────────────
  if (payerAddress) {
    if (api.payerDenylist?.includes(payerAddress)) {
      res.status(403).json({ error: "This wallet is not allowed to call this API" });
      return;
    }
    if (api.payerAllowlist?.length && !api.payerAllowlist.includes(payerAddress)) {
      res.status(403).json({ error: "This API is restricted to approved wallets" });
      return;
    }
  }

  // ── Issue #229: owner sandbox ─────────────────────────────────────────────
  const providerKey = (api as { providerKey?: string }).providerKey;
  const headerKey =
    typeof req.headers["x-provider-key"] === "string" ? req.headers["x-provider-key"] : undefined;
  if (providerKey && headerKey && headerKey === providerKey) {
    res.locals.ownerSandbox = true;
    next();
    return;
  }

  // ── Issue #30: active pass check ──────────────────────────────────────────
  if (payerAddress) {
    try {
      const now = new Date();
      const [activePass] = await db
        .select({ id: apiPasses.id })
        .from(apiPasses)
        .where(
          and(
            eq(apiPasses.apiId, String(api.id)),
            eq(apiPasses.payerAddress, payerAddress),
            gt(apiPasses.expiresAt, now),
            // activeFrom must be in the past (handles pre-sold passes).
            sql`${apiPasses.activeFrom} <= now()`,
          ),
        )
        .limit(1);

      if (activePass) {
        logger.debug(
          { event: "api_pass_used", apiId: api.id, passId: activePass.id, payerAddress },
          "payer has active pass; skipping paywall",
        );
        res.locals.passId = activePass.id;
        res.locals.accessPayer = payerAddress;
        res.locals.freeCall = false;
        next();
        return;
      }
    } catch (err) {
      logger.warn(
        { event: "api_pass_check_failed", apiId: api.id, payerAddress, err },
        "pass check failed; falling through to paywall",
      );
    }
  }

  // ── Issue #32: free-calls quota check ────────────────────────────────────
  const freeQuota = api.freeCallsPerDay ?? 0;
  if (freeQuota > 0 && payerAddress) {
    try {
      // Count uncharged calls this payer has made to this API today (UTC).
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(apiCalls)
        .where(
          and(
            eq(apiCalls.apiId, api.id),
            eq(apiCalls.payerAddress, payerAddress),
            eq(apiCalls.charged, false),
            sql`${apiCalls.createdAt} >= date_trunc('day', now() at time zone 'UTC')`,
          ),
        );

      const usedToday = row?.count ?? 0;
      if (usedToday < freeQuota) {
        logger.debug(
          { event: "api_free_call", apiId: api.id, payerAddress, usedToday, freeQuota },
          "payer within free quota; skipping paywall",
        );
        res.locals.freeCall = true;
        // Recorded as this payer's call so it counts against the quota.
        res.locals.accessPayer = payerAddress;
        next();
        return;
      }
    } catch (err) {
      logger.warn(
        { event: "api_free_quota_check_failed", apiId: api.id, payerAddress, err },
        "free quota check failed; falling through to paywall",
      );
    }
  }

  res.locals.freeCall = false;
  next();
}

export function checkPayerAllowDeny(req: Request, res: Response, next: NextFunction) {
  const header = paymentHeader(req);
  if (!header) return next();

  const api = res.locals.api as ApiRow;
  const payer = payerFromPayment(header);
  if (!payer.address || !payer.signed) return next();
  if (api.payerDenylist?.includes(payer.address)) {
    return res.status(403).json({ error: "This wallet is not allowed to call this API" });
  }
  if (api.payerAllowlist?.length && !api.payerAllowlist.includes(payer.address)) {
    return res.status(403).json({ error: "This API is restricted to approved wallets" });
  }
  return next();
}

export async function loadProxiedApi(req: Request, res: Response, next: NextFunction) {
  const apiId = Number(req.params.apiId ?? req.params.id);

  if (!Number.isInteger(apiId) || apiId <= 0) {
    return res.status(404).json({ error: "API not found" });
  }

  const rows = await withSpan("paywall.lookup", { "zentrixpay.api.id": apiId }, () =>
    db.select().from(apis).where(eq(apis.id, apiId)).limit(1),
  );
  const api = rows[0];

  if (!api || !api.listed) {
    return res.status(404).json({ error: "API not found" });
  }

  const method = req.method.toUpperCase();
  const allowed = (api.allowedMethods ?? ["GET", "POST"]).map((m) => m.toUpperCase());

  if (!allowed.includes(method)) {
    res.setHeader("Allow", allowed.join(", "));
    return res.status(405).json({ error: "Method not allowed" });
  }

  res.locals.api = api;
  return next();
}

export function clearApiPaywallCache() {
  middlewareCache.clear();
}
