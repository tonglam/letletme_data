import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { redisSingleton } from '../../src/cache/singleton';
import { getDbClient } from '../../src/db/singleton';
import { entryEventTransfersRepository } from '../../src/repositories/entry-event-transfers';
import { entryInfoRepository } from '../../src/repositories/entry-infos';
import { syncEntryInfo, type EntryInfoClient } from '../../src/services/entry-info.service';
import {
  enrichTournamentHistory,
  type TournamentEnrichmentPlan,
} from '../../src/services/tournament-backfill.service';
import { mockFPLClient, resetMockFPLClient } from './helpers/mock-fpl';

const ENTRY_ID = 99_042_001;
const TEST_SEASON = '2526';

const client: EntryInfoClient = {
  async getEntrySummary() {
    return {
      id: ENTRY_ID,
      name: 'Checkpoint XI',
      player_first_name: 'Checkpoint',
      player_last_name: 'Manager',
      player_region_name: 'Australia',
      started_event: 1,
      summary_overall_points: 50,
      summary_overall_rank: 100,
      bank: 0,
      value: 1000,
      leagues: { classic: [], h2h: [] },
    };
  },
  async getEntryHistory() {
    return {
      current: [
        {
          event: 1,
          points: 50,
          total_points: 50,
          event_transfers: 0,
          event_transfers_cost: 0,
        },
      ],
      chips: [],
      past: [],
    };
  },
};

async function checkpointRow() {
  const sql = await getDbClient();
  const rows = await sql<
    {
      snapshot: number | null;
      transfers: number | null;
    }[]
  >`
    SELECT
      entry_snapshot_synced_through_event_id AS snapshot,
      entry_transfers_synced_through_event_id AS transfers
    FROM entry_infos
    WHERE id = ${ENTRY_ID}
  `;
  return rows[0];
}

beforeAll(async () => {
  const redis = await redisSingleton.getClient();
  await redis.set('Season:active', TEST_SEASON);
  const sql = await getDbClient();
  await sql`
    INSERT INTO events (id, name)
    VALUES (1, 'Checkpoint GW1'), (10, 'Checkpoint GW10'), (11, 'Checkpoint GW11'),
           (12, 'Checkpoint GW12')
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO entry_infos (id, entry_name, player_name)
    VALUES (${ENTRY_ID}, 'Checkpoint XI', 'Checkpoint Manager')
    ON CONFLICT (id) DO UPDATE SET
      entry_snapshot_synced_through_event_id = NULL,
      entry_transfers_synced_through_event_id = NULL
  `;
});

afterAll(async () => {
  const sql = await getDbClient();
  await sql`DELETE FROM entry_event_transfers WHERE entry_id = ${ENTRY_ID}`;
  await sql`DELETE FROM entry_event_results WHERE entry_id = ${ENTRY_ID}`;
  await sql`DELETE FROM entry_league_infos WHERE entry_id = ${ENTRY_ID}`;
  await sql`DELETE FROM entry_history_infos WHERE entry_id = ${ENTRY_ID}`;
  await sql`DELETE FROM entry_infos WHERE id = ${ENTRY_ID}`;
  const redis = await redisSingleton.getClient();
  await redis.hdel(`EntryInfo:${TEST_SEASON}`, String(ENTRY_ID));
});

