ALTER TABLE "apis" ADD COLUMN "webhook_previous_secret_enc" text;--> statement-breakpoint
ALTER TABLE "apis" ADD COLUMN "webhook_previous_secret_expires_at" timestamp;
