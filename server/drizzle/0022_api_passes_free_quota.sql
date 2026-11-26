-- Issue #30: time-based access passes
-- pass_price: if set, callers can buy a time-limited pass for this API
ALTER TABLE "apis" ADD COLUMN IF NOT EXISTS "pass_price" text;
--> statement-breakpoint

-- Issue #32: free calls quota per payer
-- free_calls_per_day: number of free calls a new wallet gets per day (0 = disabled)
ALTER TABLE "apis" ADD COLUMN IF NOT EXISTS "free_calls_per_day" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint

-- Issue #30: tracks active access passes purchased via x402
CREATE TABLE IF NOT EXISTS "api_passes" (
  "id"           text PRIMARY KEY,
  "api_id"       text NOT NULL REFERENCES "apis"("id"),
  "payer_address" text NOT NULL,
  -- amount paid for the pass (USDC)
  "amount"       text NOT NULL,
  -- settlement transaction hash from x402
  "tx_hash"      text,
  -- when the pass becomes active and when it expires
  "active_from"  timestamp NOT NULL DEFAULT now(),
  "expires_at"   timestamp NOT NULL,
  "created_at"   timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_api_passes_api_payer_expires"
  ON "api_passes" USING btree ("api_id", "payer_address", "expires_at");
