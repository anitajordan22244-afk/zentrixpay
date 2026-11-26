import type { Request, Response } from "express";
import {
  x402HTTPResourceServer,
  type HTTPRequestContext,
  type HTTPResponseInstructions,
  type RoutesConfig,
} from "@x402/core/server";
import { ExpressAdapter } from "@x402/express";
import { passPaymentOptions } from "../lib/accessPass.js";
import { getLogger } from "../lib/logger.js";
import { paymentHeader, payerFromPayment } from "../lib/payer.js";
import { sharedX402ResourceServer } from "../lib/x402.js";
import { createApiPass, getActivePass, type ApiRow } from "../services/apiService.js";

// POST /api/:id/pass — buy a time-limited access pass (#30) with x402.
//
// The payment goes through the real x402 flow, exactly like a paid call (#275):
// the facilitator verifies the payment header against the pass price and the
// API's payee, then settles it on Stellar. A pass row is created only after
// settlement succeeds, and stores the settlement transaction hash. A forged or
// unsettled header gets the 402 challenge (or the facilitator's error), never
// a pass.
//
// Unlike a proxied call there is no upstream work that could fail after
// payment, so the payment is settled before the pass is created rather than
// after the response is written.

interface PassServer {
  http: x402HTTPResourceServer;
  ready: Promise<void> | null;
}

const passServers = new Map<string, PassServer>();

function passServerFor(api: ApiRow, options: ReturnType<typeof passPaymentOptions>): PassServer {
  const key = `${api.id}:${options.price}:${options.payTo}:${options.network}:${options.durationMs}`;
  let server = passServers.get(key);
  if (!server) {
    const routes: RoutesConfig = {
      [`/api/${api.id}/pass`]: {
        accepts: {
          scheme: "exact",
          network: options.network as `${string}:${string}`,
          payTo: options.payTo,
          price: options.price,
        },
        description: options.description,
        mimeType: "application/json",
      },
    };
    server = { http: new x402HTTPResourceServer(sharedX402ResourceServer, routes), ready: null };
    passServers.set(key, server);
  }
  return server;
}

async function ensureInitialized(server: PassServer): Promise<void> {
  if (!server.ready) {
    server.ready = server.http.initialize().catch((err) => {
      server.ready = null;
      throw err;
    });
  }
  await server.ready;
}

function send(res: Response, response: HTTPResponseInstructions): void {
  for (const [name, value] of Object.entries(response.headers)) res.setHeader(name, value);
  res.status(response.status);
  if (response.isHtml) res.send(response.body);
  else res.json(response.body ?? {});
}

export function clearPassServers(): void {
  passServers.clear();
}

export async function buyAccessPass(req: Request, res: Response): Promise<void> {
  const api = res.locals.api as ApiRow;
  if (!api.passPrice) {
    res.status(404).json({ error: "This API does not offer access passes" });
    return;
  }

  const options = passPaymentOptions(api);
  const server = passServerFor(api, options);
  const header = paymentHeader(req);
  const context: HTTPRequestContext = {
    adapter: new ExpressAdapter(req),
    path: `/api/${api.id}/pass`,
    method: req.method,
    paymentHeader: header,
  };

  try {
    await ensureInitialized(server);

    // Verify: no header, a forged header or the wrong amount / payee all come
    // back as a payment error (402 with the challenge).
    const result = await server.http.processHTTPRequest(context);
    if (result.type === "payment-error") {
      send(res, result.response);
      return;
    }
    if (result.type !== "payment-verified") {
      // The route always requires payment; anything else is a server bug.
      res.status(500).json({ error: "Pass payment could not be processed" });
      return;
    }

    // A wallet that already holds an active pass is not charged again. The
    // header is verified at this point, and only a header signed by the
    // paying wallet may claim its pass.
    const payer = payerFromPayment(header);
    if (payer.address && payer.signed) {
      const existing = await getActivePass(api.id, payer.address);
      if (existing) {
        res.json({
          passId: existing.id,
          expiresAt: existing.expiresAt,
          message: "Pass already active",
        });
        return;
      }
    }

    // Settle on-chain. Only a successful settlement creates a pass.
    const settlement = await server.http.processSettlement(
      result.paymentPayload,
      result.paymentRequirements,
      result.declaredExtensions,
      { request: context },
    );
    if (!settlement.success) {
      getLogger().warn(
        { event: "api_pass_settlement_failed", apiId: api.id, reason: settlement.errorReason },
        "pass payment did not settle; no pass created",
      );
      send(res, settlement.response);
      return;
    }
    for (const [name, value] of Object.entries(settlement.headers)) res.setHeader(name, value);

    const payerAddress = settlement.payer ?? payer.address;
    if (!payerAddress || !settlement.transaction) {
      getLogger().error(
        { event: "api_pass_settlement_incomplete", apiId: api.id, tx: settlement.transaction },
        "settlement returned no payer or transaction; no pass created",
      );
      res.status(502).json({ error: "Payment settled without a payer or transaction" });
      return;
    }

    try {
      const pass = await createApiPass({
        apiId: api.id,
        payerAddress,
        amount: options.price,
        txHash: settlement.transaction,
        durationMs: options.durationMs,
      });
      res.status(201).json({
        passId: pass.id,
        expiresAt: pass.expiresAt,
        txHash: pass.txHash,
        message: "Pass activated",
      });
    } catch (err) {
      // The payment is settled: log the transaction so the pass can be issued
      // by hand or the payment refunded.
      getLogger().error(
        {
          event: "api_pass_create_failed",
          apiId: api.id,
          payerAddress,
          tx: settlement.transaction,
          err,
        },
        "pass payment settled but the pass could not be stored",
      );
      res.status(500).json({ error: "Failed to create pass", txHash: settlement.transaction });
    }
  } catch (err) {
    getLogger().error(
      { event: "api_pass_payment_failed", apiId: api.id, err },
      "pass payment verification or settlement failed",
    );
    if (!res.headersSent) res.status(502).json({ error: "Payment facilitator unavailable" });
  }
}
