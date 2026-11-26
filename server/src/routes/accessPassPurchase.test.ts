import { beforeEach, describe, expect, it, vi } from "vitest";

// #275: a pass must only be created after the x402 payment is verified and
// settled, and must store the settlement transaction hash.

const x402 = vi.hoisted(() => ({
  processHTTPRequest: vi.fn(),
  processSettlement: vi.fn(),
  initialize: vi.fn(async () => undefined),
  routes: [] as unknown[],
}));
const passes = vi.hoisted(() => ({
  createApiPass: vi.fn(),
  getActivePass: vi.fn(),
}));
const payer = vi.hoisted(() => ({ address: undefined as string | undefined, signed: false }));

vi.mock("@x402/core/server", () => ({
  x402HTTPResourceServer: class {
    constructor(_server: unknown, routes: unknown) {
      x402.routes.push(routes);
    }
    initialize = x402.initialize;
    processHTTPRequest = x402.processHTTPRequest;
    processSettlement = x402.processSettlement;
  },
}));
vi.mock("@x402/express", () => ({ ExpressAdapter: class {} }));
vi.mock("../lib/x402.js", () => ({ sharedX402ResourceServer: {} }));
vi.mock("../config.js", () => ({ config: { NETWORK: "stellar:testnet" } }));
vi.mock("../lib/logger.js", () => ({
  getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock("../lib/payer.js", () => ({
  paymentHeader: (req: { headers: Record<string, unknown> }) => req.headers["x-payment"],
  payerFromPayment: (header: string | undefined) =>
    header ? payer : { address: undefined, signed: false },
}));
vi.mock("../services/apiService.js", () => passes);

import { buyAccessPass, clearPassServers } from "./accessPassPurchase.js";

const api = {
  id: "api-1",
  name: "Weather",
  walletAddress: "GPAYEE",
  passPrice: "2.00",
  passDurationMs: 24 * 3_600_000,
};

function run(headers: Record<string, unknown> = {}, apiRow: Record<string, unknown> = api) {
  const res: any = {
    locals: { api: apiRow },
    headersSent: false,
    headers: {} as Record<string, string>,
    statusCode: 200,
    body: undefined as unknown,
  };
  res.status = vi.fn((code: number) => ((res.statusCode = code), res));
  res.json = vi.fn((body: unknown) => ((res.body = body), res));
  res.send = vi.fn((body: unknown) => ((res.body = body), res));
  res.setHeader = vi.fn((name: string, value: string) => (res.headers[name] = value));
  const req: any = { headers, method: "POST", path: "/api/api-1/pass" };
  return buyAccessPass(req, res).then(() => res);
}

const challenge = {
  type: "payment-error",
  response: { status: 402, headers: { "PAYMENT-REQUIRED": "challenge" }, body: { x402Version: 2 } },
};
const verified = {
  type: "payment-verified",
  paymentPayload: { payload: "p" },
  paymentRequirements: { amount: "20000000" },
};

beforeEach(() => {
  vi.clearAllMocks();
  clearPassServers();
  x402.routes = [];
  payer.address = undefined;
  payer.signed = false;
  passes.getActivePass.mockResolvedValue(null);
  passes.createApiPass.mockImplementation(async (input: Record<string, unknown>) => ({
    id: "pass-1",
    expiresAt: new Date("2030-01-01T00:00:00Z"),
    ...input,
  }));
});

describe("buying an access pass (#275)", () => {
  it("a forged payment header gets 402 and no pass", async () => {
    payer.address = "GVICTIM";
    x402.processHTTPRequest.mockResolvedValue(challenge);
    const res = await run({ "x-payment": "forged" });
    expect(res.status).toHaveBeenCalledWith(402);
    expect(x402.processSettlement).not.toHaveBeenCalled();
    expect(passes.createApiPass).not.toHaveBeenCalled();
  });

  it("no payment header gets the 402 challenge", async () => {
    x402.processHTTPRequest.mockResolvedValue(challenge);
    const res = await run();
    expect(res.status).toHaveBeenCalledWith(402);
    expect(res.headers["PAYMENT-REQUIRED"]).toBe("challenge");
    expect(passes.createApiPass).not.toHaveBeenCalled();
  });

  it("a verified and settled payment gets a pass storing the settlement tx", async () => {
    payer.address = "GPAYER";
    payer.signed = true;
    x402.processHTTPRequest.mockResolvedValue(verified);
    x402.processSettlement.mockResolvedValue({
      success: true,
      transaction: "tx-abc",
      payer: "GPAYER",
      network: "stellar:testnet",
      headers: { "PAYMENT-RESPONSE": "settled" },
    });
    const res = await run({ "x-payment": "valid" });
    expect(res.status).toHaveBeenCalledWith(201);
    expect(passes.createApiPass).toHaveBeenCalledWith({
      apiId: "api-1",
      payerAddress: "GPAYER",
      amount: "2.00",
      txHash: "tx-abc",
      durationMs: 24 * 3_600_000,
    });
    expect(res.headers["PAYMENT-RESPONSE"]).toBe("settled");
    expect(res.body).toMatchObject({ passId: "pass-1", txHash: "tx-abc" });
  });

  it("a payment that fails to settle creates no pass", async () => {
    payer.address = "GPAYER";
    payer.signed = true;
    x402.processHTTPRequest.mockResolvedValue(verified);
    x402.processSettlement.mockResolvedValue({
      success: false,
      errorReason: "insufficient_funds",
      transaction: "",
      network: "stellar:testnet",
      headers: {},
      response: { status: 402, headers: {}, body: { error: "insufficient_funds" } },
    });
    const res = await run({ "x-payment": "valid" });
    expect(res.status).toHaveBeenCalledWith(402);
    expect(passes.createApiPass).not.toHaveBeenCalled();
  });

  it("charges the pass price to the API's payee on the Stellar network", async () => {
    x402.processHTTPRequest.mockResolvedValue(challenge);
    await run();
    expect(x402.routes[0]).toEqual({
      "/api/api-1/pass": expect.objectContaining({
        accepts: { scheme: "exact", network: "stellar:testnet", payTo: "GPAYEE", price: "2.00" },
      }),
    });
  });

  it("a wallet with an active pass is not charged again", async () => {
    payer.address = "GPAYER";
    payer.signed = true;
    x402.processHTTPRequest.mockResolvedValue(verified);
    passes.getActivePass.mockResolvedValue({ id: "pass-0", expiresAt: new Date() });
    const res = await run({ "x-payment": "valid" });
    expect(res.body).toMatchObject({ passId: "pass-0", message: "Pass already active" });
    expect(x402.processSettlement).not.toHaveBeenCalled();
    expect(passes.createApiPass).not.toHaveBeenCalled();
  });

  it("APIs without passes get 404", async () => {
    const res = await run({}, { ...api, passPrice: null });
    expect(res.status).toHaveBeenCalledWith(404);
    expect(x402.processHTTPRequest).not.toHaveBeenCalled();
  });
});
