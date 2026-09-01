-- Live Matches V3 breaking contract fence.
--
-- This migration is intentionally destructive.  The pre-cutover database
-- snapshot is the only rollback source; the runtime tables must not retain a
-- previous contract version after the maintenance-window seed.
--
-- The cutover seed replaces the active event rows with V3 publications from
-- complete canonical data.  Writers are stopped before this migration runs,
-- so the column transition and purge are one maintenance-window operation.

ALTER TABLE fpl.live_match_desk_checkpoints
  ADD COLUMN contract_version text;

UPDATE fpl.live_match_desk_checkpoints
SET contract_version = manifest ->> 'contractVersion'
WHERE contract_version IS NULL;

DELETE FROM fpl.live_match_desk_checkpoints
WHERE contract_version IS DISTINCT FROM 'live-matches-v3';

ALTER TABLE fpl.live_match_desk_checkpoints
  ALTER COLUMN contract_version SET NOT NULL;

ALTER TABLE fpl.live_match_desk_checkpoints
  ALTER COLUMN contract_version SET DEFAULT 'live-matches-v3';

ALTER TABLE fpl.live_match_desk_checkpoints
  ADD CONSTRAINT live_match_desk_checkpoints_contract_fence
  CHECK (
    contract_version = manifest ->> 'contractVersion'
    AND contract_version = 'live-matches-v3'
  );

ALTER TABLE fpl.live_match_detail_checkpoints
  ADD COLUMN contract_version text;

UPDATE fpl.live_match_detail_checkpoints
SET contract_version = manifest ->> 'contractVersion'
WHERE contract_version IS NULL;

DELETE FROM fpl.live_match_detail_checkpoints
WHERE contract_version IS DISTINCT FROM 'live-matches-v3';

ALTER TABLE fpl.live_match_detail_checkpoints
  ALTER COLUMN contract_version SET NOT NULL;

ALTER TABLE fpl.live_match_detail_checkpoints
  ALTER COLUMN contract_version SET DEFAULT 'live-matches-v3';

ALTER TABLE fpl.live_match_detail_checkpoints
  ADD CONSTRAINT live_match_detail_checkpoints_contract_fence
  CHECK (
    contract_version = manifest ->> 'contractVersion'
    AND contract_version = 'live-matches-v3'
  );
