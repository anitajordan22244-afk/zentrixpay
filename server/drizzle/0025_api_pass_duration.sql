-- Issue #278: providers choose how long an access pass lasts.
-- Bounded to 1 hour .. 30 days; existing APIs keep the old fixed 1 hour.
ALTER TABLE "apis" ADD COLUMN IF NOT EXISTS "pass_duration_ms" integer DEFAULT 3600000 NOT NULL;
--> statement-breakpoint
ALTER TABLE "apis" DROP CONSTRAINT IF EXISTS "apis_pass_duration_ms_range";
--> statement-breakpoint
ALTER TABLE "apis" ADD CONSTRAINT "apis_pass_duration_ms_range"
  CHECK ("pass_duration_ms" BETWEEN 3600000 AND 2592000000);
