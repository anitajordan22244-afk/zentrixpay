-- Drop the legacy file-vault tables and their enums. Back up the database first:
-- this permanently deletes all resources, verifications and payments rows.
DROP TABLE IF EXISTS "payments";--> statement-breakpoint
DROP TABLE IF EXISTS "verifications";--> statement-breakpoint
DROP TABLE IF EXISTS "resources";--> statement-breakpoint
DROP TYPE IF EXISTS "verification_status";--> statement-breakpoint
DROP TYPE IF EXISTS "resource_type";
