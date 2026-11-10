import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import { and, eq, gt, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { apiCalls, apiPasses } from "../db/schema.js";
import { config } from "../config.js";
import { paymentHeader, payerFromPayment } from "../lib/payer.js";
import { getLogger } from "../lib/logger.js";
import { getApiById, getProxiedApi, type ApiRow } from "../services/apiService.js";

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
  const price = options.price ?? api.price ?? "$0.01";
  const network = options.network ?? config.NETWORK;
  const payTo = api.walletAddress;

  const router = Router();

  router.use(async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { sharedX402ResourceServer } = await import("../lib/x402.js");
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
        mimeType: options.mimeType,
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
 * Check whether the payer is allowed to call the API (denylist/allowlist) and
 * whether they hold an active pass (#30) or daily free-call quota (#32).
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

  const header = paymentHeader(req);
  const payer = header ? payerFromPayment(header) : { address: null, signed: false };
  const payerAddress = payer?.address ?? null;

  if (payerAddress && payer?.signed) {
    if (api.payerDenylist?.includes(payerAddress)) {
      res.status(403).json({ error: "This wallet is not allowed to call this API" });
      return;
    }
    if (api.payerAllowlist?.length && !api.payerAllowlist.includes(payerAddress)) {
      res.status(403).json({ error: "This API is restricted to approved wallets" });
      return;
    }
  }

  // ── Issue #30: active pass check ──────────────────────────────────────────
  if (payerAddress && typeof db?.select === "function") {
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
            sql`${apiPasses.activeFrom} <= now()`,
          ),
        )
        .limit(1);

      if (activePass) {
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
  const freeQuota = api.freeCallsPerDay ?? 0;
  if (freeQuota > 0 && payerAddress && typeof db?.select === "function") {
    try {
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

  res.locals.freeCall = false;
  next();
}

function runPaywallMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
  options: ApiPaywallOptions = {},
) {
  const api = res.locals.api as ApiRow | undefined;

  if (!api) {
    return res.status(500).json({ error: "apiPaywall requires res.locals.api" });
  }

  if (res.locals.passId || res.locals.freeCall || res.locals.creditPayer) {
    return next();
  }

  const price = options.priceForRequest
    ? options.priceForRequest(req, api)
    : (options.price ?? api.price ?? "$0.01");
  const network = options.network ?? config.NETWORK ?? "";
  res.locals.apiCallPrice = price;

  const cacheKey = `${api.id}:${price}:${network}`;

  let middleware = middlewareCache.get(cacheKey);
  if (!middleware) {
    middleware = buildMiddleware(api, { ...options, price, network });
    middlewareCache.set(cacheKey, middleware);
  }

  return middleware(req, res, next);
}

export function apiPaywall(
  reqOrOptions?: Request | ApiPaywallOptions,
  res?: Response,
  next?: NextFunction,
) {
  if (typeof next === "function" && reqOrOptions && res) {
    return runPaywallMiddleware(reqOrOptions as Request, res, next);
  }
  const options = (reqOrOptions as ApiPaywallOptions | undefined) ?? {};
  return (req: Request, response: Response, nextFn: NextFunction) =>
    runPaywallMiddleware(req, response, nextFn, options);
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

export async function loadProxiedApi(req: Request, res: Response, next: NextFunction) {
  const apiId = (req.params.apiId ?? req.params.id) as string | undefined;

  if (!apiId) {
    return res.status(404).json({ error: "API not found" });
  }

  let api: ApiRow | null = null;
  try {
    api = await getProxiedApi(apiId);
  } catch {
    api = await getApiById(apiId);
  }

  if (!api || !api.listed) {
    return res.status(404).json({ error: "API not found" });
  }

  if (api.healthy === false) {
    res.setHeader("Retry-After", "60");
    return res.status(503).json({ error: "upstream_unhealthy" });
  }

  const method = req.method.toUpperCase();
  const allowed = (api.allowedMethods ?? ["GET", "POST"]).map((m) => m.toUpperCase());

  if (!allowed.includes(method)) {
    res.setHeader("Allow", allowed.join(", "));
    return res.status(405).json({ error: `Method ${req.method} not allowed for this API` });
  }

  res.locals.api = api;
  return next();
}

export function clearApiPaywallCache() {
  middlewareCache.clear();
}
