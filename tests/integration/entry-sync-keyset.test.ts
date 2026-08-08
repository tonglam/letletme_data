import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { getDbClient } from '../../src/db/singleton';
import { loadEntryIdsForSync } from '../../src/workers/entry-sync.worker';

const BASE_ID = 99_043_100;
const originalIds = Array.from({ length: 6 }, (_, index) => BASE_ID + index);
const insertedDuringScan = BASE_ID + 6;

describe('entry sync keyset pagination', () => {
  beforeAll(async () => {
    const sql = await getDbClient();
    await sql`
      INSERT INTO entry_infos (id, entry_name, player_name)
      SELECT id, 'Keyset entry ' || id, 'Keyset manager'
      FROM unnest(${originalIds}::integer[]) AS id
      ON CONFLICT (id) DO NOTHING
    `;
  });

  afterAll(async () => {
    const sql = await getDbClient();
    await sql`
      DELETE FROM entry_infos
      WHERE id = ANY(${[...originalIds, insertedDuringScan]}::integer[])
    `;
  });

  test('does not skip remaining rows when earlier rows disappear during a scan', async () => {
    const first = await loadEntryIdsForSync({
      source: 'manual',
      triggeredAt: new Date().toISOString(),
      afterEntryId: BASE_ID - 1,
      chunkSize: 2,
    });
    expect(first.entryIds).toEqual(originalIds.slice(0, 2));

    const sql = await getDbClient();
    await sql`DELETE FROM entry_infos WHERE id = ${originalIds[0]}`;
    await sql`
      INSERT INTO entry_infos (id, entry_name, player_name)
      VALUES (${insertedDuringScan}, 'Inserted during scan', 'Keyset manager')
    `;

    const seen = [...first.entryIds];
    let cursor = first.lastEntryId!;
    while (true) {
      const page = await loadEntryIdsForSync({
        source: 'manual',
        triggeredAt: new Date().toISOString(),
        afterEntryId: cursor,
        chunkSize: 2,
      });
      seen.push(...page.entryIds);
      if (page.entryIds.length === 0) break;
      cursor = page.lastEntryId!;
      if (!page.hasMore) break;
    }

    expect(seen).toEqual([...originalIds, insertedDuringScan]);
    expect(new Set(seen).size).toBe(seen.length);
  });
});
