import { describe, expect, it } from 'bun:test';

import { drizzle } from 'drizzle-orm/pg-proxy';

import type { PlayerValue } from '../../src/domain/player-values';
import { createEntryEventTransfersRepository } from '../../src/repositories/entry-event-transfers';
import { createPlayerValuesRepository } from '../../src/repositories/player-values';
import type { RawFPLEntryTransfer } from '../../src/types';

/**
 * FP-10 (H5, H6): upsert correctness.
 * The generated SQL must (a) never null out a computed
 * entry_event_transfers.element_in_played on re-sync, and (b) make
 * player_values inserts idempotent against the unique
 * (element_id, change_date) index so concurrent/repeated syncs don't
 * blow up the batch.
 */

type CapturedQuery = { sql: string; method: string };

type ProxyDb = Parameters<typeof createPlayerValuesRepository>[0];

function createCapturingDb(rowsForAll: unknown[] = []) {
  const queries: CapturedQuery[] = [];
  const db = drizzle(async (query, _params, method) => {
    queries.push({ sql: query, method });
    return { rows: method === 'execute' ? [] : rowsForAll };
  }) as unknown as NonNullable<ProxyDb>;
  // The production repository uses a transaction for replace-all semantics.
  // The proxy driver intentionally has no built-in transaction support, so
  // this unit double delegates the callback to the same query-capturing db.
  (db as unknown as { transaction: (fn: (tx: typeof db) => unknown) => unknown }).transaction =
    async (fn) => fn(db);
  return { db, queries };
}

function buildPlayerValue(elementId: number, changeDate = '20260717'): PlayerValue {
  return {
    elementId,
    webName: `Player ${elementId}`,
    elementType: 1,
    elementTypeName: 'GKP',
    eventId: 1,
    teamId: 1,
    teamName: 'Team',
    teamShortName: 'T',
    value: 50,
    changeDate,
    changeType: 'Rise',
    lastValue: 49,
  } as PlayerValue;
}

const TRANSFER: RawFPLEntryTransfer = {
  element_in: 100,
  element_in_cost: 55,
  element_out: 200,
  element_out_cost: 60,
  entry: 12345,
  event: 10,
  time: '2026-07-17T10:00:00Z',
};

describe('entry-event-transfers upsert (H5)', () => {
  it('COALESCEs element_in_played on conflict so re-syncs never null the computed value', async () => {
    const { db, queries } = createCapturingDb();
    const repo = createEntryEventTransfersRepository(db);

    await repo.replaceForEvent(12345, 10, [TRANSFER]);

    expect(
      queries.some((query) =>
        query.sql.includes(
          'on conflict ("entry_id","event_id","transfer_time","element_in_id","element_out_id") do update',
        ),
      ),
    ).toBe(true);
    expect(
      queries.some((query) =>
        query.sql.includes(
          '"element_in_played" = COALESCE(excluded.element_in_played, entry_event_transfers.element_in_played)',
        ),
      ),
    ).toBe(true);
  });

  it('keeps the onConflict=ignore path untouched', async () => {
    const { db, queries } = createCapturingDb();
    const repo = createEntryEventTransfersRepository(db);

    await repo.replaceForEvent(12345, 10, [TRANSFER], undefined, { onConflict: 'ignore' });

    expect(
      queries.some((query) =>
        query.sql.includes(
          'on conflict ("entry_id","event_id","transfer_time","element_in_id","element_out_id") do nothing',
        ),
      ),
    ).toBe(true);
    expect(queries.some((query) => query.sql.includes('COALESCE'))).toBe(false);
  });
});

describe('player-values insertBatch (H6)', () => {
  it('inserts with ON CONFLICT (element_id, change_date) DO NOTHING', async () => {
    const { db, queries } = createCapturingDb();
    const repo = createPlayerValuesRepository(db);

    await repo.insertBatch([buildPlayerValue(1), buildPlayerValue(2)]);

    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain('on conflict ("element_id","change_date") do nothing');
  });

  it('reports the actually inserted count and only those domain rows', async () => {
    // Simulate 2 of 3 rows winning the race — the rest hit DO NOTHING.
    // pg-proxy returning() expects array rows in column order:
    // id, element_id, element_type, event_id, value, change_date, change_type, last_value, created_at
    const { db } = createCapturingDb([
      [1, 1, 1, 1, 50, '20260717', 'rise', 49, new Date()],
      [2, 2, 1, 1, 50, '20260717', 'rise', 49, new Date()],
    ]);
    const repo = createPlayerValuesRepository(db);

    const result = await repo.insertBatch([
      buildPlayerValue(1),
      buildPlayerValue(2),
      buildPlayerValue(3),
    ]);

    expect(result.count).toBe(2);
    expect(result.inserted.map((pv) => pv.elementId)).toEqual([1, 2]);
    expect(result.inserted.some((pv) => pv.elementId === 3)).toBe(false);
  });

  it('short-circuits empty batches without touching the database', async () => {
    const { db, queries } = createCapturingDb();
    const repo = createPlayerValuesRepository(db);

    const result = await repo.insertBatch([]);

    expect(result.count).toBe(0);
    expect(result.inserted).toEqual([]);
    expect(queries).toHaveLength(0);
  });
});
