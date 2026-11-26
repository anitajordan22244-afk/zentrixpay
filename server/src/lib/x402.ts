import { x402ResourceServer } from "@x402/core/server";
import { ExactStellarScheme } from "@x402/stellar/exact/server";
import type { Network } from "@x402/core/types";
import { config } from "../config.js";
import { createLoggingFacilitatorClient } from "./loggingFacilitator.js";

/**
 * The x402 network this server operates on (e.g. "stellar:testnet").
 * Exported so callers can reference it without importing config directly.
 */
export const network: string = config.NETWORK;

/**
 * A single shared x402 resource-server instance wired to the logging
 * facilitator client and registered with the Stellar exact-payment scheme for
 * the configured network.
 *
 * Consumers call `.middleware(...)` on this to generate per-route paywalls.
 */
export const sharedX402ResourceServer: x402ResourceServer = (() => {
  const facilitator = createLoggingFacilitatorClient(config.FACILITATOR_URL);
  const server = new x402ResourceServer(facilitator);
  server.register(network as Network, new ExactStellarScheme());
  return server;
})();
