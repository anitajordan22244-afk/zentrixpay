import type { Response } from "express";

/**
 * Extract settlement information from the response headers set by the x402 middleware.
 * The x402 resource server sets `payment-response` header with the settlement details.
 */
export interface SettlementInfo {
  payer: string | undefined;
  transaction: string | undefined;
  network: string | undefined;
}

export function settlementFrom(res: Response): SettlementInfo {
  const header = res.getHeader("payment-response") ?? res.getHeader("x-payment-response");
  if (typeof header !== "string") {
    return { payer: undefined, transaction: undefined, network: undefined };
  }
  try {
    const parsed = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    return {
      payer: parsed.payer,
      transaction: parsed.transaction,
      network: parsed.network,
    };
  } catch {
    return { payer: undefined, transaction: undefined, network: undefined };
  }
}
