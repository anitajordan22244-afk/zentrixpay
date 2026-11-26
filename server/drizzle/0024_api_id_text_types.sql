-- CUID text is the canonical API ID type. Convert child columns from the
-- earlier integer declarations before recreating their foreign keys.
ALTER TABLE "proxy_idempotency"
  DROP CONSTRAINT IF EXISTS "proxy_idempotency_api_id_apis_id_fk";
--> statement-breakpoint
ALTER TABLE "proxy_idempotency"
  ALTER COLUMN "api_id" TYPE text USING "api_id"::text;
--> statement-breakpoint
ALTER TABLE "proxy_idempotency"
  ADD CONSTRAINT "proxy_idempotency_api_id_apis_id_fk"
  FOREIGN KEY ("api_id") REFERENCES "public"."apis"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "webhook_deliveries"
  DROP CONSTRAINT IF EXISTS "webhook_deliveries_api_id_apis_id_fk";
--> statement-breakpoint
ALTER TABLE "webhook_deliveries"
  ALTER COLUMN "api_id" TYPE text USING "api_id"::text;
--> statement-breakpoint
ALTER TABLE "webhook_deliveries"
  ADD CONSTRAINT "webhook_deliveries_api_id_apis_id_fk"
  FOREIGN KEY ("api_id") REFERENCES "public"."apis"("id") ON DELETE cascade;
