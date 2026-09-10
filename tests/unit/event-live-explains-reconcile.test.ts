import { describe, expect, mock, test } from 'bun:test';

import { createEventLiveExplainsRepository } from '../../src/repositories/event-live-explains';
import type { DbEventLiveExplain } from '../../src/db/schemas/index.schema';
import type { EventLiveExplain } from '../../src/domain/event-live-explains';
import { TEST_SEASON } from '../fixtures/seasons.fixtures';

const explain = (overrides: Partial<EventLiveExplain> = {}): EventLiveExplain => ({
  eventId: 1,
  elementId: 10,
  bonus: null,
  minutes: 90,
  minutesPoints: 2,
  goalsScored: null,
  goalsScoredPoints: null,
  assists: null,
  assistsPoints: null,
  cleanSheets: null,
  cleanSheetsPoints: null,
  goalsConceded: null,
  goalsConcededPoints: null,
  ownGoals: null,
  ownGoalsPoints: null,
  penaltiesSaved: null,
  penaltiesSavedPoints: null,
  penaltiesMissed: null,
  penaltiesMissedPoints: null,
  yellowCards: null,
  yellowCardsPoints: null,
  redCards: null,
  redCardsPoints: null,
  saves: null,
  savesPoints: null,
  defensiveContribution: null,
  defensiveContributionPoints: null,
  ...overrides,
});

const scoringRow = (overrides: Partial<DbEventLiveExplain> = {}): DbEventLiveExplain => ({
  seasonId: TEST_SEASON.seasonId,
  eventId: 1,
  elementId: 10,
  scoringIdentifier: 'minutes',
  scoringValue: 90,
  points: 2,
  sourceExplainId: 1,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  ...overrides,
});

function fakeDatabase(existing: DbEventLiveExplain[], changed: DbEventLiveExplain[] = []) {
  const insertReturning = mock(async () => changed);
  const onConflictDoUpdate = mock((_config: unknown) => ({ returning: insertReturning }));
  const values = mock((_rows: unknown) => ({ onConflictDoUpdate }));
  const insert = mock((_table: unknown) => ({ values }));
  const deleteReturning = mock(async () => [] as DbEventLiveExplain[]);
  const deleteWhere = mock((_where: unknown) => ({ returning: deleteReturning }));
  const remove = mock((_table: unknown) => ({ where: deleteWhere }));
  const selectWhere = mock(async () => existing);
  const from = mock((_table: unknown) => ({ where: selectWhere }));
  const select = mock(() => ({ from }));
  return {
    db: { select, insert, delete: remove },
    insert,
    remove,
    onConflictDoUpdate,
    deleteReturning,
  };
}

describe('event live scoring reconciliation', () => {
  test('does not write an identical complete event', async () => {
    const fake = fakeDatabase([scoringRow()]);
    const result = await createEventLiveExplainsRepository(fake.db as never).replaceEvent(
      TEST_SEASON,
      [explain()],
    );

    expect(result).toEqual([]);
    expect(fake.insert).not.toHaveBeenCalled();
    expect(fake.remove).not.toHaveBeenCalled();
  });

  test('updates changed items and removes stale keys in the same reconcile', async () => {
    const stale = scoringRow({
      sourceExplainId: 2,
      scoringIdentifier: 'goals_scored',
      scoringValue: 1,
      points: 5,
    });
    const changed = scoringRow({ scoringValue: 95 });
    const fake = fakeDatabase([scoringRow(), stale], [changed]);
    fake.deleteReturning.mockResolvedValue([stale]);

    const result = await createEventLiveExplainsRepository(fake.db as never).replaceEvent(
      TEST_SEASON,
      [explain({ minutes: 95 })],
    );

    expect(result).toHaveLength(2);
    expect(fake.insert).toHaveBeenCalledTimes(1);
    expect(fake.remove).toHaveBeenCalledTimes(1);
  });

  test('treats a complete zero-item payload as a scoped clear', async () => {
    const fake = fakeDatabase([scoringRow()]);
    fake.deleteReturning.mockResolvedValue([scoringRow()]);

    const result = await createEventLiveExplainsRepository(fake.db as never).replaceEvent(
      TEST_SEASON,
      [explain({ minutes: null, minutesPoints: null })],
    );

    expect(result).toHaveLength(1);
    expect(fake.remove).toHaveBeenCalledTimes(1);
    expect(fake.insert).not.toHaveBeenCalled();
  });

  test('keeps an empty records array as no action', async () => {
    const fake = fakeDatabase([scoringRow()]);
    const result = await createEventLiveExplainsRepository(fake.db as never).replaceEvent(
      TEST_SEASON,
      [],
    );

    expect(result).toEqual([]);
    expect(fake.db.select).not.toHaveBeenCalled();
    expect(fake.remove).not.toHaveBeenCalled();
  });

  test('rejects duplicate normalized keys before touching the database', async () => {
    const fake = fakeDatabase([]);
    await expect(
      createEventLiveExplainsRepository(fake.db as never).replaceEvent(TEST_SEASON, [
        explain(),
        explain(),
      ]),
    ).rejects.toThrow('Duplicate event live scoring item');
    expect(fake.db.select).not.toHaveBeenCalled();
    expect(fake.insert).not.toHaveBeenCalled();
  });
});
