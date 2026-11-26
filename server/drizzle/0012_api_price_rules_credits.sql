ALTER TABLE "apis"
  ADD COLUMN IF NOT EXISTS "price_rules" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "api_credit_balances" (
  "id" text PRIMARY KEY NOT NULL,
  "api_id" text NOT NULL REFERENCES "apis"("id"),
  "wallet_address" text NOT NULL,
  "balance" integer DEFAULT 0 NOT NULL CHECK ("balance" >= 0),
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_api_credit_balances_api_wallet"
  ON "api_credit_balances" ("api_id", "wallet_address");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "api_credit_ledger" (
  "id" text PRIMARY KEY NOT NULL,
  "api_id" text NOT NULL REFERENCES "apis"("id"),
  "wallet_address" text NOT NULL,
  "delta" integer NOT NULL,
  "entry_type" text NOT NULL CHECK ("entry_type" IN ('purchase', 'spend')),
  "reference" text,
  "request_nonce" text,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_api_credit_ledger_purchase_reference"
  ON "api_credit_ledger" ("reference")
  WHERE "entry_type" = 'purchase';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_api_credit_ledger_spend_nonce"
  ON "api_credit_ledger" ("api_id", "wallet_address", "request_nonce")
  WHERE "entry_type" = 'spend';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_api_credit_ledger_api_wallet_created"
  ON "api_credit_ledger" ("api_id", "wallet_address", "created_at");
