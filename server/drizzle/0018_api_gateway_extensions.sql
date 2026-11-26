ALTER TABLE "apis" ADD COLUMN IF NOT EXISTS "upstream_query_name" text;
--> statement-breakpoint
ALTER TABLE "apis" ADD COLUMN IF NOT EXISTS "upstream_query_value_enc" text;
--> statement-breakpoint
ALTER TABLE "apis" ADD COLUMN IF NOT EXISTS "openapi_spec" jsonb;
--> statement-breakpoint
ALTER TABLE "apis" ADD COLUMN IF NOT EXISTS "onchain_status" "onchain_status_enum" DEFAULT 'none' NOT NULL;
--> statement-breakpoint
ALTER TABLE "apis" ADD COLUMN IF NOT EXISTS "onchain_tx_hash" text;
--> statement-breakpoint
ALTER TABLE "api_calls" ADD COLUMN IF NOT EXISTS "refund_status" text;
--> statement-breakpoint
ALTER TABLE "api_calls" ADD COLUMN IF NOT EXISTS "refund_amount" text;
--> statement-breakpoint
ALTER TABLE "api_calls" ADD COLUMN IF NOT EXISTS "refund_tx_hash" text;
--> statement-breakpoint
ALTER TABLE "api_calls" ADD COLUMN IF NOT EXISTS "refunded_at" timestamp;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_api_calls_refund_tx_hash" ON "api_calls" ("refund_tx_hash");
