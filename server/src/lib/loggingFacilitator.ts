import { HTTPFacilitatorClient } from "@x402/core/server";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { getLogger } from "./logger.js";
import { gatewayFacilitatorRequests, gatewaySettlementFailures } from "./metrics.js";
import { withSpan } from "./spans.js";

function summarizeVerify(result: VerifyResponse): Record<string, unknown> {
  const r = result as VerifyResponse & {
    isValid?: boolean;
    valid?: boolean;
    invalidReason?: string;
    error?: string;
  };
  return {
    isValid: r.isValid ?? r.valid,
    invalidReason: r.invalidReason,
    error: r.error,
  };
}

function summarizeSettle(result: SettleResponse): Record<string, unknown> {
  const r = result as SettleResponse & {
    success?: boolean;
    error?: string;
    transaction?: string;
    txHash?: string;
  };
  return {
    success: r.success,
    error: r.error,
    transaction: r.transaction,
    txHash: r.txHash,
  };
}

export type FacilitatorFailureReason =
  | "unreachable"
  | "facilitator_5xx"
  | "facilitator_4xx"
  | "other";

/**
 * Sort a failed facilitator call into an outage class (#219). The x402 client
 * throws `Facilitator <op> failed (<status>)` for HTTP errors and a fetch error
 * when the facilitator cannot be reached.
 */
export function classifyFacilitatorError(err: unknown): FacilitatorFailureReason {
  const message = err instanceof Error ? err.message : String(err);
  const status = /failed \((\d{3})\)/.exec(message)?.[1];
  if (status) return Number(status) >= 500 ? "facilitator_5xx" : "facilitator_4xx";
  const cause = (err as { cause?: { code?: unknown } } | null)?.cause;
  const code = (err as { code?: unknown } | null)?.code ?? cause?.code;
  const name = (err as { name?: unknown } | null)?.name;
  if (
    /fetch failed/i.test(message) ||
    typeof code === "string" ||
    name === "AbortError" ||
    name === "TimeoutError"
  ) {
    return "unreachable";
  }
  return "other";
}

/**
 * HTTPFacilitatorClient wrapper that logs verify/settle outcomes with the active request id.
 */
export function createLoggingFacilitatorClient(url: string): HTTPFacilitatorClient {
  const inner = new HTTPFacilitatorClient({ url });

  return {
    url: inner.url,
    getSupported: (...args: Parameters<HTTPFacilitatorClient["getSupported"]>) =>
      inner.getSupported(...args),
    async verify(
      paymentPayload: PaymentPayload,
      paymentRequirements: PaymentRequirements,
    ): Promise<VerifyResponse> {
      const log = getLogger();
      const network = paymentRequirements.network;
      log.info({ event: "x402_verify", phase: "start", network }, "x402 verify");
      try {
        const result = await withSpan("x402.facilitator.verify", { "x402.network": network }, () =>
          inner.verify(paymentPayload, paymentRequirements),
        );
        log.info(
          { event: "x402_verify", phase: "complete", network, ...summarizeVerify(result) },
          "x402 verify",
        );
        const rejected = summarizeVerify(result).isValid === false;
        gatewayFacilitatorRequests.inc({
          operation: "verify",
          outcome: rejected ? "rejected" : "ok",
          reason: rejected ? "invalid" : "none",
        });
        return result;
      } catch (err) {
        const reason = classifyFacilitatorError(err);
        gatewayFacilitatorRequests.inc({ operation: "verify", outcome: "error", reason });
        log.error(
          { event: "x402_verify", phase: "error", network, reason, err },
          "x402 verify failed",
        );
        throw err;
      }
    },
    async settle(
      paymentPayload: PaymentPayload,
      paymentRequirements: PaymentRequirements,
    ): Promise<SettleResponse> {
      const log = getLogger();
      const network = paymentRequirements.network;
      log.info({ event: "x402_settle", phase: "start", network }, "x402 settle");
      try {
        const result = await withSpan("x402.facilitator.settle", { "x402.network": network }, () =>
          inner.settle(paymentPayload, paymentRequirements),
        );
        log.info(
          { event: "x402_settle", phase: "complete", network, ...summarizeSettle(result) },
          "x402 settle",
        );
        const rejected = result.success === false;
        if (rejected) gatewaySettlementFailures.inc();
        gatewayFacilitatorRequests.inc({
          operation: "settle",
          outcome: rejected ? "rejected" : "ok",
          reason: rejected ? "invalid" : "none",
        });
        return result;
      } catch (err) {
        gatewaySettlementFailures.inc();
        const reason = classifyFacilitatorError(err);
        gatewayFacilitatorRequests.inc({ operation: "settle", outcome: "error", reason });
        log.error(
          { event: "x402_settle", phase: "error", network, reason, err },
          "x402 settle failed",
        );
        throw err;
      }
    },
  } as HTTPFacilitatorClient;
}
