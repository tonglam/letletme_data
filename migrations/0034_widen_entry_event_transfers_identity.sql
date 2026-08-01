-- FPL permits multiple transfers by one entry in the same gameweek. The old
-- (entry_id, event_id) identity silently retained only one row. Use the stable
-- transfer signature so the complete ordered history can be persisted.

DROP INDEX IF EXISTS public.unique_entry_event_transfer;

CREATE UNIQUE INDEX unique_entry_event_transfer
  ON public.entry_event_transfers (
    entry_id,
    event_id,
    element_in_id,
    element_out_id,
    transfer_time
  );
