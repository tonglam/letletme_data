ALTER TABLE public.entry_infos
  ADD COLUMN entry_snapshot_synced_through_event_id integer,
  ADD COLUMN entry_snapshot_synced_season text,
  ADD COLUMN entry_transfers_synced_through_event_id integer,
  ADD COLUMN entry_transfers_synced_season text;

ALTER TABLE public.entry_infos
  ADD CONSTRAINT entry_snapshot_sync_event_range
    CHECK (
      entry_snapshot_synced_through_event_id IS NULL
      OR entry_snapshot_synced_through_event_id BETWEEN 0 AND 38
    ),
  ADD CONSTRAINT entry_transfers_sync_event_range
    CHECK (
      entry_transfers_synced_through_event_id IS NULL
      OR entry_transfers_synced_through_event_id BETWEEN 0 AND 38
    ),
  ADD CONSTRAINT entry_snapshot_sync_season_pair
    CHECK (
      (entry_snapshot_synced_through_event_id IS NULL)
      = (entry_snapshot_synced_season IS NULL)
    ),
  ADD CONSTRAINT entry_snapshot_sync_season_format
    CHECK (
      entry_snapshot_synced_season IS NULL
      OR entry_snapshot_synced_season ~ '^[0-9]{4}$'
    ),
  ADD CONSTRAINT entry_transfers_sync_season_pair
    CHECK (
      (entry_transfers_synced_through_event_id IS NULL)
      = (entry_transfers_synced_season IS NULL)
    ),
  ADD CONSTRAINT entry_transfers_sync_season_format
    CHECK (
      entry_transfers_synced_season IS NULL
      OR entry_transfers_synced_season ~ '^[0-9]{4}$'
    );

-- Existing rows deliberately remain NULL. Historical last_event_id and transfer
-- rows cannot prove that the complete upstream snapshot was fetched, especially
-- for entrants who made no transfers. The next relevant setup performs one
-- authoritative current-season sync and establishes the checkpoint pair
-- transactionally. Event numbers and entry IDs are reused by FPL each season,
-- so a numeric checkpoint is complete only for its recorded season.

-- entry_infos is already RLS-enabled and revoked from PUBLIC, anon, and
-- authenticated by migrations 0029 and 0033. Adding columns does not create a
-- new Data API object or change the table's existing grants/policies.
