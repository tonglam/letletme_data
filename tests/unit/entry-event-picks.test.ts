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
});
