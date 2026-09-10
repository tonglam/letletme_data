import { expect, mock, test } from 'bun:test';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import { createEventLiveRepository } from '../../src/repositories/event-lives';
import { createTournamentBattleGroupResultsRepository } from '../../src/repositories/tournament-battle-group-results';
import { createTournamentGroupRepository } from '../../src/repositories/tournament-groups';
import { createTournamentKnockoutResultsRepository } from '../../src/repositories/tournament-knockout-results';
import { createTournamentKnockoutsRepository } from '../../src/repositories/tournament-knockouts';
import { createTournamentPointsGroupResultsRepository } from '../../src/repositories/tournament-points-group-results';
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
      name: 'battle result',
      fake: fakeDatabase(),
      run: async (db: object) =>
        createTournamentBattleGroupResultsRepository(db as never).upsertBatch(TEST_SEASON, [
          {} as never,
        ]),
    },
    {
      name: 'tournament group',
      fake: fakeDatabase(),
      run: async (db: object) =>
        createTournamentGroupRepository(db as never).upsertBatch(TEST_SEASON, [{} as never]),
    },
    {
      name: 'points result',
      fake: fakeDatabase(),
      run: async (db: object) =>
        createTournamentPointsGroupResultsRepository(db as never).upsertBatch(TEST_SEASON, [
          {} as never,
        ]),
    },
    {
      name: 'knockout result',
      fake: fakeDatabase(),
      run: async (db: object) =>
        createTournamentKnockoutResultsRepository(db as never).upsertBatch(TEST_SEASON, [
          {} as never,
        ]),
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
