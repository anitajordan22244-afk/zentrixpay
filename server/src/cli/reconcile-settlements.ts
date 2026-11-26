/**
 * Read-only report: compares charged api_calls with Horizon settlement records.
 *   HORIZON_URL=https://horizon-testnet.stellar.org pnpm --filter @zentrixpay/server exec tsx src/cli/reconcile-settlements.ts
 * Exits 1 when mismatches are found. Nothing is written.
 */
import { eq, isNotNull, or } from "drizzle-orm";
import { db, pgClient } from "../db/client.js";
import { apiCalls } from "../db/schema.js";
import { horizonLookup, reconcileCalls } from "../services/settlementReconciliation.js";

const horizon = (process.env.HORIZON_URL ?? "https://horizon-testnet.stellar.org").replace(
  /\/$/,
  "",
);

const rows = await db
  .select({
    id: apiCalls.id,
    apiId: apiCalls.apiId,
    charged: apiCalls.charged,
    settlementTx: apiCalls.txHash,
  })
  .from(apiCalls)
  .where(or(eq(apiCalls.charged, true), isNotNull(apiCalls.txHash)));

const mismatches = await reconcileCalls(rows, horizonLookup(horizon));
for (const m of mismatches) {
  console.log(JSON.stringify({ event: "settlement_mismatch", ...m }));
}
console.log(`checked=${rows.length} mismatches=${mismatches.length}`);
await pgClient.end();
process.exit(mismatches.length > 0 ? 1 : 0);
