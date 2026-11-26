CREATE TABLE "proxy_idempotency" (
	"api_id" text NOT NULL,
	"payer" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"state" text NOT NULL,
	"payment_hash" text,
	"response" jsonb,
	"tx_hash" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proxy_idempotency_state_check" CHECK ("proxy_idempotency"."state" in ('in_progress', 'completed'))
);
--> statement-breakpoint
ALTER TABLE "proxy_idempotency" ADD CONSTRAINT "proxy_idempotency_api_id_apis_id_fk" FOREIGN KEY ("api_id") REFERENCES "public"."apis"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "proxy_idempotency_api_payer_key_idx" ON "proxy_idempotency" USING btree ("api_id","payer","idempotency_key");
--> statement-breakpoint
CREATE INDEX "proxy_idempotency_expires_at_idx" ON "proxy_idempotency" USING btree ("expires_at");
