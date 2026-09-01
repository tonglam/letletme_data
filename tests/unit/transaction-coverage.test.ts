import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import type { DbEntryInfo } from '../../src/db/schemas/index.schema';
import { createEntryInfoRepository } from '../../src/repositories/entry-infos';
import type { RawFPLEntrySummary } from '../../src/types';
import { TEST_SEASON } from '../fixtures/seasons.fixtures';

const dialect = new PgDialect();
const renderSql = (value: unknown): string => dialect.sqlToQuery(value as SQL).sql;

describe('entry-info atomic upsert contract', () => {
  const summary = {
    id: 42,
    name: 'Alpha FC',
    player_first_name: 'Ada',
    player_last_name: 'Lovelace',
    player_region_name: 'England',
    started_event: 1,
    summary_overall_points: 1234,
    summary_overall_rank: 555,
    last_deadline_value: 1010,
    value: 1005,
    last_deadline_bank: 33,
    bank: 30,
    last_deadline_total_transfers: 12,
  } as unknown as RawFPLEntrySummary;
  const row = {
    seasonId: TEST_SEASON.seasonId,
    entryId: 42,
    snapshotSyncedThroughEventId: null,
    transfersSyncedThroughEventId: null,
    transfersSourceCheckedAt: null,
  } as unknown as DbEntryInfo;

  function fakeDatabase() {
    const returning = mock(async () => [row]);
    const onConflictDoUpdate = mock((_config: unknown) => ({ returning }));
    const values = mock((_insert: unknown) => ({ onConflictDoUpdate }));
    const insert = mock((_table: unknown) => ({ values }));
    const select = mock(() => {
      throw new Error('SELECT must not run before the atomic upsert');
    });
    return { db: { insert, select }, values, onConflictDoUpdate, select };
  }

  let fake: ReturnType<typeof fakeDatabase>;
  beforeEach(() => {
    fake = fakeDatabase();
  });

  it('issues one season-scoped INSERT without read-modify-write', async () => {
    const repository = createEntryInfoRepository(fake.db as never);
    await expect(repository.upsertFromSummary(TEST_SEASON, summary, 7)).resolves.toMatchObject({
      seasonId: TEST_SEASON.seasonId,
      entryId: 42,
      id: 42,
      entrySnapshotSyncedSeason: TEST_SEASON.seasonCode,
      entryTransfersSyncedSeason: TEST_SEASON.seasonCode,
    });

    expect(fake.select).not.toHaveBeenCalled();
    expect(fake.values).toHaveBeenCalledTimes(1);
    const insert = fake.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(insert).toMatchObject({
      seasonId: TEST_SEASON.seasonId,
      entryId: 42,
      entryName: 'Alpha FC',
      lastEventId: 7,
      usedEntryNames: ['Alpha FC'],
    });
    expect(insert.profileSourceCheckedAt).toBeInstanceOf(Date);
  });

  it('uses the schema-defined preseason checkpoint when no event exists', async () => {
    const repository = createEntryInfoRepository(fake.db as never);
    await repository.upsertFromSummary(TEST_SEASON, summary, null);

    const insert = fake.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(insert.lastEventId).toBe(0);
    const conflict = fake.onConflictDoUpdate.mock.calls[0]?.[0] as {
      set: Record<string, unknown>;
    };
    expect(renderSql(conflict.set.lastEventId)).toContain('GREATEST');
  });

  it('computes prior-value fields from the pre-update row inside the conflict update', async () => {
    const repository = createEntryInfoRepository(fake.db as never);
    await repository.upsertFromSummary(TEST_SEASON, summary, 7);

    const conflict = fake.onConflictDoUpdate.mock.calls[0]?.[0] as {
      set: Record<string, unknown>;
    };
    expect(renderSql(conflict.set.lastBank)).toContain(
      'COALESCE("competition"."entries"."bank", 0)',
    );
    expect(renderSql(conflict.set.lastOverallPoints)).toContain(
      'COALESCE("competition"."entries"."overall_points", 0)',
    );
    expect(renderSql(conflict.set.lastEntryName)).toContain('"competition"."entries"."entry_name"');
    expect(renderSql(conflict.set.lastEntryName)).toContain('CASE');
    expect(renderSql(conflict.set.lastEntryName)).toContain('last_entry_name');
    expect(conflict.set.profileSourceCheckedAt).toBeInstanceOf(Date);
    expect(renderSql(conflict.set.usedEntryNames)).toContain('WITH ORDINALITY');
  });
});
