import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();
import { describe, expect, test } from 'bun:test';
import { eq, sql } from 'drizzle-orm';

import { events } from '../../src/db/schemas/index.schema';
import { getDb } from '../../src/db/singleton';
import { createEventRepository } from '../../src/repositories/events';
import { previousEventFixture } from '../fixtures/events.fixtures';

class RollbackFinalizationTest extends Error {}

describe('event finalization checkpoint', () => {
  test('authors an inserted finalization boundary with the PostgreSQL clock', async () => {
    const db = await getDb();

    try {
      await db.transaction(async (transaction) => {
        const repository = createEventRepository(transaction);
        const candidate = {
          ...previousEventFixture,
          id: 99_042_038,
          name: 'Inserted finalization checkpoint test',
          finished: true,
          dataChecked: true,
          isPrevious: false,
        };
        const before = await transaction.execute<{ now: string }>(
          sql`SELECT clock_timestamp() AS now`,
        );
        await repository.upsertBatch([candidate]);
        const after = await transaction.execute<{ now: string }>(
          sql`SELECT clock_timestamp() AS now`,
        );
        const finalizedAt = (await repository.findById(candidate.id))?.dataCheckedAt;

        expect(finalizedAt).toBeInstanceOf(Date);
        expect(finalizedAt!.getTime()).toBeGreaterThanOrEqual(new Date(before[0]!.now).getTime());
        expect(finalizedAt!.getTime()).toBeLessThanOrEqual(new Date(after[0]!.now).getTime());

        throw new RollbackFinalizationTest();
      });
    } catch (error) {
      if (!(error instanceof RollbackFinalizationTest)) throw error;
    }
  });

  test('records data-checked transition once and preserves it across core refreshes', async () => {
    const db = await getDb();

    try {
      await db.transaction(async (transaction) => {
        const repository = createEventRepository(transaction);
        const candidate = {
          ...previousEventFixture,
          id: 37,
          name: 'Stable finalization checkpoint test',
          finished: true,
          dataChecked: false,
          isPrevious: false,
        };

        await repository.upsertBatch([candidate]);
        expect((await repository.findById(candidate.id))?.dataCheckedAt).toBeNull();

        await repository.upsertBatch([{ ...candidate, dataChecked: true }]);
        const finalized = await repository.findById(candidate.id);
        expect(finalized?.dataCheckedAt).toBeInstanceOf(Date);
        const finalizedAt = finalized?.dataCheckedAt;
        if (!finalizedAt) throw new Error('Expected finalization checkpoint');

        const unrelatedUpdatedAt = new Date(finalizedAt.getTime() + 86_400_000);
        await transaction
          .update(events)
          .set({ updatedAt: unrelatedUpdatedAt })
          .where(eq(events.id, candidate.id));
        expect((await repository.findById(candidate.id))?.updatedAt).toEqual(unrelatedUpdatedAt);

        await repository.upsertBatch([{ ...candidate, dataChecked: true }]);
        const refreshed = await repository.findById(candidate.id);
        expect(refreshed?.dataCheckedAt).toEqual(finalizedAt);

        throw new RollbackFinalizationTest();
      });
    } catch (error) {
      if (!(error instanceof RollbackFinalizationTest)) throw error;
    }
  });
});
