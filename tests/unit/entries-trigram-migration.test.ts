import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const migration = readFileSync('migrations/0014_entries_name_trigram_search.sql', 'utf8');
const schema = readFileSync('src/db/schemas/platform/competition.schema.ts', 'utf8');
const sqlQuote = String.fromCharCode(39);

describe('entry name trigram search contract', () => {
  test('installs pg_trgm in extensions and creates both GIN indexes', () => {
    expect(migration).toContain(
      'EXECUTE ' + sqlQuote + 'CREATE EXTENSION pg_trgm WITH SCHEMA extensions' + sqlQuote,
    );
    expect(migration).toContain(
      'EXECUTE ' + sqlQuote + 'ALTER EXTENSION pg_trgm SET SCHEMA extensions' + sqlQuote,
    );
    expect(migration).toContain(
      'entries_entry_name_trgm_idx\n  ON competition.entries USING gin (entry_name extensions.gin_trgm_ops)',
    );
    expect(migration).toContain(
      'entries_player_name_trgm_idx\n  ON competition.entries USING gin (player_name extensions.gin_trgm_ops)',
    );
  });

  test('keeps the typed schema in parity with the additive migration', () => {
    expect(schema).toMatch(/index\('entries_entry_name_trgm_idx'\)/);
    expect(schema).toMatch(/index\('entries_player_name_trgm_idx'\)/);
    expect(schema).toContain('extensions.gin_trgm_ops');
  });
});
