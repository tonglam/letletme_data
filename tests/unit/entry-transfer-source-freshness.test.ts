import { describe, expect, mock, test } from 'bun:test';

import type { DbHandle } from '../../src/db/singleton';
import { createEntryEventTransfersRepository } from '../../src/repositories/entry-event-transfers';
import { TEST_SEASON } from '../fixtures/seasons.fixtures';

function repositoryWithSourceRows(rows: Array<{ entryId: number; sourceIsFresh: boolean | null }>) {
  const where = mock(async () => rows);
  const from = mock(() => ({ where }));
  const select = mock(() => ({ from }));
  const db = { select } as unknown as DbHandle;

  return {
    repository: createEntryEventTransfersRepository(db),
    select,
  };
}

describe('entry transfer source freshness', () => {
  test('selects missing, null, and older source checkpoints while preserving entry order', async () => {
    const cutoff = '2026-08-25T08:00:00.000Z';
    const { repository } = repositoryWithSourceRows([
      { entryId: 10, sourceIsFresh: null },
      { entryId: 20, sourceIsFresh: false },
      { entryId: 30, sourceIsFresh: true },
      { entryId: 40, sourceIsFresh: true },
    ]);

    await expect(
      repository.findEntryIdsNeedingSourceRefresh(TEST_SEASON, [40, 10, 50, 20, 30, 10], cutoff),
    ).resolves.toEqual([10, 50, 20]);
  });

  test('rejects an invalid boundary before querying the database', async () => {
    const { repository, select } = repositoryWithSourceRows([]);

    await expect(
      repository.findEntryIdsNeedingSourceRefresh(TEST_SEASON, [10], 'not-a-timestamp'),
    ).rejects.toThrow('A valid entry transfer freshness cutoff is required');
    expect(select).not.toHaveBeenCalled();
  });
});