describe('tournament initialization checkpoints', () => {
  test('snapshot sync advances atomically and stale selection reuses it', async () => {
    await syncEntryInfo(ENTRY_ID, client, 12);

    expect((await checkpointRow())?.snapshot).toBe(12);
    expect(await entryInfoRepository.findIdsNeedingSnapshotSync([ENTRY_ID], 12)).toEqual([]);
    expect(await entryInfoRepository.findIdsNeedingSnapshotSync([ENTRY_ID], 11)).toEqual([]);
    expect(await entryInfoRepository.findIdsNeedingSnapshotSync([ENTRY_ID], 13)).toEqual([
      ENTRY_ID,
    ]);
  });

  test('preseason zero is complete only for a preseason target', async () => {
    const sql = await getDbClient();
    await sql`
      UPDATE entry_infos
      SET entry_snapshot_synced_through_event_id = 0,
          entry_transfers_synced_through_event_id = 0
      WHERE id = ${ENTRY_ID}
    `;

    expect(await entryInfoRepository.findIdsNeedingSnapshotSync([ENTRY_ID], 0)).toEqual([]);
    expect(await entryInfoRepository.findIdsNeedingSnapshotSync([ENTRY_ID], 1)).toEqual([ENTRY_ID]);
    expect(await entryEventTransfersRepository.findEntryIdsNeedingSync([ENTRY_ID], 0)).toEqual([]);
    expect(await entryEventTransfersRepository.findEntryIdsNeedingSync([ENTRY_ID], 1)).toEqual([
      ENTRY_ID,
    ]);
  });

  test('preseason enrichment establishes an empty transfer checkpoint without picks calls', async () => {
    const sql = await getDbClient();
    await sql`
      UPDATE entry_infos
      SET entry_transfers_synced_through_event_id = NULL
      WHERE id = ${ENTRY_ID}
    `;
    let plan: TournamentEnrichmentPlan | null = null;
    mockFPLClient({ getEntryTransfers: async () => [] });
    try {
      const issues = await enrichTournamentHistory(0, [ENTRY_ID], null, {
        onPlan: (nextPlan) => {
          plan = nextPlan;
        },
      });
      expect(issues).toEqual([]);
    } finally {
      resetMockFPLClient();
    }

    expect(plan).toMatchObject({
      totalPickPairs: 0,
      missingPickPairs: 0,
      requestedTransferEntries: 1,
    });
    expect((await checkpointRow())?.transfers).toBe(0);
  });

  test('failed snapshot fetch never advances the checkpoint', async () => {
    const sql = await getDbClient();
    await sql`
      UPDATE entry_infos
      SET entry_snapshot_synced_through_event_id = NULL
      WHERE id = ${ENTRY_ID}
    `;
    const failingClient: EntryInfoClient = {
      ...client,
      async getEntryHistory() {
        throw new Error('fixture history failure');
      },
    };

    await expect(syncEntryInfo(ENTRY_ID, failingClient, 12)).rejects.toThrow(
      'fixture history failure',
    );
    expect((await checkpointRow())?.snapshot).toBeNull();
  });

  test('empty full transfer history is a completed canonical sync', async () => {
    const sql = await getDbClient();
    await sql`
      UPDATE entry_infos
      SET entry_transfers_synced_through_event_id = NULL
      WHERE id = ${ENTRY_ID}
    `;
    await entryEventTransfersRepository.replaceForEvent(ENTRY_ID, 10, [], undefined, {
      syncMode: 'all',
    });

    expect((await checkpointRow())?.transfers).toBe(10);
    expect(await entryEventTransfersRepository.findEntryIdsNeedingSync([ENTRY_ID], 10)).toEqual([]);
    expect(await entryEventTransfersRepository.findEntryIdsNeedingSync([ENTRY_ID], 11)).toEqual([
      ENTRY_ID,
    ]);
  });

  test('per-event sync advances only a contiguous checkpoint', async () => {
    const sql = await getDbClient();
    await sql`
      UPDATE entry_infos
      SET entry_transfers_synced_through_event_id = 9
      WHERE id = ${ENTRY_ID}
    `;

    await entryEventTransfersRepository.replaceForEvent(ENTRY_ID, 10, [], undefined, {
      syncMode: 'latest',
    });
    await entryEventTransfersRepository.replaceForEvent(ENTRY_ID, 12, [], undefined, {
      syncMode: 'latest',
    });
    expect((await checkpointRow())?.transfers).toBe(10);

    await entryEventTransfersRepository.replaceForEvent(ENTRY_ID, 11, [], undefined, {
      syncMode: 'latest',
    });
    await entryEventTransfersRepository.replaceForEvent(ENTRY_ID, 12, [], undefined, {
      syncMode: 'latest',
    });
    expect((await checkpointRow())?.transfers).toBe(12);
  });

  test('concurrent full syncs preserve the highest checkpoint', async () => {
    const sql = await getDbClient();
    await sql`
      UPDATE entry_infos
      SET entry_transfers_synced_through_event_id = NULL
      WHERE id = ${ENTRY_ID}
    `;
    await Promise.all([
      entryEventTransfersRepository.replaceForEvent(ENTRY_ID, 10, [], undefined, {
        syncMode: 'all',
      }),
      entryEventTransfersRepository.replaceForEvent(ENTRY_ID, 12, [], undefined, {
        syncMode: 'all',
      }),
    ]);
    expect((await checkpointRow())?.transfers).toBe(12);
  });

  test('concurrent snapshot syncs preserve the highest checkpoint', async () => {
    const sql = await getDbClient();
    await sql`
      UPDATE entry_infos
      SET entry_snapshot_synced_through_event_id = NULL
      WHERE id = ${ENTRY_ID}
    `;
    await Promise.all([syncEntryInfo(ENTRY_ID, client, 10), syncEntryInfo(ENTRY_ID, client, 12)]);
    expect((await checkpointRow())?.snapshot).toBe(12);
  });

  test('range constraint rolls back an invalid checkpoint update', async () => {
    const before = (await checkpointRow())?.transfers;
    await expect(
      entryEventTransfersRepository.replaceForEvent(ENTRY_ID, 39, [], undefined, {
        syncMode: 'all',
      }),
    ).rejects.toThrow();
    expect((await checkpointRow())?.transfers).toBe(before);
  });
});
