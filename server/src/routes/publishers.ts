import { Router, type Router as RouterType } from "express";
import { apiKeyAuth } from "../middleware/apiKeyAuth.js";
import { validate } from "../middleware/validate.js";
import { publisherRegisterSchema } from "../schemas/requests.js";
import { requestSignatureAuth } from "../middleware/requestSignatureAuth.js";
import { registerIpRateLimit } from "../middleware/rateLimiters.js";
import { registerPublisher, rotatePublisherKey } from "../services/publisherService.js";
import { getPublisherAnalytics, getPublisherPayouts } from "../services/apiService.js";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { publishers } from "../db/schema.js";

const router: RouterType = Router();

// POST /publishers — register a new publisher (public, IP rate-limited)
router.post("/publishers", registerIpRateLimit, validate(publisherRegisterSchema), async (req, res) => {
  try {
    const { publisher, apiKey } = await registerPublisher(req.body);
    res.status(201).json({
      id: publisher.id,
      name: publisher.name,
      email: publisher.email,
      walletAddress: publisher.walletAddress,
      apiKey, // shown once — store it securely
      createdAt: publisher.createdAt,
    });
  } catch (err: any) {
    if (err.message?.includes("unique")) {
      res.status(409).json({ error: "Email already registered" });
      return;
    }
    throw err;
  }
});

// GET /publishers/wallet/:address — look up publisher by wallet (public)
router.get("/publishers/wallet/:address", async (req, res) => {
  const address = req.params.address as string;
  const publisher = await db
    .select({
      id: publishers.id,
      name: publishers.name,
      email: publishers.email,
      walletAddress: publishers.walletAddress,
      createdAt: publishers.createdAt,
    })
    .from(publishers)
    .where(eq(publishers.walletAddress, address))
    .then((rows) => rows[0] ?? null);

  if (!publisher) {
    res.status(404).json({ error: "No publisher found for this wallet" });
    return;
  }

  res.json(publisher);
});

// GET /publishers/me — own profile (authenticated)
router.get("/publishers/me", apiKeyAuth, async (req, res) => {
  const pub = req.publisher!;
  res.json({
    id: pub.id,
    name: pub.name,
    email: pub.email,
    walletAddress: pub.walletAddress,
    createdAt: pub.createdAt,
  });
});

// POST /publishers/me/rotate-key — issue a new API key and invalidate the old one (authenticated)
router.post("/publishers/me/rotate-key", apiKeyAuth, requestSignatureAuth, async (req, res) => {
  const { publisher, apiKey } = await rotatePublisherKey(req.publisher!.id);
  res.setHeader("Cache-Control", "no-store");
  res.json({
    id: publisher.id,
    apiKey, // shown once — store it securely
    rotatedAt: new Date().toISOString(),
  });
});

// GET /publishers/me/analytics — calls and revenue across all of the provider's APIs (authenticated)
router.get("/publishers/me/analytics", apiKeyAuth, async (req, res) => {
  res.json(await getPublisherAnalytics(req.publisher!.id));
});

/** Parse an optional ISO-8601 query value; `undefined` when absent, `null` when invalid. */
function parseDateParam(value: unknown): Date | undefined | null {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** RFC 4180 CSV cell: quote when needed and double embedded quotes. */
function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * GET /publishers/me/payouts?from&to[&format=csv]
 * Charged revenue grouped by payee wallet and API. `from` is inclusive, `to`
 * exclusive. Returns JSON by default, or a CSV attachment with format=csv.
 */
router.get("/publishers/me/payouts", apiKeyAuth, async (req, res) => {
  const from = parseDateParam(req.query.from);
  const to = parseDateParam(req.query.to);
  if (from === null || to === null) {
    return res.status(400).json({ error: "from and to must be ISO-8601 dates" });
  }
  if (from && to && from >= to) {
    return res.status(400).json({ error: "from must be before to" });
  }

  const payouts = await getPublisherPayouts(req.publisher!.id, { from, to });

  if (req.query.format === "csv") {
    const lines = [
      ["payee_wallet", "api_id", "api_name", "charged_calls", "revenue_usdc"].join(","),
      ...payouts.rows.map((row) =>
        [row.payeeWallet, row.apiId, row.apiName, row.chargedCalls, row.revenue].map(csvCell).join(","),
      ),
    ];
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="payouts.csv"');
    return res.send(lines.join("\n") + "\n");
  }

  return res.json(payouts);
});

export default router;
