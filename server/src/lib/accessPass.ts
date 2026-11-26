import { config } from "../config.js";
import { formatPassDuration, passDurationOf } from "./passDuration.js";

export {
  PASS_DURATION_DEFAULT_MS,
  PASS_DURATION_MAX_MS,
  PASS_DURATION_MIN_MS,
  formatPassDuration,
  passDurationOf,
} from "./passDuration.js";

// Access passes (#30): pay `passPrice` once, then call the API for free until
// the pass expires. Providers choose the duration (#278) within these bounds.

/**
 * x402 payment requirements for buying a pass. Always the gateway's Stellar
 * network (`config.NETWORK`): APIs have no network of their own.
 */
export function passPaymentOptions(api: {
  name: string;
  walletAddress: string;
  passPrice: string | null;
  passDurationMs?: number | null;
}) {
  if (!api.passPrice) throw new Error("This API does not offer access passes");
  const durationMs = passDurationOf(api);
  return {
    price: api.passPrice,
    network: config.NETWORK,
    payTo: api.walletAddress,
    durationMs,
    description: `Access pass for ${api.name} (${formatPassDuration(durationMs)})`,
  };
}
