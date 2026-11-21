import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";

const { databaseUrl } = vi.hoisted(() => ({ databaseUrl: { value: "" } }));

vi.mock("../config.js", () => ({
  config: {
    get DATABASE_URL() {
      return databaseUrl.value;
    },
    WEBHOOK_MAX_ATTEMPTS: 3,
    WEBHOOK_RETRY_BASE_MS: 1_000,
    WEBHOOK_TIMEOUT_MS: 5_000,
  },
  upstreamKeyRing: [{ id: "k1", key: Buffer.alloc(32, 1) }],
}));

import * as schema from "../db/schema.js";
import { postgresApiCallRecordStore } from "../services/apiCallRecorder.js";
import { runWebhookDeliveries } from "./webhookDeliveryWorker.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describePg = testDatabaseUrl ? describe : describe.skip;

const entry = (callId: string) => ({
  eventId: `evt_${callId}`,
  apiId: 1,
  url: "https://provider.example/hooks",
  secretEnc: "enc",
  body: JSON.stringify({ id: `evt_${callId}` }),
});

describePg("webhook outbox (real Postgres)", () => {
  const schemaName = `zp_webhooks_${randomBytes(4).toString("hex")}`;
  let admin: postgres.Sql | undefined;
  let client: postgres.Sql | undefined;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    admin = postgres(testDatabaseUrl!, { max: 1, onnotice: () => {} });
    await admin.unsafe(`CREATE SCHEMA ${schemaName}`);
    await admin.unsafe(`
      CREATE TABLE ${schemaName}.api_calls (
        id text PRIMARY KEY, api_id integer NOT NULL, payer_address text NOT NULL,
        amount text NOT NULL, charged boolean NOT NULL, method text NOT NULL, path text NOT NULL,
        response_status integer NOT NULL, duration_ms integer NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE ${schemaName}.webhook_deliveries (
        id serial PRIMARY KEY, event_id text NOT NULL, api_id integer NOT NULL,
        url text NOT NULL, secret_enc text NOT NULL, body text NOT NULL,
        status text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz NOT NULL DEFAULT now(), last_error text,
        delivered_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX webhook_deliveries_event_id_idx ON ${schemaName}.webhook_deliveries (event_id);
    `);
    const scoped = new URL(testDatabaseUrl!);
    scoped.searchParams.set("options", `-c search_path=${schemaName}`);
    client = postgres(scoped.toString(), { max: 4, onnotice: () => {} });
    db = drizzle(client, { schema });
  });

  afterAll(async () => {
    await client?.end();
    await admin?.unsafe(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await admin?.end();
  });

  const callRow = (callId: string) => ({
    callId,
    apiId: 1,
    payerAddress: "GPAYER",
    amount: "0.01",
    charged: true,
    method: "GET",
    path: "/x",
    responseStatus: 200,
    durationMs: 12,
    createdAt: new Date().toISOString(),
    webhook: entry(callId),
  });

  it("writes the call and its webhook event together, once per event id", async () => {
    const store = postgresApiCallRecordStore(db as never);
    await store.insert(callRow("call-atomic-1"));
    await store.insert(callRow("call-atomic-1")); // retry is a no-op

    const calls =
      await client!`select count(*)::int as n from api_calls where id = 'call-atomic-1'`;
    const events =
      await client!`select count(*)::int as n from webhook_deliveries where event_id = 'evt_call-atomic-1'`;
    expect(calls[0].n).toBe(1);
    expect(events[0].n).toBe(1);
  });

  it("delivers an event after a restart: the outbox row survives and is retried later", async () => {
    await postgresApiCallRecordStore(db as never).insert(callRow("call-restart-1"));
    const t0 = new Date();

    // Process 1 is down before the first attempt. Simulate it failing instead.
    const first = await runWebhookDeliveries(db as never, {
      now: () => t0,
      deliver: async () => {
        throw new Error("connection refused");
      },
    });
    expect(first.retried).toBeGreaterThanOrEqual(1);

    // Process 2 (after restart): nothing is delivered before the backoff elapses.
    const early = await runWebhookDeliveries(db as never, {
      now: () => t0,
      deliver: async () => {},
    });
    expect(early.delivered).toBe(0);

    // Process 2 runs after the backoff: the event is delivered.
    const later = new Date(t0.getTime() + 60_000);
    const delivered: string[] = [];
    const second = await runWebhookDeliveries(db as never, {
      now: () => later,
      deliver: async (e) => {
        delivered.push(e.eventId);
      },
    });
    expect(second.delivered).toBeGreaterThanOrEqual(1);
    expect(delivered).toContain("evt_call-restart-1");

    const [row] =
      await client!`select status, attempts from webhook_deliveries where event_id = 'evt_call-restart-1'`;
    expect(row.status).toBe("delivered");
    expect(row.attempts).toBe(2);
  });

  it("marks an event failed after the maximum number of attempts", async () => {
    await postgresApiCallRecordStore(db as never).insert(callRow("call-giveup-1"));
    let now = new Date();
    for (let i = 0; i < 3; i++) {
      await runWebhookDeliveries(db as never, {
        now: () => now,
        maxAttempts: 3,
        deliver: async () => {
          throw new Error("HTTP 500");
        },
      });
      now = new Date(now.getTime() + 10 * 60_000);
    }
    const [row] =
      await client!`select status, attempts from webhook_deliveries where event_id = 'evt_call-giveup-1'`;
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(3);
  });
});
