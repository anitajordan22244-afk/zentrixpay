-- Catalog substring search (GET /apis?q=…) filters with name/description
-- ILIKE '%term%', which a btree index cannot serve, so every search was a
-- full scan of apis. Trigram GIN indexes serve ILIKE with leading wildcards
-- (#148; plans and numbers in docs/performance.md).
--
-- On a large existing table, build them first with CREATE INDEX CONCURRENTLY
-- (outside a transaction) to avoid blocking writes; these statements are then
-- no-ops.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_apis_name_trgm" ON "apis" USING gin ("name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_apis_description_trgm" ON "apis" USING gin ("description" gin_trgm_ops);
