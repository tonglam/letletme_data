-- Keep a semantic roster/applicability baseline for obligations that have not
-- published a head yet. This lets a corrected entries.started_event wake a
-- headless scope without treating routine entry refresh timestamps as change.

ALTER TABLE competition.tournament_review_obligations
  ADD COLUMN entry_metadata_payload jsonb;

UPDATE competition.tournament_review_obligations obligation
SET entry_metadata_payload = roster.metadata_payload
FROM (
  SELECT roster.season_id,
         roster.tournament_id,
         roster.event_id,
         jsonb_agg(
           jsonb_build_object(
             'entryId', entry.entry_id,
             'entryName', entry.entry_name,
             'playerName', entry.player_name,
             'startedEvent', entry.started_event
           )
           ORDER BY entry.entry_id
         ) AS metadata_payload
  FROM competition.tournament_review_obligations roster
  JOIN competition.tournament_entries tournament_entry
    ON tournament_entry.season_id = roster.season_id
   AND tournament_entry.tournament_id = roster.tournament_id
  JOIN competition.entries entry
    ON entry.season_id = tournament_entry.season_id
   AND entry.entry_id = tournament_entry.entry_id
  GROUP BY roster.season_id, roster.tournament_id, roster.event_id
) roster
WHERE obligation.season_id = roster.season_id
  AND obligation.tournament_id = roster.tournament_id
  AND obligation.event_id = roster.event_id
  AND obligation.entry_metadata_payload IS NULL;

ALTER TABLE competition.tournament_review_obligations
  ADD CONSTRAINT tournament_review_obligations_entry_metadata_payload_check
  CHECK (
    entry_metadata_payload IS NULL
    OR jsonb_typeof(entry_metadata_payload) = 'array'
  );

COMMENT ON COLUMN competition.tournament_review_obligations.entry_metadata_payload IS
  'Last canonical roster/applicability metadata observed by reconciliation; nullable for legacy rows until first observation.';
