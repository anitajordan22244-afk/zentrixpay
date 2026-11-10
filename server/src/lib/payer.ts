import { createHash } from "node:crypto";
import type { Request } from "express";
import {
  Address,
  Keypair,
  StrKey,
  Transaction,
  hash,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { networkPassphraseForX402 } from "@zentrixpay/registry-client";
import { config } from "../config.js";
import { parsePayerFromXPayment } from "./parseXPayment.js";

// Who is paying for a proxied call, read from the x402 payment header before
// the payment is verified or settled.
//
// An x402 Stellar payment carries a transaction invoking the USDC contract's
// transfer(from, to, amount); `from` is the payer. That claim is binding for
// charging purposes (the facilitator refuses a transfer `from` has not
// authorized), so it is enough to deny a wallet. To hand a stored response
// back without charging, `signed` additionally confirms that `from` signed
// the authorization, so nobody can claim someone else's wallet.

const NETWORK_PASSPHRASE = networkPassphraseForX402(config.NETWORK ?? "stellar:testnet");

export interface PaymentPayer {
  /** The paying wallet, if the header names one. */
  address: string | undefined;
  /** True when the header carries a valid signature by `address`. */
  signed: boolean;
}

export function paymentHeader(req: Request): string | undefined {
  const header = req.headers["payment-signature"] ?? req.headers["x-payment"];
  return typeof header === "string" && header ? header : undefined;
}

export function paymentHeaderHash(header: string): string {
  return createHash("sha256").update(header).digest("hex");
}

export function payerFromPayment(header: string | undefined): PaymentPayer {
  if (!header) return { address: undefined, signed: false };

  let decoded: { payload?: { transaction?: unknown } } | undefined;
  try {
    decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    return { address: undefined, signed: false };
  }
  const txXdr = decoded?.payload?.transaction;
  if (typeof txXdr !== "string") {
    // Not a Stellar payload; fall back to the legacy shapes (never signed).
    return { address: parsePayerFromXPayment(header).payer, signed: false };
  }

  try {
    const tx = new Transaction(txXdr, NETWORK_PASSPHRASE);
    const op = tx.operations[0];
    if (tx.operations.length !== 1 || op.type !== "invokeHostFunction") {
      return { address: undefined, signed: false };
    }
    const func = op.func;
    if (func.switch() !== xdr.HostFunctionType.hostFunctionTypeInvokeContract()) {
      return { address: undefined, signed: false };
    }
    const call = func.invokeContract();
    const args = call.args();
    if (call.functionName().toString() !== "transfer" || args.length !== 3) {
      return { address: undefined, signed: false };
    }
    const from = scValToNative(args[0]);
    if (typeof from !== "string" || !StrKey.isValidEd25519PublicKey(from)) {
      return { address: undefined, signed: false };
    }
    return { address: from, signed: isAuthorizedBy(tx, op.auth ?? [], from) };
  } catch {
    return { address: undefined, signed: false };
  }
}

/** Whether `from` signed the transfer, via an address auth entry or as the tx source. */
function isAuthorizedBy(
  tx: Transaction,
  auth: xdr.SorobanAuthorizationEntry[],
  from: string,
): boolean {
  const keypair = Keypair.fromPublicKey(from);
  const networkId = hash(Buffer.from(NETWORK_PASSPHRASE));

  for (const entry of auth) {
    const creds = entry.credentials();
    if (creds.switch() === xdr.SorobanCredentialsType.sorobanCredentialsSourceAccount()) {
      const source = tx.source;
      if (source !== from) continue;
      const txHash = tx.hash();
      if (tx.signatures.some((s) => safeVerify(keypair, txHash, s.signature()))) return true;
      continue;
    }

    const addrCreds = creds.address();
    if (Address.fromScAddress(addrCreds.address()).toString() !== from) continue;
    const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
      new xdr.HashIdPreimageSorobanAuthorization({
        networkId,
        nonce: addrCreds.nonce(),
        signatureExpirationLedger: addrCreds.signatureExpirationLedger(),
        invocation: entry.rootInvocation(),
      }),
    );
    const payload = hash(preimage.toXDR());
    // Account signatures are a vec of { public_key, signature } maps.
    const sigs = scValToNative(addrCreds.signature()) as unknown;
    if (!Array.isArray(sigs)) continue;
    for (const sig of sigs as Array<{ public_key?: unknown; signature?: unknown }>) {
      if (
        Buffer.isBuffer(sig.public_key) &&
        Buffer.isBuffer(sig.signature) &&
        sig.public_key.equals(keypair.rawPublicKey()) &&
        safeVerify(keypair, payload, sig.signature)
      ) {
        return true;
      }
    }
  }
  return false;
}

function safeVerify(keypair: Keypair, data: Buffer, signature: Buffer): boolean {
  try {
    return keypair.verify(data, signature);
  } catch {
    return false;
  }
}
