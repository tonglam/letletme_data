import { describe, expect, test } from 'bun:test';

import {
  areSafeIntegrationRedisDbIndexes,
  isSafeIntegrationDatabaseUrl,
} from '../integration/helpers/safe-database-target';

describe('integration database target safety', () => {
  test.each([
    'postgresql://user:secret@localhost:5432/letletme',
    'postgres://user:secret@127.0.0.1:5432/postgres',
    'postgresql://user:secret@[::1]:5432/postgres',
    'postgresql://user:secret@test-db.example.com:5432/letletme_data_test',
    'postgresql://user:secret@test-db.example.com:5432/letletme%5Ftest',
  ])('accepts an explicit local or decoded test database target', (databaseUrl) => {
    expect(isSafeIntegrationDatabaseUrl(databaseUrl)).toBe(true);
  });

  test.each([
    'postgresql://user_test:secret@production.example.com:5432/postgres',
    'postgresql://user:secret_test@production.example.com:5432/postgres',
    'postgresql://user:secret@production_test.example.com:5432/postgres',
    'postgresql://user:secret@localhost.evil.example.com:5432/postgres',
    'postgresql://user:secret@production.example.com:5432/postgres?label=_test',
    'postgresql://user:secret@production.example.com:5432/postgres%2Ffake_test',
    'https://localhost/letletme_data_test',
    'not-a-database-url',
  ])('rejects a connection whose non-database text only looks safe', (databaseUrl) => {
    expect(isSafeIntegrationDatabaseUrl(databaseUrl)).toBe(false);
  });

  test('requires distinct non-zero Redis databases even when hosts differ', () => {
    expect(areSafeIntegrationRedisDbIndexes(9, 10)).toBe(true);
    expect(areSafeIntegrationRedisDbIndexes(9, 9)).toBe(false);
    expect(areSafeIntegrationRedisDbIndexes(0, 10)).toBe(false);
    expect(areSafeIntegrationRedisDbIndexes(9, 0)).toBe(false);
  });
});
