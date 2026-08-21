import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const migration = readFileSync('migrations/0013_player_state_season_rows.sql', 'utf8');
const timelineMigration = readFileSync(
  'migrations/0016_player_state_fpl_summary_columns.sql',
  'utf8',
);

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

  test('adds raw FPL totals and refreshes them atomically from canonical summaries', () => {
    expect(timelineMigration).toContain('fpl_total_points integer NOT NULL DEFAULT 0');
    expect(timelineMigration).toContain('fpl_starts integer NOT NULL DEFAULT 0');
    expect(timelineMigration).toContain('fpl_clean_sheets integer NOT NULL DEFAULT 0');
    expect(timelineMigration).toContain('fpl_saves integer NOT NULL DEFAULT 0');
    expect(timelineMigration).not.toContain('fpl_total_points >= 0');
    expect(timelineMigration).toContain('fpl_starts >= 0');
    expect(timelineMigration).toContain('fpl_clean_sheets >= 0');
    expect(timelineMigration).toContain('fpl_saves >= 0');
    expect(timelineMigration).toContain('refresh_player_state_season_base');
    expect(timelineMigration).toContain('summary.total_points');
    expect(timelineMigration).toContain('summary.gameweeks_started');
    expect(timelineMigration).toContain('summary.clean_sheets');
    expect(timelineMigration).toContain('summary.saves');
    expect(timelineMigration).toContain('GET DIAGNOSTICS updated_players = ROW_COUNT');
    expect(timelineMigration).toContain(
      'reporting.refresh_player_state_season(season_row.season_id)',
    );
  });
});
