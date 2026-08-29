import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const materializations = readFileSync('src/repositories/manager-score-materializations.ts', 'utf8');
const tournamentManagement = readFileSync('src/repositories/tournament-management.ts', 'utf8');

describe('nested transaction repository contract', () => {
  test('uses the nested-safe helper for manager score materialization writes', () => {
    expect(materializations).toContain('getDbClient,');
    expect(materializations).toContain('registerDatabasePostCommit,');
    expect(materializations).toContain('withDatabaseTransaction,');
    expect(materializations).toContain(
      'const result = await withDatabaseTransaction(async (tx) => {',
    );
    expect(materializations).not.toContain('const db = await getDbClient();\n  const rowsForRedis');
    expect(materializations).not.toContain('await db.begin(async (tx) =>');
    expect(materializations).toContain('registerDatabasePostCommit(publishRedisHeads);');
    expect(materializations).toContain('if (databaseTransactionStorage.getStore())');
  });

  test('keeps tournament deletion safe when called inside mutation scopes', () => {
    expect(tournamentManagement).toMatch(
      /import \{ getDbClient, withDatabaseTransaction \} from '..\/db\/singleton';/,
    );
    expect(tournamentManagement).toContain(
      'const result = await withDatabaseTransaction(async (tx) => {',
    );
    expect(tournamentManagement).not.toContain(
      'const client = await getDbClient();\n      const result',
    );
    expect(tournamentManagement).not.toContain('await client.begin(async (tx) =>');
  });
});
