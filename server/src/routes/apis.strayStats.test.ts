import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

// #277: a leftover `router.get("/:id/stats")` was mounted at the server root
// with no authentication, leaking any API's revenue and recent callers. Only
// the owner-authenticated GET /apis/:id/stats may serve stats. Configuration
// is stubbed so the router loads without a database or network.
vi.hoisted(() => {
  Object.assign(process.env, {
    NODE_ENV: "test",
    NETWORK: "stellar:testnet",
    USDC_CONTRACT_ID: "CUSDCTESTCONTRACT",
    SOROBAN_RPC_URL: "https://soroban-testnet.example",
    DATABASE_URL: "postgres://stats:stats@127.0.0.1:5432/stats",
    REGISTRY_CONTRACT_ID: "CREGISTRYTESTCONTRACT",
    REGISTRY_SECRET_KEY: "SSTATSTESTSECRET",
  });
});

import router from "./apis.js";
import { apiKeyAuth } from "../middleware/apiKeyAuth.js";
import { walletSignatureAuth } from "../middleware/walletSignatureAuth.js";

interface Layer {
  handle?: unknown;
  route?: { path: string | string[]; methods: Record<string, boolean>; stack: Layer[] };
}

function routes() {
  return ((router as unknown as { stack: Layer[] }).stack ?? [])
    .filter((layer) => layer.route)
    .flatMap((layer) => {
      const route = layer.route!;
      const paths = Array.isArray(route.path) ? route.path : [route.path];
      const handlers = new Set(route.stack.map((l) => l.handle));
      const authenticated = handlers.has(apiKeyAuth) || handlers.has(walletSignatureAuth);
      return paths.map((path) => ({ path, authenticated }));
    });
}

describe("stray unauthenticated stats route (#277)", () => {
  it("GET /<id>/stats returns 404", async () => {
    const app = express();
    app.use(router);
    const res = await request(app).get("/1/stats");
    expect(res.status).toBe(404);
  });

  it("registers no route at the root with a bare :id segment", () => {
    // Routes left behind by merges showed up as "/:id/..." instead of
    // "/apis/:id/..." or "/api/:id/...".
    const strays = routes()
      .map((r) => r.path)
      .filter((path) => path.startsWith("/:"));
    expect(strays).toEqual([]);
  });

  it("serves stats and call history only behind owner authentication", () => {
    const leaky = routes()
      .filter((r) => /\/(stats|calls)(\b|\.|\/|$)/.test(r.path))
      .filter((r) => !r.authenticated)
      .map((r) => r.path);
    expect(leaky).toEqual([]);
  });
});
