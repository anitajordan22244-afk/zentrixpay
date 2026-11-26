import { getNetworkPreset, resolveStellarNetwork } from "@zentrixpay/registry-client";

export function explorerTxUrl(transactionHash: string): string {
  const network = resolveStellarNetwork(import.meta.env.VITE_STELLAR_NETWORK);
  const preset = getNetworkPreset(network);
  return `${preset.explorerBaseUrl}/explorer/${preset.explorerNetwork}/tx/${encodeURIComponent(transactionHash)}`;
}
