ALTER TABLE "apis" ADD COLUMN "scheduled_price" text;
--> statement-breakpoint
ALTER TABLE "apis" ADD COLUMN "effective_at" timestamp with time zone;
