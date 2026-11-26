import {
  check,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  index,
  uniqueIndex,
  serial,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";

export const onchainStatusEnum = pgEnum("onchain_status_enum", [
  "none",
  "pending",
  "registered",
  "failed",
]);

export interface ApiPriceRule {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  pathPattern: string;
  price: string;
}

// Publishers — providers that sell API calls through the gateway
export const publishers = pgTable("publishers", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => createId()),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  walletAddress: text("wallet_address").notNull(),
  apiKeyHash: text("api_key_hash").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// APIs — upstream HTTP APIs that providers sell per call through the proxy
export const apis = pgTable(
  "apis",
  {
    // CUID text IDs preserve existing rows and are the public /api/:id identifier.
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    // Owning provider (migration 0009_api_proxy.sql).
    publisherId: text("publisher_id")
      .notNull()
      .references(() => publishers.id),
    name: text("name").notNull(),
    description: text("description"),
    // Never exposed publicly: callers must go through the paid proxy.
    upstreamUrl: text("upstream_url").notNull(),
    price: text("price").notNull(), // USDC per call
    priceRules: jsonb("price_rules").$type<ApiPriceRule[]>().notNull().default([]),
    // Price change notice (#228): `scheduledPrice` replaces `price` at `effectiveAt`.
    scheduledPrice: text("scheduled_price"),
    effectiveAt: timestamp("effective_at", { withTimezone: true }),
    walletAddress: text("wallet_address").notNull(),
    allowedMethods: jsonb("allowed_methods").$type<string[]>().notNull().default(["GET"]),
    payerAllowlist: jsonb("payer_allowlist").$type<string[] | null>(),
    payerDenylist: jsonb("payer_denylist").$type<string[]>().notNull().default([]),
    // Header the proxy adds to every upstream request, e.g. the provider's own
    // API key. The value is AES-256-GCM encrypted (see utils/secretBox.ts).
    upstreamHeaderName: text("upstream_header_name"),
    upstreamHeaderValueEnc: text("upstream_header_value_enc"),
    // Query parameter the proxy adds to every upstream URL, for APIs that take
    // their key as ?api_key=…. Encrypted like the header value.
    upstreamQueryName: text("upstream_query_name"),
    upstreamQueryValueEnc: text("upstream_query_value_enc"),
    // Provider-supplied OpenAPI 3 document, stored as uploaded (it may name the
    // upstream; the public copy is rewritten, see services/openApiSpec.ts).
    openapiSpec: jsonb("openapi_spec").$type<Record<string, unknown>>(),
    timeoutMs: integer("timeout_ms"),
    // Per-API response cap; never above PROXY_MAX_RESPONSE_BYTES (#37).
    maxResponseBytes: integer("max_response_bytes"),
    // Signed event POSTed after each charged call (#36). The secret is
    // AES-256-GCM encrypted like the upstream header value.
    webhookUrl: text("webhook_url"),
    webhookSecretEnc: text("webhook_secret_enc"),
    // Issue #211: during a rotation the previous secret keeps signing until
    // webhookPreviousSecretExpiresAt, so receivers can switch without downtime.
    webhookPreviousSecretEnc: text("webhook_previous_secret_enc"),
    webhookPreviousSecretExpiresAt: timestamp("webhook_previous_secret_expires_at"),
    // Upstream health (#35): healthPath is pinged relative to upstreamUrl;
    // unhealthy APIs are hidden from the catalog until a check succeeds.
    healthPath: text("health_path"),
    healthy: boolean("healthy").notNull().default(true),
    healthFailures: integer("health_failures").notNull().default(0),
    lastHealthCheckAt: timestamp("last_health_check_at"),
    ownershipToken: text("ownership_token").notNull(),
    ownershipVerifiedAt: timestamp("ownership_verified_at"),
    listed: boolean("listed").notNull().default(false),
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    // Issue #30: price callers pay for a time-limited access pass (null = passes not offered).
    passPrice: text("pass_price"),
    // Issue #278: how long a purchased pass lasts (1 hour .. 30 days, migration 0017).
    passDurationMs: integer("pass_duration_ms").notNull().default(3_600_000),
    // Issue #32: free calls a new wallet may make per day before the paywall kicks in (0 = disabled).
    freeCallsPerDay: integer("free_calls_per_day").notNull().default(0),
    // On-chain anchoring (migration 0018_api_gateway_extensions.sql).
    onchainStatus: onchainStatusEnum("onchain_status").notNull().default("none"),
    onchainTxHash: text("onchain_tx_hash"),
    // Streaming proxy support (migration 0023_streaming_enabled.sql).
    streamingEnabled: boolean("streaming_enabled").notNull().default(false),
    // Per-API network override (falls back to server config.NETWORK when null).
    network: text("network"),
    // Soft delete: archived APIs are hidden everywhere but keep their call history.
    archivedAt: timestamp("archived_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    // Match the indexes created in migration 0009_api_proxy.sql.
    publisherIdx: index("idx_apis_publisher_id").on(table.publisherId),
    listedCreatedAtIdx: index("idx_apis_listed_created_at").on(table.listed, table.createdAt),
  }),
);

export const apiCreditBalances = pgTable(
  "api_credit_balances",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    apiId: text("api_id")
      .notNull()
      .references(() => apis.id),
    walletAddress: text("wallet_address").notNull(),
    balance: integer("balance").notNull().default(0),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    apiWalletIdx: uniqueIndex("idx_api_credit_balances_api_wallet").on(
      table.apiId,
      table.walletAddress,
    ),
    nonNegativeBalance: check("api_credit_balances_balance_check", sql`${table.balance} >= 0`),
  }),
);

