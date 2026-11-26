CREATE TABLE IF NOT EXISTS "webhook_deliveries" (
	"id" serial PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"api_id" text NOT NULL,
	"url" text NOT NULL,
	"secret_enc" text NOT NULL,
	"body" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_api_id_apis_id_fk" FOREIGN KEY ("api_id") REFERENCES "public"."apis"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "webhook_deliveries_event_id_idx" ON "webhook_deliveries" USING btree ("event_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_deliveries_due_idx" ON "webhook_deliveries" USING btree ("status","next_attempt_at");
