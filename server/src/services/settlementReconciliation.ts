/**
 * Reconciles charged API calls against the settlement transactions that
 * actually landed on Stellar (issue #223). Report only; never mutates data.
 */

export interface ChargedCall {
  id: string;
  apiId: string;
  charged: boolean;
  settlementTx: string | null;
}

export interface HorizonTx {
  hash: string;
  successful: boolean;
}

export type MismatchKind =
  | "charged_without_settlement"
  | "settlement_not_on_chain"
  | "settlement_failed_on_chain";

export interface Mismatch {
  kind: MismatchKind;
  callId: string;
  apiId: string;
  settlementTx: string | null;
}

/**
 * Looks up one transaction on Horizon. Resolves to null when Horizon has no
 * record of the hash (404).
 */
export type TxLookup = (hash: string) => Promise<HorizonTx | null>;

export async function reconcileCalls(calls: ChargedCall[], lookup: TxLookup): Promise<Mismatch[]> {
  const mismatches: Mismatch[] = [];
  const cache = new Map<string, Promise<HorizonTx | null>>();
  const fetchOnce = (hash: string) => {
    let p = cache.get(hash);
    if (!p) {
      p = lookup(hash);
      cache.set(hash, p);
    }
    return p;
  };

  for (const call of calls) {
    if (!call.charged) continue;
    if (!call.settlementTx) {
      mismatches.push({
        kind: "charged_without_settlement",
        callId: call.id,
        apiId: call.apiId,
        settlementTx: null,
      });
      continue;
    }
    const tx = await fetchOnce(call.settlementTx);
    if (!tx) {
      mismatches.push({
        kind: "settlement_not_on_chain",
        callId: call.id,
        apiId: call.apiId,
        settlementTx: call.settlementTx,
      });
    } else if (!tx.successful) {
      mismatches.push({
        kind: "settlement_failed_on_chain",
        callId: call.id,
        apiId: call.apiId,
        settlementTx: call.settlementTx,
      });
    }
  }
  return mismatches;
}

/** Horizon lookup over HTTP. `baseUrl` has no trailing slash. */
export function horizonLookup(baseUrl: string, fetchImpl: typeof fetch = fetch): TxLookup {
  return async (hash) => {
    const res = await fetchImpl(`${baseUrl}/transactions/${encodeURIComponent(hash)}`, {
      headers: { accept: "application/json" },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Horizon returned ${res.status} for ${hash}`);
    const body = (await res.json()) as { hash: string; successful: boolean };
    return { hash: body.hash, successful: body.successful };
  };
}
