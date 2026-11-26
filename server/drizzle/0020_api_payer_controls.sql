ALTER TABLE "apis" ADD COLUMN IF NOT EXISTS "payer_allowlist" jsonb;--> statement-breakpoint
ALTER TABLE "apis" ADD COLUMN IF NOT EXISTS "payer_denylist" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "api_calls" ADD COLUMN IF NOT EXISTS "tx_hash" text;--> statement-breakpoint
DROP INDEX IF EXISTS "idx_api_calls_payer_address";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_api_calls_payer_address_created_at" ON "api_calls" USING btree ("payer_address","created_at");
