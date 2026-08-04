import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { redisSingleton } from '../../src/cache/singleton';
import { getDbClient } from '../../src/db/singleton';
import { entryEventTransfersRepository } from '../../src/repositories/entry-event-transfers';
import { entryInfoRepository } from '../../src/repositories/entry-infos';
import { syncEntryInfo, type EntryInfoClient } from '../../src/services/entry-info.service';
import {
  ensureTournamentCoreResults,
  enrichTournamentHistory,
  type TournamentCoreSyncPlan,
  type TournamentEnrichmentPlan,
} from '../../src/services/tournament-backfill.service';
import { mockFPLClient, resetMockFPLClient } from './helpers/mock-fpl';

const ENTRY_ID = 99_042_001;
const LATE_ENTRY_ID = 99_042_002;
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
    SELECT event_id, 'Checkpoint GW' || event_id
    FROM generate_series(1, 12) AS generated(event_id)
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
  await sql`DELETE FROM entry_event_results WHERE entry_id = ${LATE_ENTRY_ID}`;
  await sql`DELETE FROM entry_infos WHERE id = ${LATE_ENTRY_ID}`;
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

  test('implicit snapshot sync checkpoints only the latest finalized event', async () => {
    const sql = await getDbClient();
    await sql`
      UPDATE events
      SET finished = CASE WHEN id = 1 THEN true ELSE false END,
          data_checked = CASE WHEN id = 1 THEN true ELSE false END
      WHERE id BETWEEN 1 AND 12
    `;
    await sql`
      UPDATE entry_infos
      SET entry_snapshot_synced_through_event_id = NULL
      WHERE id = ${ENTRY_ID}
    `;
    const provisionalClient: EntryInfoClient = {
      ...client,
      async getEntryHistory() {
        const history = await client.getEntryHistory(ENTRY_ID);
        return {
          ...history,
          current: [
            ...history.current,
            {
              event: 12,
              points: 60,
              total_points: 110,
              event_transfers: 0,
              event_transfers_cost: 0,
            },
          ],
        };
      },
    };

    try {
      await syncEntryInfo(ENTRY_ID, provisionalClient);
      expect((await checkpointRow())?.snapshot).toBe(1);
    } finally {
      await sql`
        UPDATE events
        SET finished = false, data_checked = false
        WHERE id BETWEEN 1 AND 12
      `;
    }
  });

  test('seeds zero baselines without fetching impossible pre-entry gameweeks', async () => {
    const sql = await getDbClient();
    await sql`
      INSERT INTO entry_infos (id, entry_name, player_name, started_event)
      VALUES (${LATE_ENTRY_ID}, 'Late XI', 'Late Manager', 10)
      ON CONFLICT (id) DO UPDATE SET started_event = 10
    `;
    await sql`
      INSERT INTO entry_event_results (
        entry_id,
        event_id,
        event_points,
        event_transfers,
        event_transfers_cost,
        event_net_points,
        overall_points,
        overall_rank
      )
      SELECT ${LATE_ENTRY_ID}, event_id, 10, 0, 0, 10, 10, 1000
      FROM generate_series(10, 12) AS generated(event_id)
      ON CONFLICT (entry_id, event_id) DO NOTHING
    `;
    const plans: TournamentCoreSyncPlan[] = [];

    await ensureTournamentCoreResults(
      [LATE_ENTRY_ID],
      { startEventId: 1, endEventId: 12 },
      undefined,
      (nextPlan) => {
        plans.push(nextPlan);
      },
    );

    const rows = await sql<{ eventId: number; eventPoints: number; overallRank: number }[]>`
      SELECT
        event_id AS "eventId",
        event_points AS "eventPoints",
        overall_rank AS "overallRank"
      FROM entry_event_results
      WHERE entry_id = ${LATE_ENTRY_ID}
      ORDER BY event_id
    `;
    expect(rows).toHaveLength(12);
    expect(rows.slice(0, 9).every((row) => row.eventPoints === 0)).toBe(true);
    expect(rows.slice(0, 9).every((row) => row.overallRank === 2_147_483_647)).toBe(true);
    expect(plans).toEqual([{ totalPairs: 3, missingPairs: 0, reusedPairs: 3 }]);
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
