import { expect, mock, test } from 'bun:test';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import { createEventLiveRepository } from '../../src/repositories/event-lives';
import { createFixtureRepository } from '../../src/repositories/fixtures';
import { createTournamentBattleGroupResultsRepository } from '../../src/repositories/tournament-battle-group-results';
import { createTournamentKnockoutResultsRepository } from '../../src/repositories/tournament-knockout-results';
import { createTournamentPointsGroupResultsRepository } from '../../src/repositories/tournament-points-group-results';
import { createTournamentGroupRepository } from '../../src/repositories/tournament-groups';
import { createTournamentKnockoutsRepository } from '../../src/repositories/tournament-knockouts';
import { createUnderstatReferenceRepository } from '../../src/repositories/understat';
import { resolveTournamentPointsRaceSourceUpdatedAt } from '../../src/services/tournament-points-race-results.service';
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
    {
      name: 'fixture',
      fake: fakeDatabase(),
      run: async (db: object) =>
        createFixtureRepository(db as never).upsertBatch(TEST_SEASON, [{} as never]),
    },
    {
      name: 'tournament group',
      fake: fakeDatabase(),
      run: async (db: object) =>
        createTournamentGroupRepository(db as never).upsertBatch(TEST_SEASON, [{} as never]),
    },
    {
      name: 'tournament points result',
      fake: fakeDatabase(),
      run: async (db: object) =>
        createTournamentPointsGroupResultsRepository(db as never).upsertBatch(TEST_SEASON, [
          {} as never,
        ]),
    },
    {
      name: 'tournament battle result',
      fake: fakeDatabase(),
      run: async (db: object) =>
        createTournamentBattleGroupResultsRepository(db as never).upsertBatch(TEST_SEASON, [
          {} as never,
        ]),
    },
    {
      name: 'tournament knockout result',
      fake: fakeDatabase(),
      run: async (db: object) =>
        createTournamentKnockoutResultsRepository(db as never).upsertBatch(TEST_SEASON, [
          {} as never,
        ]),
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

test('points result guards reject stale source watermarks and advance proof independently', async () => {
  const fake = fakeDatabase();
  await createTournamentPointsGroupResultsRepository(fake.db as never).upsertBatch(TEST_SEASON, [
    { sourceUpdatedAt: new Date('2026-08-30T00:00:00Z') } as never,
  ]);
  const config = fake.onConflictDoUpdate.mock.calls[0]?.[0] as { where?: SQL };
  const guardSql = renderSql(config.where);
  expect(guardSql).toContain('source_updated_at');
  expect(guardSql).toContain('>=');
  expect(guardSql).toContain('>');
});

test('points result repairs without a source marker cannot overwrite a sourced row', async () => {
  const fake = fakeDatabase();
  await createTournamentPointsGroupResultsRepository(fake.db as never).upsertBatch(TEST_SEASON, [
    {} as never,
  ]);
  const config = fake.onConflictDoUpdate.mock.calls[0]?.[0] as { where?: SQL };
  expect(renderSql(config.where)).toContain('source_updated_at" IS NULL');
});

test('points race uses one cohort watermark for every ranked output', () => {
  const watermark = resolveTournamentPointsRaceSourceUpdatedAt([
    {
      richSyncedAt: new Date('2026-08-30T00:00:00Z'),
      updatedAt: new Date('2026-08-29T00:00:00Z'),
    },
    {
      richSyncedAt: null,
      updatedAt: new Date('2026-08-31T00:00:00Z'),
    },
  ]);

  expect(watermark.toISOString()).toBe('2026-08-31T00:00:00.000Z');
});

test('understat season upsert does not advance its source clock on unchanged input', async () => {
  const fake = fakeDatabase();
  await createUnderstatReferenceRepository(fake.db as never).upsertSeason({
    season: '9899',
    sourceYear: 2098,
    league: 'EPL',
    state: 'complete',
    firstSeenAt: new Date('2026-08-30T00:00:00Z'),
    lastSeenAt: new Date('2026-08-31T00:00:00Z'),
  });
  const config = fake.onConflictDoUpdate.mock.calls[0]?.[0] as { where?: SQL };
  const guardSql = renderSql(config.where);
  expect(guardSql).toContain('IS DISTINCT FROM');
  expect(guardSql).toContain('excluded.source_year');
  expect(guardSql).toContain('excluded.last_seen_at');
});
