import { expect, mock, test } from 'bun:test';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import { createEventLiveRepository } from '../../src/repositories/event-lives';
import { createTournamentKnockoutsRepository } from '../../src/repositories/tournament-knockouts';
import { TEST_SEASON } from '../fixtures/seasons.fixtures';

const dialect = new PgDialect();

function renderSql(value: unknown): string {
  return dialect.sqlToQuery(value as SQL).sql;
}

function fakeDatabase() {
  const returning = mock(async () => []);
  const onConflictDoUpdate = mock((_config: unknown) => ({ returning }));
  const values = mock((_rows: unknown) => ({ onConflictDoUpdate }));
  const insert = mock((_table: unknown) => ({ values }));
  return { db: { insert }, onConflictDoUpdate };
}

test('derived batch upserts skip unchanged conflict rows', async () => {
  const repositories = [
    {
      name: 'event live',
      fake: fakeDatabase(),
      run: async (db: object) =>
        createEventLiveRepository(db as never).upsertBatch(TEST_SEASON, [{} as never]),
    },
    {
      name: 'knockout bracket',
      fake: fakeDatabase(),
      run: async (db: object) =>
        createTournamentKnockoutsRepository(db as never).upsertBatch(TEST_SEASON, [{} as never]),
    },
  ];

  for (const repository of repositories) {
    await repository.run(repository.fake.db);
    const config = repository.fake.onConflictDoUpdate.mock.calls[0]?.[0] as {
      where?: SQL;
    };
    expect(config.where, `${repository.name} must have a conflict guard`).toBeDefined();
    const guardSql = renderSql(config.where);
    expect(
      guardSql.includes('IS DISTINCT FROM') || guardSql.includes('IS NOT DISTINCT FROM'),
      `${repository.name} guard must be null-safe`,
    ).toBe(true);
  }
});
