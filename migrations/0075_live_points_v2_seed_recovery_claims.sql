-- A one-shot cutover seed must commit its durable absence claim before it
-- changes the Redis active pointer. Every normal checkpoint writer consults
-- this scope row under the same advisory lock; after a process crash, only the
-- seed holding claim_id can complete the checkpoint and remove the claim.
CREATE TABLE competition.live_points_publication_seed_claims (
  season_id smallint NOT NULL,
  event_id integer NOT NULL,
  claim_id uuid NOT NULL,
  expected_active_sha256 text NOT NULL,
  candidate_state text NOT NULL,
  candidate_source_checked_at timestamptz NOT NULL,
  candidate_event_live_sha256 text NOT NULL,
  candidate_fixtures_sha256 text NOT NULL,
  -- This is an ownership lease, so transaction-start time is unsafe: a
  -- claim that waited on the scope lock could be born already expired.
  claimed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT live_points_publication_seed_claims_pkey
    PRIMARY KEY (season_id, event_id),
  CONSTRAINT live_points_publication_seed_claims_event_fk
    FOREIGN KEY (season_id, event_id)
    REFERENCES fpl.events (season_id, event_id),
  CONSTRAINT live_points_publication_seed_claims_claim_once
    UNIQUE (claim_id),
  CONSTRAINT live_points_publication_seed_claims_identity_valid CHECK (
    event_id > 0
    AND expected_active_sha256 ~ '^[0-9a-f]{64}$'
    AND candidate_event_live_sha256 ~ '^[0-9a-f]{64}$'
    AND candidate_fixtures_sha256 ~ '^[0-9a-f]{64}$'
    AND candidate_state = ANY (ARRAY[
      'PRE_DEADLINE', 'PICKS_WAIT', 'PICKS_PROBE', 'PICKS_SYNC',
      'LIVE_ACTIVE', 'BETWEEN_FIXTURES', 'DAY_SETTLING', 'GW_REVIEW',
      'FINALIZED'
    ]::text[])
  )
);

REVOKE ALL ON TABLE competition.live_points_publication_seed_claims FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE competition.live_points_publication_seed_claims TO letletme_data_writer;
REVOKE ALL ON TABLE competition.live_points_publication_seed_claims
  FROM letletme_graphql_reader;

ALTER TABLE competition.live_points_publication_seed_claims
  ENABLE ROW LEVEL SECURITY;
CREATE POLICY letletme_data_writer_all
  ON competition.live_points_publication_seed_claims
  FOR ALL TO letletme_data_writer
  USING (true) WITH CHECK (true);
