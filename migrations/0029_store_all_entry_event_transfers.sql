-- FPL can return multiple transfers for one entry in one gameweek.  Replace
-- the historical pair-only conflict target with a transfer-level identity.
DROP INDEX IF EXISTS "unique_entry_event_transfer";
CREATE UNIQUE INDEX IF NOT EXISTS "unique_entry_event_transfer"
  ON public.entry_event_transfers
    ("entry_id", "event_id", "transfer_time", "element_in_id", "element_out_id");
