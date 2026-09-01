import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

const migration = readFileSync('migrations/0077_tournament_review_v2_publications.sql', 'utf8');
const metadataMigration = readFileSync(
  'migrations/0079_tournament_review_obligation_metadata_baseline.sql',
  'utf8',
);
const entryMetadataMigration = readFileSync(
  'migrations/0080_tournament_review_obligation_entry_metadata.sql',
  'utf8',
);
const groupAssignmentMigration = readFileSync(
  'migrations/0081_tournament_review_obligation_group_assignment.sql',
  'utf8',
);
const sourceFloorMigration = readFileSync(
  'migrations/0082_tournament_review_source_floor_requeue.sql',
  'utf8',
);
const hardCutMigration = readFileSync(
  'migrations/0084_my_tournament_review_v2_1_hard_cut.sql',
  'utf8',
);

describe('My Tournament Review V2 migration', () => {
  test('defines immutable publication, atomic head and durable obligation layers', () => {
    expect(migration).toContain('CREATE TABLE competition.tournament_review_publications');
    expect(migration).toContain('CREATE TABLE competition.tournament_review_heads');
    expect(migration).toContain('CREATE TABLE competition.tournament_review_obligations');
    expect(migration).toMatch(/format IN \('POINTS', 'H2H', 'KNOCKOUT'\)/);
    expect(migration).toMatch(
      /state IN \('PENDING', 'WAITING_SOURCE', 'PROCESSING', 'READY', 'DEGRADED'\)/,
    );
    expect(migration).toContain('tournament_review_publications_source_span_check');
    expect(migration).toContain('source_min_checked_at <= event_data_checked_at');
    expect(migration).toContain('event_data_checked_at <= source_max_checked_at');
    expect(migration).toContain('tournament_review_obligations_due_idx');
    expect(migration).toContain('tournament_review_obligations_reclaim_idx');
    expect(migration).toContain('tournament_review_entry_results_reconcile_idx');
    expect(migration).toContain('tournament_review_entries_reconcile_idx');
  });

  test('keeps the GraphQL role read-only and gives Data the only mutation grant', () => {
    expect(migration).toContain('GRANT SELECT ON TABLE');
    expect(migration).toContain('TO letletme_graphql_reader');
    expect(migration).toContain(
      'GRANT SELECT, INSERT ON TABLE competition.tournament_review_publications',
    );
    expect(migration).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE');
    expect(migration).toContain('tournament_review_heads_writer_delete');
    expect(migration).toContain('tournament_review_obligations_writer_delete');
    expect(migration).not.toMatch(
      /GRANT SELECT, INSERT(?:, UPDATE)?, DELETE ON TABLE competition\.tournament_review_publications/,
    );
    expect(migration).toContain('TO letletme_data_writer');
    expect(migration).toContain('tournament_review_publications_writer_insert');
    expect(migration).toContain(
      'ALTER TABLE competition.tournament_review_publications ENABLE ROW LEVEL SECURITY',
    );
  });

  test('persists a payload-level baseline for headless obligations', () => {
    expect(metadataMigration).toContain('ALTER TABLE competition.tournament_review_obligations');
    expect(metadataMigration).toContain('ADD COLUMN metadata_payload jsonb');
    expect(metadataMigration).toContain('SET metadata_payload = publication.payload #>');
    expect(metadataMigration).toContain('tournament_review_obligations_metadata_payload_check');
  });

  test('persists an entry applicability baseline for headless obligations', () => {
    expect(entryMetadataMigration).toContain('ADD COLUMN entry_metadata_payload jsonb');
    expect(entryMetadataMigration).toMatch(/'startedEvent', entry\.started_event/);
    expect(entryMetadataMigration).toMatch(/SET state = 'PENDING'/);
    expect(entryMetadataMigration).toContain('next_attempt_at = clock_timestamp()');
    expect(entryMetadataMigration).toMatch(/obligation\.state = 'DEGRADED'/);
    expect(entryMetadataMigration).toContain('obligation.next_attempt_at IS NULL');
    expect(entryMetadataMigration).toContain('tournament_review_heads head');
    expect(entryMetadataMigration).toContain(
      'tournament_review_obligations_entry_metadata_payload_check',
    );
  });

  test('persists a canonical group-assignment baseline for reconciliation', () => {
    expect(groupAssignmentMigration).toContain('ADD COLUMN group_assignment_payload jsonb');
    expect(groupAssignmentMigration).toContain(
      'tournament_review_obligations_group_assignment_payload_check',
    );
    expect(groupAssignmentMigration).toContain(
      'SET group_assignment_payload = observed.group_assignment_payload',
    );
    expect(groupAssignmentMigration).toContain('publication.payload #> \x27{points,rows}\x27');
    expect(groupAssignmentMigration).toContain('publication.payload #> \x27{h2h,standings}\x27');
    expect(groupAssignmentMigration).toContain(
      'jsonb_typeof(group_assignment_payload) = \x27object\x27',
    );
  });

  test('requeues active heads that predate the finalized event source floor', () => {
    expect(sourceFloorMigration).toContain('WITH stale_scopes AS MATERIALIZED');
    expect(sourceFloorMigration).toContain(
      'publication.source_min_checked_at < publication.event_data_checked_at',
    );
    expect(sourceFloorMigration).toContain('DELETE FROM competition.tournament_review_heads head');
    expect(sourceFloorMigration).toMatch(/SET state = 'PENDING'/);
    expect(sourceFloorMigration).toContain('next_attempt_at = clock_timestamp()');
    expect(sourceFloorMigration).toContain('ready_revision = NULL');
    expect(sourceFloorMigration).not.toContain(
      'DELETE FROM competition.tournament_review_publications',
    );
  });

  test('backs up and resets the current season before introducing V2.1 chunks', () => {
    expect(hardCutMigration).toContain('tournament_review_publications_0084_backup');
    expect(hardCutMigration).toContain('tournament_review_v2_1_backup_manifest');
    expect(hardCutMigration).toContain('publication_revision_distribution jsonb');
    expect(hardCutMigration).toContain('DELETE FROM competition.tournament_review_heads');
    expect(hardCutMigration).toContain('DELETE FROM competition.tournament_review_publications');
    expect(hardCutMigration).toContain('DELETE FROM competition.tournament_review_obligations');
    expect(hardCutMigration).toContain('current_season');
  });

  test('defines correction provenance, observation timestamps, and bounded chunk integrity', () => {
    expect(hardCutMigration).toContain('correction_reason text');
    expect(hardCutMigration).toContain('correction_change_id text');
    expect(hardCutMigration).toContain('schema_version <>');
    expect(hardCutMigration).toContain('my-tournament-review-v2.1');
    expect(hardCutMigration).toContain('last_observed_at timestamptz');
    expect(hardCutMigration).toContain('last_noop_at timestamptz');
    expect(hardCutMigration).toContain('last_semantic_change_at timestamptz');
    expect(hardCutMigration).toContain('repair_issue_id bigint');
    expect(hardCutMigration).toContain('ADD COLUMN IF NOT EXISTS correction_reason text');
    expect(hardCutMigration).toContain('ADD COLUMN IF NOT EXISTS correction_change_id text');
    expect(hardCutMigration).toContain(
      'CREATE TABLE IF NOT EXISTS competition.tournament_review_publication_chunks',
    );
    expect(hardCutMigration).toContain('item_count BETWEEN 0 AND 100');
    expect(hardCutMigration).toContain('jsonb_array_length(items) = item_count');
    expect(hardCutMigration).toContain('chunk_sha256 ~');
    expect(hardCutMigration).toContain(
      'GRANT UPDATE ON TABLE competition.tournament_review_publication_chunks',
    );
    expect(hardCutMigration).toContain('tournament_review_chunks_writer_update');
    expect(hardCutMigration).toContain('TO letletme_graphql_reader');
  });
});
