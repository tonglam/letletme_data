import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'bun:test';

const migration = readFileSync(
  'migrations/0039_tournament_3_official_classic_roster_transition.sql',
  'utf8',
);
const config = readFileSync('src/utils/config.ts', 'utf8');
const envExample = readFileSync('.env.example', 'utf8');

describe('official Classic roster transition', () => {
  test('defaults future eligible Classic tournaments to official sync', () => {
    expect(config).toContain('TOURNAMENT_OFFICIAL_SYNC_DEFAULT_ENABLED: booleanEnv(true)');
    expect(envExample).toContain('TOURNAMENT_OFFICIAL_SYNC_DEFAULT_ENABLED=true');
  });

  test('moves only the identified legacy tournament without rewriting membership', () => {
    expect(migration).toContain('tournament.season_id = 2026');
    expect(migration).toContain('tournament.tournament_id = 3');
    expect(migration).toContain('tournament.league_id = 8863');
    expect(migration).toMatch(/roster_mode = 'official_sync'/);
    expect(migration).toMatch(/roster_sync_status = 'pending'/);
    expect(migration).toMatch(/tournament\.roster_mode = 'snapshot'/);
    expect(migration).toContain('competition.tournament_entries');
    expect(migration).toContain('competition.entry_leagues');
    expect(migration).not.toMatch(
      /(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?competition\.tournament_entries/i,
    );
  });
});
