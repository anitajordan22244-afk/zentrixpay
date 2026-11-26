-- Add opt-in streaming flag to the apis table.
-- APIs that set this to TRUE have their upstream response piped directly to
-- the caller (SSE / chunked transfer) instead of being buffered first.
ALTER TABLE apis
  ADD COLUMN IF NOT EXISTS streaming_enabled boolean NOT NULL DEFAULT false;
