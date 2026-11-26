ALTER TABLE "apis" ADD COLUMN IF NOT EXISTS "max_response_bytes" integer;
--> statement-breakpoint
ALTER TABLE "apis" ADD COLUMN IF NOT EXISTS "webhook_url" text;
--> statement-breakpoint
ALTER TABLE "apis" ADD COLUMN IF NOT EXISTS "webhook_secret_enc" text;
--> statement-breakpoint
ALTER TABLE "apis" ADD COLUMN IF NOT EXISTS "health_path" text;
--> statement-breakpoint
ALTER TABLE "apis" ADD COLUMN IF NOT EXISTS "healthy" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "apis" ADD COLUMN IF NOT EXISTS "health_failures" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "apis" ADD COLUMN IF NOT EXISTS "last_health_check_at" timestamp;