export const apiCreditLedger = pgTable(
  "api_credit_ledger",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    apiId: text("api_id")
      .notNull()
      .references(() => apis.id),
    walletAddress: text("wallet_address").notNull(),
    delta: integer("delta").notNull(),
    entryType: text("entry_type").$type<"purchase" | "spend">().notNull(),
    reference: text("reference"),
    requestNonce: text("request_nonce"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    purchaseReferenceIdx: uniqueIndex("idx_api_credit_ledger_purchase_reference")
      .on(table.reference)
      .where(sql`${table.entryType} = 'purchase'`),
    spendNonceIdx: uniqueIndex("idx_api_credit_ledger_spend_nonce")
      .on(table.apiId, table.walletAddress, table.requestNonce)
      .where(sql`${table.entryType} = 'spend'`),
    apiWalletCreatedIdx: index("idx_api_credit_ledger_api_wallet_created").on(
      table.apiId,
      table.walletAddress,
      table.createdAt,
    ),
    validEntryType: check(
      "api_credit_ledger_entry_type_check",
      sql`${table.entryType} in ('purchase', 'spend')`,
    ),
  }),
);

// API calls — one row per proxied call, charged or not
export const apiCalls = pgTable(
  "api_calls",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    apiId: text("api_id")
      .notNull()
      .references(() => apis.id),
    payerAddress: text("payer_address").notNull(),
    amount: text("amount").notNull(),
    charged: boolean("charged").notNull(),
    method: text("method").notNull(),
    path: text("path").notNull(),
    responseStatus: integer("response_status").notNull(),
    durationMs: integer("duration_ms").notNull(),
    txHash: text("tx_hash"),
    // Refund fields (migration 0018_api_gateway_extensions.sql).
    refundStatus: text("refund_status").$type<"pending" | "refunded" | null>(),
    refundAmount: text("refund_amount"),
    refundTxHash: text("refund_tx_hash"),
    refundedAt: timestamp("refunded_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    apiIdCreatedAtIdx: index("idx_api_calls_api_id_created_at").on(
      table.apiId,
      table.createdAt,
    ),
    payerAddressCreatedAtIdx: index("idx_api_calls_payer_address_created_at").on(
      table.payerAddress,
      table.createdAt,
    ),
    refundTxIdx: uniqueIndex("idx_api_calls_refund_tx_hash").on(table.refundTxHash),
  }),
);

