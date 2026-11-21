import { withSpan } from "../lib/spans.js";
import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import { and, eq, gt, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { apiCalls, apis as apiTable, apiPasses } from "../db/schema.js";
import type { ApiRow } from "../db/schema.js";
import { config } from "../config.js";
import { paymentHeader, payerFromPayment } from "../lib/payer.js";
import { sharedX402ResourceServer } from "../lib/x402.js";
import { getLogger } from "../lib/logger.js";

export interface ApiPaywallOptions {
  price?: string;
  priceForRequest?: (req: Request, api: ApiRow) => string;
  network?: string;
  description?: string;
  mimeType?: string;
  // x402 Bazaar discovery fields (#50)
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  category?: string;
}

const middlewareCache = new Map<string, ReturnType<typeof buildMiddleware>>();

function buildMiddleware(api: ApiRow, options: ApiPaywallOptions) {
  let price = options.price ?? api.price ?? "$0.01";
  const network = options.network ?? config.NETWORK;
  const payTo = api.walletAddress;

  const router = Router();

  router.use(async (req: Request, res: Response, next: NextFunction) => {
    // Determine payer from payment header
    const payer = payerFromPayment(req.headers[paymentHeader]);
    // If the API defines tiered price rules, compute the price based on usage this month
    if (api.price_rules && Array.isArray(api.price_rules) && api.price_rules.length > 0 && payer) {
      try {
        // Count calls for this payer and API in the current calendar month
        const now = new Date();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
        const [{ count }] = await db
          .select({ count: sql<number>`count(*)` })
          .from(apiCalls)
          .where(
            and(
              eq(apiCalls.apiId, api.id),
              eq(apiCalls.payer, payer),
              gt(apiCalls.createdAt, monthStart),
            ),
          );
        // Find the appropriate tier
        const sortedRules = [...api.price_rules].sort(
          (a: any, b: any) => (a.upTo ?? Infinity) - (b.upTo ?? Infinity),
        );
        for (const rule of sortedRules) {
          const limit = rule.upTo ?? Infinity;
          if (count < limit) {
            price = rule.price;
            break;
          }
        }
        // If no rule matched, use the last rule's price
        if (!price) {
          price = sortedRules[sortedRules.length - 1].price;
        }
      } catch (e) {
        // If tier calculation fails, fall back to default price
        console.error("Tier pricing calculation error:", e);
      }
    }
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
        mimeType: options.mimeType ?? api.mimeType ?? undefined,
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

/**
 * Issue #30 / #32: Check whether the payer already has free or paid access so
 * the x402 paywall can be skipped for this request.
 *
 * Resolution order:
 *  1. Active pass (#30) — payer bought a time-limited pass; skip paywall.
 *  2. Free quota (#32)  — payer is within the provider's daily free-call
 *     allowance; consume one free call and skip paywall.
 *  3. Neither             — fall through to the normal x402 paywall.
 *
 * The payer address is extracted from the X-Payment / payment-signature header
 * when present. If no payment header is attached and no free quota applies,
 * the request falls through to the paywall which will issue the 402 challenge.
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

  // Sandbox mode: if the request includes the provider's secret key, bypass payment.
  // The provider key is stored on the API row (e.g., `providerKey`).
  // This allows the API owner to test their endpoint without incurring charges.
  const providerKey = (api as any).providerKey;
  const headerKey =
    typeof req.headers["x-provider-key"] === "string"
      ? (req.headers["x-provider-key"] as string)
      : undefined;
  if (providerKey && headerKey && headerKey === providerKey) {
    // Mark the request as an owner sandbox call for downstream stats handling.
    (res.locals as any).ownerSandbox = true;
    return next();
  }

  // Derive the payer address from the payment header (may be absent on the
  // first unanswered 402 challenge).
  const header = paymentHeader(req);
  const { address: payerAddress } = payerFromPayment(header);

  // ── Issue #30: active pass check ──────────────────────────────────────────
  if (payerAddress) {
    try {
      const now = new Date();
      const [activePass] = await db
        .select({ id: apiPasses.id })
        .from(apiPasses)
        .where(
          and(
            eq(apiPasses.apiId, api.id),
            eq(apiPasses.payerAddress, payerAddress),
            gt(apiPasses.expiresAt, now),
            // activeFrom must be in the past (handles pre-sold passes).
            sql`${apiPasses.activeFrom} <= now()`,
          ),
        )
        .limit(1);

      if (activePass) {
        // Payer holds an active pass — bypass the paywall entirely.
        getLogger().debug(
          { event: "api_pass_used", apiId: api.id, passId: activePass.id, payerAddress },
          "payer has active pass; skipping paywall",
        );
        res.locals.passId = activePass.id;
        res.locals.freeCall = false;
        next();
        return;
      }
    } catch (err) {
      getLogger().warn(
        { event: "api_pass_check_failed", apiId: api.id, payerAddress, err },
        "pass check failed; falling through to paywall",
      );
    }
  }

  // ── Issue #32: free-calls quota check ────────────────────────────────────
  // Only applies when the API has a non-zero free-calls-per-day allowance and
  // we can identify the payer from the payment header.
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
            // today in UTC
            sql`${apiCalls.createdAt} >= date_trunc('day', now() at time zone 'UTC')`,
          ),
        );

      const usedToday = row?.count ?? 0;
      if (usedToday < freeQuota) {
        // Under quota: skip paywall and mark this as a free call so the
        // downstream recorder knows not to charge.
        getLogger().debug(
          {
            event: "api_free_call",
            apiId: api.id,
            payerAddress,
            usedToday,
            freeQuota,
          },
          "payer within free quota; skipping paywall",
        );
        res.locals.freeCall = true;
        next();
        return;
      }
    } catch (err) {
      getLogger().warn(
        { event: "api_free_quota_check_failed", apiId: api.id, payerAddress, err },
        "free quota check failed; falling through to paywall",
      );
    }
  }

  // Neither condition met — continue to the x402 paywall.
  res.locals.freeCall = false;
  next();
}

export function apiPaywall(options: ApiPaywallOptions = {}) {
  return (req: Request, res: Response, next: NextFunction) => {
    const api = res.locals.api as ApiRow | undefined;

    if (!api) {
      return res.status(500).json({ error: "apiPaywall requires res.locals.api" });
    }

    // If checkPayerAccess already cleared this request (active pass or free
    // quota), skip the paywall entirely.
    if (res.locals.passId || res.locals.freeCall) {
      return next();
    }

    const cacheKey = `${api.id}:${options.price ?? api.price ?? ""}:${options.network ?? api.network ?? ""}`;

    let middleware = middlewareCache.get(cacheKey);
    if (!middleware) {
      middleware = buildMiddleware(api, { ...options, price, network });
      middlewareCache.set(cacheKey, middleware);
    }

    return middleware(req, res, next);
  };
}

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

export function checkPayerAccess(req: Request, res: Response, next: NextFunction) {
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
  const apiId = req.params.apiId ?? req.params.id;

  if (!apiId) {
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
