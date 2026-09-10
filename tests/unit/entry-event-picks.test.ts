import { describe, expect, mock, test } from 'bun:test';

import { entryEventPickHeadsInCompetition } from '../../src/db/schemas/index.schema';
import type { DbHandle } from '../../src/db/singleton';
import { createEntryEventPicksRepository } from '../../src/repositories/entry-event-picks';
import { TEST_SEASON } from '../fixtures/seasons.fixtures';

describe('entry event picks repository', () => {
  test('findHead projects entryId for final retention identity validation', async () => {
    const row = {
      entryId: 777,
      publicationId: '00000000-0000-4000-8000-000000000777',
      generation: 5,
      picksBaseRevision: 'revision-5',
      contentSha256: 'content-5',
      inputPayload: null,
      rowCount: 15,
      sourceCheckedAt: new Date('2026-09-04T08:00:00.000Z'),
      contentUpdatedAt: new Date('2026-09-04T08:00:00.000Z'),
      checkpointedAt: new Date('2026-09-04T08:00:00.000Z'),
      state: 'COMPLETE',
    };
    const limit = mock(async () => [row]);
    const where = mock(() => ({ limit }));
    const from = mock(() => ({ where }));
    const select = mock((_projection: Record<string, unknown>) => ({ from }));
    const db = { select } as unknown as DbHandle;

    const repository = createEntryEventPicksRepository(db);
    await expect(repository.findHead(TEST_SEASON, 777, 2)).resolves.toMatchObject({
      entryId: 777,
    });

    const projection = select.mock.calls[0]?.[0];
    expect(projection?.entryId).toBe(entryEventPickHeadsInCompetition.entryId);
  });

  test('does not rewrite an existing head for an identical replay', async () => {
    const syncedAt = new Date('2026-09-04T08:00:00.000Z');
    const existing = Array.from({ length: 15 }, (_, index) => ({
      position: index + 1,
      elementId: 100 + index,
      eventTeamId: null,
      multiplier: index === 0 ? 2 : 1,
      isCaptain: index === 0,
      isViceCaptain: index === 1,
      transfers: 0,
      activeChip: null,
      transfersCost: 0,
      sourceCreatedAt: syncedAt,
      sourceUpdatedAt: syncedAt,
    }));
    const head = { rowCount: 15, state: 'COMPLETE', inputPayload: null };
    let selectCount = 0;
    const select = mock(() => ({
      from: () => ({
        where: () => {
          selectCount += 1;
          return selectCount === 1 ? Promise.resolve(existing) : { limit: async () => [head] };
        },
      }),
    }));
    const insert = mock(() => {
      throw new Error('identical pick replay must not write');
    });
    const db = { select, insert } as unknown as DbHandle;
    const repository = createEntryEventPicksRepository(db);
    const picks = {
      active_chip: null,
      entry_history: {
        event: 2,
        event_transfers: 0,
        event_transfers_cost: 0,
      },
      picks: existing.map((row) => ({
        element: row.elementId,
        position: row.position,
        multiplier: row.multiplier,
        is_captain: row.isCaptain,
        is_vice_captain: row.isViceCaptain,
      })),
    } as never;

    await expect(
      repository.upsertFromPicks(TEST_SEASON, 777, 2, picks, syncedAt),
    ).resolves.toBeUndefined();
    expect(insert).not.toHaveBeenCalled();
  });

  test('rewrites every row with one timestamp when a later snapshot changes content', async () => {
    const previousSyncedAt = new Date('2026-09-04T08:00:00.000Z');
    const syncedAt = new Date('2026-09-04T08:05:00.000Z');
    const existing = Array.from({ length: 15 }, (_, index) => ({
      position: index + 1,
      elementId: 100 + index,
      eventTeamId: null,
      multiplier: index === 0 ? 2 : 1,
      isCaptain: index === 0,
      isViceCaptain: index === 1,
      transfers: 0,
      activeChip: null,
      transfersCost: 0,
      sourceCreatedAt: previousSyncedAt,
      sourceUpdatedAt: previousSyncedAt,
    }));
    const head = {
      publicationId: 'publication-1',
      generation: 1,
      picksBaseRevision: 'revision-1',
      contentSha256: 'previous-content',
      rowCount: 15,
      state: 'COMPLETE',
      inputPayload: null,
      sourceCheckedAt: previousSyncedAt,
      contentUpdatedAt: previousSyncedAt,
      checkpointedAt: previousSyncedAt,
    };
    const writes: Array<{ rows: unknown[]; config: { where?: unknown } }> = [];
    let selectCount = 0;
    const select = mock(() => ({
      from: () => ({
        where: () => {
          selectCount += 1;
          if (selectCount === 1) return Promise.resolve(existing);
          if (selectCount === 2 || selectCount === 4) {
            return { limit: async () => [head] };
          }
          return Promise.resolve([]);
        },
      }),
    }));
    const insert = mock(() => ({
      values: (rows: unknown[]) => ({
        onConflictDoUpdate: async (config: { where?: unknown }) => {
          writes.push({ rows, config });
        },
      }),
    }));
    const db = { select, insert } as unknown as DbHandle;
    const repository = createEntryEventPicksRepository(db);
    const picks = {
      active_chip: null,
      entry_history: {
        event: 2,
        event_transfers: 0,
        event_transfers_cost: 0,
      },
      picks: existing.map((row, index) => ({
        element: row.elementId,
        position: row.position,
        multiplier: index === 0 ? 3 : row.multiplier,
        is_captain: row.isCaptain,
        is_vice_captain: row.isViceCaptain,
      })),
    } as never;

    await expect(
      repository.upsertFromPicks(TEST_SEASON, 777, 2, picks, syncedAt),
    ).resolves.toBeUndefined();

    expect(writes).toHaveLength(2);
    const pickWrite = writes[0];
    expect(pickWrite.rows).toHaveLength(15);
    expect(
      new Set(
        (pickWrite.rows as Array<{ sourceUpdatedAt: Date }>).map((row) =>
          row.sourceUpdatedAt.getTime(),
        ),
      ),
    ).toEqual(new Set([syncedAt.getTime()]));
    expect(pickWrite.config.where).toBeUndefined();
  });
});
