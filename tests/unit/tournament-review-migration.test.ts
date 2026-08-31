import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'bun:test';

const migration = readFileSync('migrations/0076_tournament_review_v2_publications.sql', 'utf8');

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
});
