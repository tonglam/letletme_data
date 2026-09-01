-- Live Matches V3 breaking contract fence.
--
-- The existing compact checkpoint tables remain the PostgreSQL cold-fallback
-- tables.  Rows written by the sealed V2 runtime are retained for rollback
-- diagnostics, but the V3 readers accept only a manifest and column fence
-- whose contract_version is live-matches-v3.  The cutover seed replaces the
-- active event rows with V3 publications from complete canonical data.

ALTER TABLE fpl.live_match_desk_checkpoints
  ADD COLUMN contract_version text;

UPDATE fpl.live_match_desk_checkpoints
SET contract_version = manifest ->> 'contractVersion'
WHERE contract_version IS NULL;

ALTER TABLE fpl.live_match_desk_checkpoints
  ALTER COLUMN contract_version SET NOT NULL;

ALTER TABLE fpl.live_match_desk_checkpoints
  ADD CONSTRAINT live_match_desk_checkpoints_contract_fence
  CHECK (
    contract_version = manifest ->> 'contractVersion'
    AND contract_version = ANY (ARRAY['live-matches-v2', 'live-matches-v3']::text[])
  );

ALTER TABLE fpl.live_match_detail_checkpoints
  ADD COLUMN contract_version text;

UPDATE fpl.live_match_detail_checkpoints
SET contract_version = manifest ->> 'contractVersion'
WHERE contract_version IS NULL;

ALTER TABLE fpl.live_match_detail_checkpoints
  ALTER COLUMN contract_version SET NOT NULL;

ALTER TABLE fpl.live_match_detail_checkpoints
  ADD CONSTRAINT live_match_detail_checkpoints_contract_fence
  CHECK (
    contract_version = manifest ->> 'contractVersion'
    AND contract_version = ANY (ARRAY['live-matches-v2', 'live-matches-v3']::text[])
  );

