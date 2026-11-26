CREATE TABLE IF NOT EXISTS "api_daily_rollups" (
	"id" text PRIMARY KEY NOT NULL,
	"api_id" text NOT NULL,
	"date" text NOT NULL,
	"calls" integer DEFAULT 0 NOT NULL,
	"charged_calls" integer DEFAULT 0 NOT NULL,
	"revenue" text DEFAULT '0' NOT NULL,
	"unique_payers" integer DEFAULT 0 NOT NULL,
	"total_duration_ms" integer DEFAULT 0 NOT NULL,
	"refunded_calls" integer DEFAULT 0 NOT NULL,
	"refunded_amount" text DEFAULT '0' NOT NULL,
	"payers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "api_daily_rollups_api_id_apis_id_fk" FOREIGN KEY ("api_id") REFERENCES "public"."apis"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_api_daily_rollups_api_date" ON "api_daily_rollups" ("api_id","date");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_api_daily_rollups_api_id" ON "api_daily_rollups" ("api_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "api_call_financial_records" (
	"id" text PRIMARY KEY NOT NULL,
	"api_id" text NOT NULL,
	"payer_address" text NOT NULL,
	"amount" text NOT NULL,
	"tx_hash" text,
	"refund_status" text,
	"refund_amount" text,
	"refund_tx_hash" text,
	"refunded_at" timestamp,
	"created_at" timestamp NOT NULL,
	CONSTRAINT "api_call_financial_records_api_id_apis_id_fk" FOREIGN KEY ("api_id") REFERENCES "public"."apis"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_api_call_financial_records_api_created" ON "api_call_financial_records" ("api_id","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_api_call_financial_records_api_payer" ON "api_call_financial_records" ("api_id","payer_address");
