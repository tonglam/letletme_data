-- Unique conflict target for entry_event_transfers upserts (fixes 42P10 on fresh installs).
-- Production already has this index under the same name (created out-of-band);
-- IF NOT EXISTS makes this a no-op there.

CREATE UNIQUE INDEX IF NOT EXISTS "unique_entry_event_transfer"
  ON public.entry_event_transfers ("entry_id", "event_id");
