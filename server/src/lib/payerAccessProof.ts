import type { Request } from "express";
import { config } from "../config.js";
import {
  API_ACCESS_MESSAGE_TAG,
  apiCreditRequestBodyHash,
  verifyApiCreditSpendSignature,
  type ApiCreditSignatureError,
} from "./apiCreditSignature.js";
import { paymentHeader, payerFromPayment } from "./payer.js";
import { createTtlCache } from "./ttlCache.js";

// Proof that the caller controls the wallet a pass or free-quota call is
// granted to (#276). A wallet address alone is public (passes are bought
// on-chain), so it is never enough: the caller must either
//
//  1. sign the request with the access scheme (X-Access-* headers): the same
//     message as a credit spend (wallet, api, method, path, canonical query,
//     timestamp, nonce, body hash) under the `zentrixpay:api-access:v1` tag,
//     with a single-use nonce inside the clock-skew window; or
//  2. send an x402 payment whose transfer authorization is signed by the
//     paying wallet (payerFromPayment().signed).
//
// A payment header that only *names* a wallet (unsigned or a legacy shape)
// never proves anything.

export const ACCESS_HEADERS = [
  "x-access-wallet",
  "x-access-timestamp",
  "x-access-nonce",
  "x-access-signature",
] as const;

export type PayerAccessProof =
  | { ok: true; address: string; via: "signature" | "x402" }
  | { ok: false; reason: "none" }
  | {
      ok: false;
      reason: "invalid";
      error: ApiCreditSignatureError | "missing_headers" | "replayed_nonce";
    };

// Nonces seen inside the skew window. A signature outside the window is
// rejected on its timestamp, so remembering nonces for twice the window is
// enough to stop replays on this instance.
const seenNonces = createTtlCache<true>({
  defaultTtlMs: config.SIGNATURE_MAX_SKEW_MS * 2,
  maxSize: 100_000,
});

export function clearAccessNonces(): void {
  seenNonces.clear();
}

/** The wallet the caller has proven control of, if any. */
export function verifiedPayerFromRequest(req: Request, apiId: string): PayerAccessProof {
  const present = ACCESS_HEADERS.some((name) => req.headers[name] !== undefined);
  if (present) {
    const values = ACCESS_HEADERS.map((name) => req.headers[name]);
    if (values.some((value) => typeof value !== "string")) {
      return { ok: false, reason: "invalid", error: "missing_headers" };
    }
    const [walletAddress, timestamp, nonce, signature] = values as string[];
    const result = verifyApiCreditSpendSignature({
      walletAddress,
      apiId,
      method: req.method,
      path: req.originalUrl,
      timestamp,
      nonce,
      bodyHash: apiCreditRequestBodyHash(Buffer.isBuffer(req.body) ? req.body : undefined),
      signature,
      nowMs: Date.now(),
      maxSkewMs: config.SIGNATURE_MAX_SKEW_MS,
      tag: API_ACCESS_MESSAGE_TAG,
    });
    if (!result.ok) return { ok: false, reason: "invalid", error: result.error };

    const nonceKey = `${walletAddress}:${nonce}`;
    if (seenNonces.get(nonceKey)) {
      return { ok: false, reason: "invalid", error: "replayed_nonce" };
    }
    seenNonces.set(nonceKey, true);
    return { ok: true, address: walletAddress, via: "signature" };
  }

  const payer = payerFromPayment(paymentHeader(req));
  if (payer.address && payer.signed) {
    return { ok: true, address: payer.address, via: "x402" };
  }
  return { ok: false, reason: "none" };
}