// Daily rollup table (#283) — calls, charged calls, revenue, unique payers per API per day
export const apiDailyRollups = pgTable(
  "api_daily_rollups",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    apiId: text("api_id")
      .notNull()
      .references(() => apis.id, { onDelete: "cascade" }),
    date: text("date").notNull(), // YYYY-MM-DD UTC
    calls: integer("calls").notNull().default(0),
    chargedCalls: integer("charged_calls").notNull().default(0),
    revenue: text("revenue").notNull().default("0"),
    uniquePayers: integer("unique_payers").notNull().default(0),
    totalDurationMs: integer("total_duration_ms").notNull().default(0),
    refundedCalls: integer("refunded_calls").notNull().default(0),
    refundedAmount: text("refunded_amount").notNull().default("0"),
    payers: jsonb("payers").$type<string[]>().notNull().default([]),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => ({
    apiDateIdx: uniqueIndex("idx_api_daily_rollups_api_date").on(table.apiId, table.date),
    apiIdIdx: index("idx_api_daily_rollups_api_id").on(table.apiId),
  }),
);

// Minimal financial fields for charged calls preserved for accounting (#283)
export const apiCallFinancialRecords = pgTable(
  "api_call_financial_records",
  {
    id: text("id").primaryKey(),
    apiId: text("api_id")
      .notNull()
      .references(() => apis.id, { onDelete: "cascade" }),
    payerAddress: text("payer_address").notNull(),
    amount: text("amount").notNull(),
    txHash: text("tx_hash"),
    refundStatus: text("refund_status"),
    refundAmount: text("refund_amount"),
    refundTxHash: text("refund_tx_hash"),
    refundedAt: timestamp("refunded_at"),
    createdAt: timestamp("created_at").notNull(),
  },
  (table) => ({
    apiCreatedIdx: index("idx_api_call_financial_records_api_created").on(
      table.apiId,
      table.createdAt,
    ),
    apiPayerIdx: index("idx_api_call_financial_records_api_payer").on(
      table.apiId,
      table.payerAddress,
    ),
  }),
);

// Webhook outbox (#208). A charged-call event is written here in the same
// transaction as its api_calls row, and a worker delivers it with backoff. The
// signing secret stays encrypted (secret_enc), as on apis.
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: serial("id").primaryKey(),
    eventId: text("event_id").notNull(),
    apiId: text("api_id")
      .notNull()
      .references(() => apis.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    secretEnc: text("secret_enc").notNull(),
    body: text("body").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    eventIdIdx: uniqueIndex("webhook_deliveries_event_id_idx").on(table.eventId),
    dueIdx: index("webhook_deliveries_due_idx").on(table.status, table.nextAttemptAt),
  }),
);

// API passes (#30) — time-limited access tokens purchased via x402.
// A caller with an active pass is not charged per call until the pass expires.
export const apiPasses = pgTable(
  "api_passes",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => createId()),
    apiId: text("api_id")
      .notNull()
      .references(() => apis.id),
    payerAddress: text("payer_address").notNull(),
    // USDC amount paid for the pass.
    amount: text("amount").notNull(),
    // Settlement transaction hash from x402 (null until settled).
    txHash: text("tx_hash"),
    activeFrom: timestamp("active_from").defaultNow().notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    // The primary lookup: "does this payer have an active pass for this API?"
    apiPayerExpiresIdx: index("idx_api_passes_api_payer_expires").on(
      table.apiId,
      table.payerAddress,
      table.expiresAt,
    ),
  }),
);

export const proxyIdempotency = pgTable(
  "proxy_idempotency",
  {
    apiId: text("api_id")
      .notNull()
      .references(() => apis.id, { onDelete: "cascade" }),
    payer: text("payer").notNull(),
    key: text("idempotency_key").notNull(),
    fingerprint: text("fingerprint").notNull(),
    state: text("state").$type<"in_progress" | "completed">().notNull(),
    paymentHash: text("payment_hash"),
    response: jsonb("response").$type<{
      status: number;
      headers: Record<string, string | string[]>;
      body: string;
    } | null>(),
    txHash: text("tx_hash"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    keyIdx: uniqueIndex("proxy_idempotency_api_payer_key_idx").on(
      table.apiId,
      table.payer,
      table.key,
    ),
    expiresAtIdx: index("proxy_idempotency_expires_at_idx").on(table.expiresAt),
    validState: check(
      "proxy_idempotency_state_check",
      sql`${table.state} in ('in_progress', 'completed')`,
    ),
  }),
);

export type ApiPassRow = typeof apiPasses.$inferSelect;

/** Row type for the `apis` table, shared across middleware and services. */
export type ApiRow = typeof apis.$inferSelect;
