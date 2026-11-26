import { createHash } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";
import {
  EMPTY_BODY_HASH,
  hashRequestBody,
  isTimestampWithinSkew,
} from "../utils/requestSignature.js";

export function apiCreditRequestBodyHash(body: Buffer | undefined): string {
  return body ? hashRequestBody(body) : EMPTY_BODY_HASH;
}

/**
 * Prefix used by SEP-53 ("Stellar Signed Message"). Browser wallets such as
 * Freighter's signMessage sign sha256(prefix + message) rather than the raw
 * message, so both forms are accepted for the same message text.
 */
export const SEP53_MESSAGE_PREFIX = "Stellar Signed Message:\n";

/** SEP-53 digest of a message: sha256("Stellar Signed Message:\n" + message). */
export function sep53MessageDigest(message: Buffer): Buffer {
  return createHash("sha256")
    .update(Buffer.from(SEP53_MESSAGE_PREFIX, "utf8"))
    .update(message)
    .digest();
}

/**
 * The signed credit-spend message. Clients sign this exact text, either raw
 * (ed25519 over the bytes) or per SEP-53 (ed25519 over sha256 of the prefixed
 * bytes, as wallets do). Fields are joined with "\n" in this order.
 */
export const API_CREDIT_SPEND_MESSAGE_TAG = "zentrixpay:api-credit-spend:v2";

/**
 * Tag of the signed access message (#276). Same fields and signing rules as a
 * credit spend, but a different tag, so a signature proving wallet control for
 * a pass or free-quota call can never be replayed as a credit spend (or vice
 * versa).
 */
export const API_ACCESS_MESSAGE_TAG = "zentrixpay:api-access:v1";

/**
 * Canonical form of a request query string: parameters sorted by name then
 * value, re-encoded, without the leading "?". Reordered parameters therefore
 * sign the same, while any change to a name or value changes the signature.
 */
export function canonicalQueryString(query: string): string {
  const params = new URLSearchParams(query);
  const entries = [...params.entries()].sort(([a, av], [b, bv]) =>
    a === b ? (av < bv ? -1 : av > bv ? 1 : 0) : a < b ? -1 : 1,
  );
  return new URLSearchParams(entries).toString();
}

/**
 * The signed credit-spend message (version v2). Fields are joined with "\n":
 * tag, wallet, apiId, METHOD, path (without query), canonical query, timestamp,
 * nonce, body hash. The query string is signed explicitly so a signature for
 * one URL cannot be replayed with different query parameters.
 */
export function buildApiCreditSpendMessage(input: {
  walletAddress: string;
  apiId: string;
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  bodyHash: string;
  /** Message tag; defaults to the credit-spend tag. */
  tag?: string;
}): string {
  const queryIndex = input.path.indexOf("?");
  const pathname = queryIndex === -1 ? input.path : input.path.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : canonicalQueryString(input.path.slice(queryIndex + 1));
  return [
    input.tag ?? API_CREDIT_SPEND_MESSAGE_TAG,
    input.walletAddress,
    input.apiId,
    input.method.toUpperCase(),
    pathname,
    query,
    input.timestamp,
    input.nonce,
    input.bodyHash,
  ].join("\n");
}

export type ApiCreditSignatureError =
  | "invalid_wallet"
  | "invalid_timestamp"
  | "expired_timestamp"
  | "invalid_nonce"
  | "invalid_signature"
  | "signature_mismatch";

export function verifyApiCreditSpendSignature(input: {
  walletAddress: string;
  apiId: string;
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  bodyHash: string;
  signature: string;
  nowMs: number;
  maxSkewMs: number;
  /** Message tag; defaults to the credit-spend tag. */
  tag?: string;
}): { ok: true } | { ok: false; error: ApiCreditSignatureError } {
  let keypair: Keypair;
  try {
    keypair = Keypair.fromPublicKey(input.walletAddress);
  } catch {
    return { ok: false, error: "invalid_wallet" };
  }

  const timestamp = Number(input.timestamp);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return { ok: false, error: "invalid_timestamp" };
  }
  if (!isTimestampWithinSkew(timestamp, input.nowMs, input.maxSkewMs)) {
    return { ok: false, error: "expired_timestamp" };
  }
  if (!/^[A-Za-z0-9._~-]{16,128}$/.test(input.nonce)) {
    return { ok: false, error: "invalid_nonce" };
  }

  const signature = Buffer.from(input.signature, "base64");
  if (
    signature.length !== 64 ||
    signature.toString("base64").replace(/=+$/, "") !== input.signature.replace(/=+$/, "")
  ) {
    return { ok: false, error: "invalid_signature" };
  }

  const messageBytes = Buffer.from(buildApiCreditSpendMessage(input), "utf8");
  try {
    const valid =
      keypair.verify(messageBytes, signature) ||
      keypair.verify(sep53MessageDigest(messageBytes), signature);
    return valid ? { ok: true } : { ok: false, error: "signature_mismatch" };
  } catch {
    return { ok: false, error: "signature_mismatch" };
  }
}

export function apiCreditPurchaseReference(transaction: string | undefined, paymentHeader: string) {
  if (transaction) return transaction;
  return `payment:${createHash("sha256").update(paymentHeader).digest("hex")}`;
}
