import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const migration = readFileSync('migrations/0013_player_state_season_rows.sql', 'utf8');

describe('Player State season read model', () => {
  test('publishes the player-keyed cross-provider projection and indexes it by season', () => {
    expect(migration).toContain('CREATE TABLE reporting.player_state_season_rows');
    expect(migration).toContain('CONSTRAINT player_state_season_rows_pkey');
    expect(migration).toContain('CREATE INDEX player_state_season_rows_player_idx');
    expect(migration).toContain('understat_mapping_status');
    expect(migration).toContain('understat_process_percentile');
    // eslint-disable-next-line quotes
    expect(migration).toContain("subject.link_evidence -> 'confirmedSeasons'");
    // eslint-disable-next-line quotes
    expect(migration).toContain("subject.understat_mapping_status = 'VERIFIED'");
  });

  test('publishes season and global revisions with a locked transactional refresh', () => {
    expect(migration).toContain('CREATE TABLE reporting.player_state_season_refreshes');
    expect(migration).toContain('CREATE TABLE reporting.player_state_dataset_metadata');
    expect(migration).toContain('reporting.refresh_player_state_season');
    expect(migration).toContain('pg_advisory_xact_lock');
    expect(migration).toContain('Cannot publish Player State season');
    expect(migration).toContain('revision = reporting.player_state_season_refreshes.revision + 1');
    expect(migration).toMatch(/dataset_key = 'player_state'/);
  });

  test('grants only explicit writer refresh and GraphQL read access', () => {
    expect(migration).toContain('TO letletme_data_writer');
    expect(migration).toContain('TO letletme_graphql_reader');
    expect(migration).toContain('REVOKE EXECUTE ON FUNCTION reporting.refresh_player_state_season');
  });
});
