import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { resetActiveSeasonMemo } from '../../src/cache/cache-season';
import { entryInfosCache } from '../../src/cache/entry-infos-cache';
import { redisSingleton } from '../../src/cache/singleton';
import { getDbClient } from '../../src/db/singleton';
import { entryEventCupResultsRepository } from '../../src/repositories/entry-event-cup-results';
import { entryEventPicksRepository } from '../../src/repositories/entry-event-picks';
import { entryEventResultsRepository } from '../../src/repositories/entry-event-results';
import {
  ENTRY_SEASON_SYNC_LOCK_NAMESPACE,
  entryEventTransfersRepository,
} from '../../src/repositories/entry-event-transfers';
import { entryInfoRepository } from '../../src/repositories/entry-infos';
import { eventLiveRepository } from '../../src/repositories/event-lives';
import { leagueEventResultsRepository } from '../../src/repositories/league-event-results';
import {
  republishEntryInfoCache,
  syncEntryInfo,
  type EntryInfoClient,
} from '../../src/services/entry-info.service';
import { syncEntryEventPicks, syncEntryEventResults } from '../../src/services/entries.service';
import {
  ensureTournamentCoreResults,
  enrichTournamentHistory,
  syncTournamentEntryDetails,
  type TournamentCoreSyncPlan,
  type TournamentEnrichmentPlan,
} from '../../src/services/tournament-backfill.service';
import { syncTournamentEventResultsForEntryIds } from '../../src/services/tournament-event-results.service';
import { mockFPLClient, resetMockFPLClient } from './helpers/mock-fpl';

const ENTRY_ID = 99_042_001;
const LATE_ENTRY_ID = 99_042_002;
const PICK_TEAM_ID = 99_042_101;
const PICK_PLAYER_ID = 99_042_101;
const TRANSFER_PLAYER_ID = 99_042_102;
const SOURCE_PLAYER_ID = 99_042_103;
const TEST_SEASON = '2526';
let previousActiveSeason: string | null = null;

async function expectBlockedByEntrySeasonLock<T>(
  operation: () => Promise<T>,
  entryId = ENTRY_ID,
  beforeRelease?: () => Promise<void>,
): Promise<T> {
  const sql = await getDbClient();
  let releaseLock: () => void = () => undefined;
  let markLockAcquired: () => void = () => undefined;
  const lockAcquired = new Promise<void>((resolve) => {
    markLockAcquired = resolve;
  });
  const lockRelease = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  const blocker = sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${ENTRY_SEASON_SYNC_LOCK_NAMESPACE}, ${entryId})`;
    markLockAcquired();
    await lockRelease;
  });
  await lockAcquired;

  let settled = false;
  const pending = operation().finally(() => {
    settled = true;
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);
  } finally {
    await beforeRelease?.();
    releaseLock();
    await blocker;
  }
  return pending;
}

function completePicks() {
  return Array.from({ length: 15 }, (_, index) => ({
    element: PICK_PLAYER_ID + index,
    position: index + 1,
    multiplier: index === 0 ? 2 : index < 11 ? 1 : 0,
    is_captain: index === 0,
    is_vice_captain: index === 1,
  }));
}

function completeEventLive() {
  return {
    elements: completePicks().map((pick) => ({
      id: pick.element,
      stats: {
        minutes: 0,
        goals_scored: 0,
        assists: 0,
        clean_sheets: 0,
        goals_conceded: 0,
        own_goals: 0,
        penalties_saved: 0,
        penalties_missed: 0,
        yellow_cards: 0,
        red_cards: 0,
        saves: 0,
        bonus: 0,
        bps: 0,
        defensive_contribution: 0,
        influence: '0.0',
        creativity: '0.0',
        threat: '0.0',
        ict_index: '0.0',
        starts: 0,
        expected_goals: '0.0',
        expected_assists: '0.0',
        expected_goal_involvements: '0.0',
        expected_goals_conceded: '0.0',
        total_points: 0,
        in_dreamteam: false,
      },
      explain: [],
    })),
  };
}

function completeRawEventLive(captainPoints = 0) {
  return {
    elements: completePicks().map((pick) => ({
      id: pick.element,
      stats: {
        minutes: 0,
        goals_scored: 0,
        assists: 0,
        clean_sheets: 0,
        goals_conceded: 0,
        own_goals: 0,
        penalties_saved: 0,
        penalties_missed: 0,
        yellow_cards: 0,
        red_cards: 0,
        saves: 0,
        bonus: 0,
        bps: 0,
        defensive_contribution: 0,
        influence: '0.0',
        creativity: '0.0',
        threat: '0.0',
        ict_index: '0.0',
        starts: 0,
        expected_goals: '0.0',
        expected_assists: '0.0',
        expected_goal_involvements: '0.0',
        expected_goals_conceded: '0.0',
        total_points: pick.element === PICK_PLAYER_ID ? captainPoints : 0,
        in_dreamteam: false,
      },
      explain: [],
    })),
  };
}

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
      current: Array.from({ length: 12 }, (_, index) => ({
        event: index + 1,
        points: 50,
        total_points: (index + 1) * 50,
        event_transfers: 0,
        event_transfers_cost: 0,
      })),
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
      snapshotSeason: string | null;
      transfers: number | null;
      transfersSeason: string | null;
    }[]
  >`
    SELECT
      entry_snapshot_synced_through_event_id AS snapshot,
      entry_snapshot_synced_season AS "snapshotSeason",
      entry_transfers_synced_through_event_id AS transfers,
      entry_transfers_synced_season AS "transfersSeason"
    FROM entry_infos
    WHERE id = ${ENTRY_ID}
  `;
  return rows[0];
}

beforeAll(async () => {
  const redis = await redisSingleton.getClient();
  previousActiveSeason = await redis.get('Season:active');
  await redis.set('Season:active', TEST_SEASON);
  resetActiveSeasonMemo();
  const sql = await getDbClient();
  await sql`
    INSERT INTO events (id, name)
    SELECT event_id, 'Checkpoint GW' || event_id
    FROM generate_series(1, 12) AS generated(event_id)
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO teams (id, code, name, short_name, pulse_id)
    VALUES (${PICK_TEAM_ID}, ${PICK_TEAM_ID}, 'Checkpoint Team', 'CHK', ${PICK_TEAM_ID})
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO players (id, code, type, team_id, web_name)
    SELECT
      player_id,
      player_id,
      1,
      ${PICK_TEAM_ID},
      'Checkpoint Player ' || player_id
    FROM generate_series(
      ${PICK_PLAYER_ID}::integer,
      ${PICK_PLAYER_ID + 14}::integer
    ) AS generated(player_id)
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO entry_infos (id, entry_name, player_name)
    VALUES (${ENTRY_ID}, 'Checkpoint XI', 'Checkpoint Manager')
    ON CONFLICT (id) DO UPDATE SET
      entry_snapshot_synced_through_event_id = NULL,
      entry_snapshot_synced_season = NULL,
      entry_transfers_synced_through_event_id = NULL,
      entry_transfers_synced_season = NULL
  `;
});

afterAll(async () => {
  const sql = await getDbClient();
  await sql`DELETE FROM entry_event_transfers WHERE entry_id = ${ENTRY_ID}`;
  await sql`DELETE FROM entry_event_cup_results WHERE entry_id = ${ENTRY_ID}`;
  await sql`DELETE FROM entry_event_picks WHERE entry_id IN (${ENTRY_ID}, ${LATE_ENTRY_ID})`;
  await sql`DELETE FROM entry_event_results WHERE entry_id = ${ENTRY_ID}`;
  await sql`DELETE FROM league_event_results WHERE entry_id = ${ENTRY_ID}`;
  await sql`DELETE FROM entry_league_infos WHERE entry_id = ${ENTRY_ID}`;
  await sql`DELETE FROM entry_history_infos WHERE entry_id = ${ENTRY_ID}`;
  await sql`DELETE FROM entry_infos WHERE id = ${ENTRY_ID}`;
  await sql`DELETE FROM entry_event_results WHERE entry_id = ${LATE_ENTRY_ID}`;
  await sql`DELETE FROM entry_infos WHERE id = ${LATE_ENTRY_ID}`;
  await sql`
    DELETE FROM event_lives
    WHERE element_id BETWEEN ${PICK_PLAYER_ID} AND ${PICK_PLAYER_ID + 14}
  `;
  await sql`
    DELETE FROM players
    WHERE id BETWEEN ${PICK_PLAYER_ID} AND ${PICK_PLAYER_ID + 14}
  `;
  await sql`DELETE FROM teams WHERE id = ${PICK_TEAM_ID}`;
  const redis = await redisSingleton.getClient();
  await redis.hdel(`EntryInfo:${TEST_SEASON}`, String(ENTRY_ID));
  if (previousActiveSeason !== null) {
    await redis.set('Season:active', previousActiveSeason);
  } else {
    await redis.del('Season:active');
  }
  resetActiveSeasonMemo();
});

describe('tournament initialization checkpoints', () => {
  test('persists core history only through the finalized target event', async () => {
    const sql = await getDbClient();
    await sql`DELETE FROM entry_event_results WHERE entry_id = ${ENTRY_ID}`;

    await syncEntryInfo(ENTRY_ID, client, 10);

    const stored = await sql<{ event_id: number }[]>`
      SELECT event_id
      FROM entry_event_results
      WHERE entry_id = ${ENTRY_ID}
      ORDER BY event_id
    `;
    expect(stored.map((row) => row.event_id)).toEqual(
      Array.from({ length: 10 }, (_, index) => index + 1),
    );
    expect((await checkpointRow())?.snapshot).toBe(10);
  });

  test('snapshot sync advances atomically and stale selection reuses it', async () => {
    await syncEntryInfo(ENTRY_ID, client, 12);

    expect((await checkpointRow())?.snapshot).toBe(12);
    expect((await checkpointRow())?.snapshotSeason).toBe(TEST_SEASON);
    expect(
      await entryInfoRepository.findIdsNeedingSnapshotSync([ENTRY_ID], 12, TEST_SEASON),
    ).toEqual([]);
    expect(
      await entryInfoRepository.findIdsNeedingSnapshotSync([ENTRY_ID], 11, TEST_SEASON),
    ).toEqual([]);
    expect(
      await entryInfoRepository.findIdsNeedingSnapshotSync([ENTRY_ID], 13, TEST_SEASON),
    ).toEqual([ENTRY_ID]);
  });

  test('numeric checkpoints from a previous season are stale and reset for the active season', async () => {
    const sql = await getDbClient();
    await sql`
      UPDATE entry_infos
      SET entry_snapshot_synced_through_event_id = 38,
          entry_snapshot_synced_season = '2425',
          entry_transfers_synced_through_event_id = 38,
          entry_transfers_synced_season = '2425'
      WHERE id = ${ENTRY_ID}
    `;
    await sql`
      INSERT INTO entry_event_picks (entry_id, event_id, chip, picks, transfers, transfers_cost)
      VALUES (
        ${ENTRY_ID},
        1,
        'n/a',
        '[{"element":999,"position":1,"multiplier":1}]'::jsonb,
        0,
        0
      )
      ON CONFLICT (entry_id, event_id) DO UPDATE SET picks = excluded.picks
    `;
    await sql`
      UPDATE entry_event_results
      SET event_picks = '[{"element":999,"position":1,"multiplier":1}]'::jsonb
      WHERE entry_id = ${ENTRY_ID} AND event_id = 1
    `;
    await sql`
      INSERT INTO entry_event_transfers (entry_id, event_id, transfer_time)
      VALUES (${ENTRY_ID}, 1, '2025-08-01T00:00:00Z')
      ON CONFLICT DO NOTHING
    `;

    expect(
      await entryInfoRepository.findIdsNeedingSnapshotSync([ENTRY_ID], 1, TEST_SEASON),
    ).toEqual([ENTRY_ID]);
    expect(
      await entryEventTransfersRepository.findEntryIdsNeedingSync([ENTRY_ID], 1, TEST_SEASON),
    ).toEqual([ENTRY_ID]);

    await syncEntryInfo(ENTRY_ID, client, 1, TEST_SEASON);
    await entryEventTransfersRepository.replaceForEvent(ENTRY_ID, 1, [], undefined, {
      syncMode: 'all',
      checkpointSeason: TEST_SEASON,
    });

    expect(await checkpointRow()).toMatchObject({
      snapshot: 1,
      snapshotSeason: TEST_SEASON,
      transfers: 1,
      transfersSeason: TEST_SEASON,
    });
    const resetRows = await sql<Array<{ picks: number; transfers: number; resultPicks: unknown }>>`
      SELECT
        (SELECT count(*)::int FROM entry_event_picks
         WHERE entry_id = ${ENTRY_ID}) AS picks,
        (SELECT count(*)::int FROM entry_event_transfers
         WHERE entry_id = ${ENTRY_ID}) AS transfers,
        result.event_picks AS "resultPicks"
      FROM entry_event_results result
      WHERE result.entry_id = ${ENTRY_ID} AND result.event_id = 1
    `;
    expect(resetRows[0]).toEqual({ picks: 0, transfers: 0, resultPicks: null });
  });

  test('legacy null season ownership clears rich entry and league rows before adoption', async () => {
    const sql = await getDbClient();
    await sql`
      UPDATE entry_infos
      SET entry_snapshot_synced_through_event_id = NULL,
          entry_snapshot_synced_season = NULL,
          entry_transfers_synced_through_event_id = NULL,
          entry_transfers_synced_season = NULL
      WHERE id = ${ENTRY_ID}
    `;
    await sql`
      INSERT INTO entry_event_picks (entry_id, event_id, chip, picks, transfers, transfers_cost)
      VALUES (${ENTRY_ID}, 12, 'n/a', '[]'::jsonb, 0, 0)
      ON CONFLICT (entry_id, event_id) DO UPDATE SET picks = excluded.picks
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
        overall_rank,
        event_picks
      )
      VALUES (${ENTRY_ID}, 12, 99, 0, 0, 99, 999, 1, '[]'::jsonb)
      ON CONFLICT (entry_id, event_id) DO UPDATE SET event_picks = excluded.event_picks
    `;
    await sql`
      INSERT INTO entry_event_cup_results (entry_id, event_id, result)
      VALUES (${ENTRY_ID}, 12, 'win')
      ON CONFLICT (entry_id, event_id) DO UPDATE SET result = excluded.result
    `;
    await sql`
      INSERT INTO league_event_results (
        league_id,
        league_type,
        entry_id,
        event_id,
        overall_rank,
        team_value
      )
      VALUES (99042, 'classic', ${ENTRY_ID}, 12, 1, 1500)
      ON CONFLICT (league_id, league_type, event_id, entry_id)
      DO UPDATE SET overall_rank = excluded.overall_rank, team_value = excluded.team_value
    `;

    await syncEntryInfo(ENTRY_ID, client, 1, TEST_SEASON);

    const rows = await sql<
      Array<{ picks: number; results: number; cup: number; league: number; coreRows: number }>
    >`
      SELECT
        (SELECT count(*)::int FROM entry_event_picks
         WHERE entry_id = ${ENTRY_ID} AND event_id = 12) AS picks,
        (SELECT count(*)::int FROM entry_event_results
         WHERE entry_id = ${ENTRY_ID} AND event_id = 12) AS results,
        (SELECT count(*)::int FROM entry_event_cup_results
         WHERE entry_id = ${ENTRY_ID} AND event_id = 12) AS cup,
        (SELECT count(*)::int FROM league_event_results
         WHERE entry_id = ${ENTRY_ID}) AS league,
        (SELECT count(*)::int FROM entry_event_results
         WHERE entry_id = ${ENTRY_ID} AND event_id = 1 AND event_picks IS NULL) AS "coreRows"
    `;
    expect(rows[0]).toEqual({ picks: 0, results: 0, cup: 0, league: 0, coreRows: 1 });
    expect(await checkpointRow()).toMatchObject({
      snapshot: 1,
      snapshotSeason: TEST_SEASON,
    });
  });

  test('snapshot rollover preserves transfers already proven for the active season', async () => {
    const sql = await getDbClient();
    await sql`DELETE FROM entry_event_transfers WHERE entry_id = ${ENTRY_ID}`;
    await sql`
      UPDATE entry_infos
      SET entry_snapshot_synced_through_event_id = 38,
          entry_snapshot_synced_season = '2425',
          entry_transfers_synced_through_event_id = 1,
          entry_transfers_synced_season = ${TEST_SEASON}
      WHERE id = ${ENTRY_ID}
    `;
    await sql`
      INSERT INTO entry_event_transfers (entry_id, event_id, transfer_time)
      VALUES (${ENTRY_ID}, 1, '2026-08-01T00:00:00Z')
    `;

    await syncEntryInfo(ENTRY_ID, client, 1, TEST_SEASON);

    const rows = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM entry_event_transfers
      WHERE entry_id = ${ENTRY_ID}
        AND transfer_time = '2026-08-01T00:00:00Z'
    `;
    expect(rows[0]?.count).toBe(1);
    expect(await checkpointRow()).toMatchObject({
      snapshot: 1,
      snapshotSeason: TEST_SEASON,
      transfers: 1,
      transfersSeason: TEST_SEASON,
    });
  });

  test('pick checkpoints require current-season entry ownership before reuse', async () => {
    const sql = await getDbClient();
    await sql`
      UPDATE entry_infos
      SET entry_snapshot_synced_through_event_id = 38,
          entry_snapshot_synced_season = '2425'
      WHERE id = ${ENTRY_ID}
    `;
    await sql`
      INSERT INTO entry_event_picks (entry_id, event_id, chip, picks, transfers, transfers_cost)
      VALUES (${ENTRY_ID}, 1, 'n/a', ${JSON.stringify(completePicks())}::jsonb, 0, 0)
      ON CONFLICT (entry_id, event_id) DO UPDATE SET picks = excluded.picks
    `;

    try {
      expect(
        await entryEventPicksRepository.findEntryIdsByEvent(1, [ENTRY_ID], TEST_SEASON),
      ).toEqual([]);

      await sql`
        UPDATE entry_infos
        SET entry_snapshot_synced_through_event_id = 1,
            entry_snapshot_synced_season = ${TEST_SEASON}
        WHERE id = ${ENTRY_ID}
      `;
      expect(
        await entryEventPicksRepository.findEntryIdsByEvent(1, [ENTRY_ID], TEST_SEASON),
      ).toEqual([ENTRY_ID]);
    } finally {
      await sql`DELETE FROM entry_event_picks WHERE entry_id = ${ENTRY_ID} AND event_id = 1`;
      await sql`
        UPDATE entry_infos
        SET entry_snapshot_synced_through_event_id = 12,
            entry_snapshot_synced_season = ${TEST_SEASON}
        WHERE id = ${ENTRY_ID}
      `;
    }
  });

  test('league result publication rejects entries no longer owned by the checkpoint season', async () => {
    const sql = await getDbClient();
    await sql`DELETE FROM league_event_results WHERE entry_id = ${ENTRY_ID}`;
    await sql`
      UPDATE entry_infos
      SET entry_snapshot_synced_through_event_id = 12,
          entry_snapshot_synced_season = '2627'
      WHERE id = ${ENTRY_ID}
    `;

    const persisted = await leagueEventResultsRepository.upsertBatch(
      [
        {
          leagueId: 99042,
          leagueType: 'classic',
          entryId: ENTRY_ID,
          eventId: 12,
          sourceCheckedAt: new Date('2026-08-05T00:00:00.000Z'),
        },
      ],
      TEST_SEASON,
    );
    const rows = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM league_event_results
      WHERE entry_id = ${ENTRY_ID}
    `;
    expect(persisted).toBe(0);
    expect(rows[0]?.count).toBe(0);

    await sql`
      UPDATE entry_infos
      SET entry_snapshot_synced_through_event_id = 12,
          entry_snapshot_synced_season = ${TEST_SEASON}
      WHERE id = ${ENTRY_ID}
    `;
  });

  test('league result publication serializes with entry season rollover', async () => {
    const sql = await getDbClient();
    await sql`DELETE FROM league_event_results WHERE entry_id = ${ENTRY_ID}`;
    await sql`
      UPDATE entry_infos
      SET entry_snapshot_synced_through_event_id = 12,
          entry_snapshot_synced_season = ${TEST_SEASON}
      WHERE id = ${ENTRY_ID}
    `;

    try {
      const persisted = await expectBlockedByEntrySeasonLock(() =>
        leagueEventResultsRepository.upsertBatch(
          [
            {
              leagueId: 99043,
              leagueType: 'classic',
              entryId: ENTRY_ID,
              eventId: 12,
              sourceCheckedAt: new Date('2026-08-05T00:00:00.000Z'),
            },
          ],
          TEST_SEASON,
        ),
      );
      expect(persisted).toBe(1);
    } finally {
      await sql`DELETE FROM league_event_results WHERE entry_id = ${ENTRY_ID}`;
    }
  });

  test('cup result publication accepts legacy ownership and skips a newer season', async () => {
    const sql = await getDbClient();
    await sql`DELETE FROM entry_event_cup_results WHERE entry_id = ${ENTRY_ID}`;
    await sql`
      UPDATE entry_infos
      SET entry_snapshot_synced_through_event_id = NULL,
          entry_snapshot_synced_season = NULL,
          entry_transfers_synced_through_event_id = NULL,
          entry_transfers_synced_season = NULL
      WHERE id = ${ENTRY_ID}
    `;
    const record = {
      entryId: ENTRY_ID,
      eventId: 12,
      result: 'win',
    } as const;

    try {
      expect(
        await expectBlockedByEntrySeasonLock(() =>
          entryEventCupResultsRepository.upsertBatch([record], TEST_SEASON),
        ),
      ).toBe(1);
      const adoptedRows = await sql<Array<{ sourceSeason: string | null }>>`
        SELECT source_season AS "sourceSeason"
        FROM entry_event_cup_results
        WHERE entry_id = ${ENTRY_ID} AND event_id = 12
      `;
      expect(adoptedRows[0]?.sourceSeason).toBe(TEST_SEASON);

      // Establishing the broader snapshot later must preserve the cup row that
      // already carries direct current-season ownership.
      await syncEntryInfo(ENTRY_ID, client, 1, TEST_SEASON);
      const preservedRows = await sql<Array<{ count: number }>>`
        SELECT count(*)::int AS count
        FROM entry_event_cup_results
        WHERE entry_id = ${ENTRY_ID}
          AND event_id = 12
          AND source_season = ${TEST_SEASON}
      `;
      expect(preservedRows[0]?.count).toBe(1);

      await sql`
        UPDATE entry_infos
        SET entry_snapshot_synced_through_event_id = 12,
            entry_snapshot_synced_season = '2627',
            entry_transfers_synced_through_event_id = 12,
            entry_transfers_synced_season = '2627'
        WHERE id = ${ENTRY_ID}
      `;
      expect(await entryEventCupResultsRepository.upsertBatch([record], TEST_SEASON)).toBe(0);
      const rows = await sql<Array<{ count: number }>>`
        SELECT count(*)::int AS count
        FROM entry_event_cup_results
        WHERE entry_id = ${ENTRY_ID}
      `;
      expect(rows[0]?.count).toBe(1);
    } finally {
      await sql`DELETE FROM entry_event_cup_results WHERE entry_id = ${ENTRY_ID}`;
      await sql`
        UPDATE entry_infos
        SET entry_snapshot_synced_through_event_id = 12,
            entry_snapshot_synced_season = ${TEST_SEASON},
            entry_transfers_synced_through_event_id = NULL,
            entry_transfers_synced_season = NULL
        WHERE id = ${ENTRY_ID}
      `;
    }
  });

  test('standalone picks reject a payload fetched across season rollover', async () => {
    const sql = await getDbClient();
    const redis = await redisSingleton.getClient();
    await sql`DELETE FROM entry_event_picks WHERE entry_id = ${ENTRY_ID} AND event_id = 12`;
    await redis.set('Season:active', TEST_SEASON);
    resetActiveSeasonMemo();
    mockFPLClient({
      async getEntryEventPicks() {
        await redis.set('Season:active', '2627');
        return {
          active_chip: null,
          automatic_subs: [],
          entry_history: {
            event: 12,
            points: 50,
            total_points: 600,
            rank: 100,
            overall_rank: 1_000,
            bank: 5,
            value: 1_000,
            event_transfers: 0,
            event_transfers_cost: 0,
            points_on_bench: 3,
          },
          picks: [],
        };
      },
    });

    try {
      await expect(syncEntryEventPicks(ENTRY_ID, 12)).rejects.toThrow(
        'Active season changed from 2526 to 2627',
      );
      const rows = await sql<Array<{ count: number }>>`
        SELECT count(*)::int AS count
        FROM entry_event_picks
        WHERE entry_id = ${ENTRY_ID} AND event_id = 12
      `;
      expect(rows[0]?.count).toBe(0);
    } finally {
      resetMockFPLClient();
      await redis.set('Season:active', TEST_SEASON);
      resetActiveSeasonMemo();
    }
  });

  test('standalone results reject a payload fetched across season rollover', async () => {
    const sql = await getDbClient();
    const redis = await redisSingleton.getClient();
    await sql`DELETE FROM entry_event_results WHERE entry_id = ${ENTRY_ID} AND event_id = 12`;
    await redis.set('Season:active', TEST_SEASON);
    resetActiveSeasonMemo();
    mockFPLClient({
      async getEntryEventPicks() {
        await redis.set('Season:active', '2627');
        return {
          active_chip: null,
          automatic_subs: [],
          entry_history: {
            event: 12,
            points: 50,
            total_points: 600,
            rank: 100,
            overall_rank: 1_000,
            bank: 5,
            value: 1_000,
            event_transfers: 0,
            event_transfers_cost: 0,
            points_on_bench: 3,
          },
          picks: [],
        };
      },
      async getEventLive() {
        return { elements: [] };
      },
    });

    try {
      await expect(syncEntryEventResults(ENTRY_ID, 12)).rejects.toThrow(
        'Active season changed from 2526 to 2627',
      );
      const rows = await sql<Array<{ count: number }>>`
        SELECT count(*)::int AS count
        FROM entry_event_results
        WHERE entry_id = ${ENTRY_ID} AND event_id = 12
      `;
      expect(rows[0]?.count).toBe(0);
    } finally {
      resetMockFPLClient();
      await redis.set('Season:active', TEST_SEASON);
      resetActiveSeasonMemo();
    }
  });

  test('a latest GW1 sync clears unproven transfer rows from the previous season', async () => {
    const sql = await getDbClient();
    await sql`DELETE FROM entry_event_transfers WHERE entry_id = ${ENTRY_ID}`;
    await sql`
      UPDATE entry_infos
      SET entry_snapshot_synced_through_event_id = 38,
          entry_snapshot_synced_season = '2425',
          entry_transfers_synced_through_event_id = 38,
          entry_transfers_synced_season = '2425'
      WHERE id = ${ENTRY_ID}
    `;
    await sql`
      INSERT INTO entry_event_transfers (entry_id, event_id, transfer_time)
      VALUES (${ENTRY_ID}, 2, '2025-08-08T00:00:00Z')
    `;

    await entryEventTransfersRepository.replaceForEvent(ENTRY_ID, 1, [], undefined, {
      syncMode: 'latest',
      checkpointSeason: TEST_SEASON,
    });
    await syncEntryInfo(ENTRY_ID, client, 1, TEST_SEASON);

    const rows = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count
      FROM entry_event_transfers
      WHERE entry_id = ${ENTRY_ID}
    `;
    expect(rows[0]?.count).toBe(0);
    expect(await checkpointRow()).toMatchObject({
      snapshot: 1,
      snapshotSeason: TEST_SEASON,
      transfers: 1,
      transfersSeason: TEST_SEASON,
    });
  });

  test('a midseason latest rollover retains new-season rows without claiming the missing range', async () => {
    const sql = await getDbClient();
    await sql`DELETE FROM entry_event_transfers WHERE entry_id = ${ENTRY_ID}`;
    await sql`
      UPDATE entry_infos
      SET entry_transfers_synced_through_event_id = 38,
          entry_transfers_synced_season = '2425'
      WHERE id = ${ENTRY_ID}
    `;
    await sql`
      INSERT INTO entry_event_transfers (entry_id, event_id, transfer_time)
      VALUES (${ENTRY_ID}, 2, '2025-08-08T00:00:00Z')
    `;

    await entryEventTransfersRepository.replaceForEvent(
      ENTRY_ID,
      11,
      [
        {
          event: 11,
          entry: ENTRY_ID,
          element_in: PICK_PLAYER_ID,
          element_out: PICK_PLAYER_ID,
          element_in_cost: 50,
          element_out_cost: 50,
          time: '2026-10-01T00:00:00Z',
        },
      ],
      undefined,
      { syncMode: 'latest', checkpointSeason: TEST_SEASON },
    );
    await entryEventTransfersRepository.replaceForEvent(
      ENTRY_ID,
      12,
      [
        {
          event: 12,
          entry: ENTRY_ID,
          element_in: PICK_PLAYER_ID,
          element_out: PICK_PLAYER_ID,
          element_in_cost: 51,
          element_out_cost: 50,
          time: '2026-10-08T00:00:00Z',
        },
      ],
      undefined,
      { syncMode: 'latest', checkpointSeason: TEST_SEASON },
    );

    const rows = await sql<Array<{ eventId: number }>>`
      SELECT event_id AS "eventId"
      FROM entry_event_transfers
      WHERE entry_id = ${ENTRY_ID}
      ORDER BY event_id
    `;
    expect(rows.map((row) => row.eventId)).toEqual([11, 12]);
    expect(await checkpointRow()).toMatchObject({
      transfers: 0,
      transfersSeason: TEST_SEASON,
    });
    expect(
      await entryEventTransfersRepository.findEntryIdsNeedingSync([ENTRY_ID], 12, TEST_SEASON),
    ).toEqual([ENTRY_ID]);
  });

  test('core history updates preserve the dedicated rich-result checkpoint', async () => {
    const sql = await getDbClient();
    const evidenceStartedAt = new Date('2026-08-04T09:30:00.000Z');
    await entryEventResultsRepository.upsertFromPicksAndLive(
      ENTRY_ID,
      1,
      {
        active_chip: null,
        automatic_subs: [],
        picks: completePicks(),
        entry_history: {
          event: 1,
          points: 50,
          total_points: 50,
          rank: 100,
          overall_rank: 100,
          bank: 0,
          value: 1000,
          event_transfers: 0,
          event_transfers_cost: 0,
          points_on_bench: 0,
        },
      },
      {
        elements: completePicks().map((pick) => ({
          id: pick.element,
          stats: { total_points: 0 },
        })),
      },
      evidenceStartedAt,
    );
    const before = await sql<{ richSyncedAt: string | null }[]>`
      SELECT rich_synced_at AS "richSyncedAt"
      FROM entry_event_results
      WHERE entry_id = ${ENTRY_ID} AND event_id = 1
    `;
    expect(before[0]?.richSyncedAt).not.toBeNull();
    const beforeMarker = before[0]?.richSyncedAt;
    if (!beforeMarker) throw new Error('Expected rich result checkpoint');
    expect(new Date(beforeMarker)).toEqual(evidenceStartedAt);

    await syncEntryInfo(ENTRY_ID, client, 12);

    const after = await sql<{ richSyncedAt: string | null }[]>`
      SELECT rich_synced_at AS "richSyncedAt"
      FROM entry_event_results
      WHERE entry_id = ${ENTRY_ID} AND event_id = 1
    `;
    expect(after[0]?.richSyncedAt).toBe(beforeMarker);
    expect(await entryEventResultsRepository.findEntryIdsNeedingRichSync([ENTRY_ID], 1)).toEqual(
      [],
    );
    expect(await entryEventResultsRepository.findEntryIdsNeedingRichSync([ENTRY_ID], 2)).toEqual([
      ENTRY_ID,
    ]);
    expect(
      await entryEventResultsRepository.findEntryIdsNeedingRichSync(
        [ENTRY_ID],
        1,
        new Date(new Date(beforeMarker).getTime() + 1),
      ),
    ).toEqual([ENTRY_ID]);
  });

  test('late older rich evidence cannot overwrite a newer result', async () => {
    const newerEvidenceAt = new Date('2026-08-04T12:00:00.000Z');
    const olderEvidenceAt = new Date('2026-08-04T11:00:00.000Z');
    const live = completeEventLive();
    const picks = {
      active_chip: null,
      automatic_subs: [],
      picks: completePicks(),
      entry_history: {
        event: 1,
        points: 88,
        total_points: 588,
        rank: 8,
        overall_rank: 88,
        bank: 0,
        value: 1000,
        event_transfers: 0,
        event_transfers_cost: 0,
        points_on_bench: 0,
      },
    };
    await entryEventResultsRepository.upsertFromPicksAndLive(
      ENTRY_ID,
      1,
      picks,
      live,
      newerEvidenceAt,
    );

    await entryEventResultsRepository.upsertFromPicksAndLive(
      ENTRY_ID,
      1,
      {
        ...picks,
        entry_history: { ...picks.entry_history, points: 11, total_points: 511 },
      },
      live,
      olderEvidenceAt,
    );

    const sql = await getDbClient();
    const rows = await sql<{ eventPoints: number; richSyncedAt: string | null }[]>`
      SELECT event_points AS "eventPoints", rich_synced_at AS "richSyncedAt"
      FROM entry_event_results
      WHERE entry_id = ${ENTRY_ID} AND event_id = 1
    `;
    expect(rows[0]?.eventPoints).toBe(88);
    expect(rows[0]?.richSyncedAt).not.toBeNull();
    expect(new Date(rows[0]?.richSyncedAt ?? '')).toEqual(newerEvidenceAt);
  });

  test('late older picks evidence cannot overwrite a newer squad', async () => {
    const newerEvidenceAt = new Date('2026-08-04T12:30:00.000Z');
    const olderEvidenceAt = new Date('2026-08-04T11:30:00.000Z');
    const newerPicks = completePicks();
    const olderPicks = newerPicks.map((pick, index) =>
      index === 0 ? { ...pick, element: pick.element + 1000 } : pick,
    );
    const base = {
      active_chip: null,
      automatic_subs: [],
      entry_history: {
        event: 1,
        points: 88,
        total_points: 588,
        rank: 8,
        overall_rank: 88,
        bank: 0,
        value: 1000,
        event_transfers: 0,
        event_transfers_cost: 0,
        points_on_bench: 0,
      },
    };
    await entryEventPicksRepository.upsertFromPicks(
      ENTRY_ID,
      1,
      { ...base, picks: newerPicks },
      newerEvidenceAt,
    );
    await entryEventPicksRepository.upsertFromPicks(
      ENTRY_ID,
      1,
      { ...base, picks: olderPicks },
      olderEvidenceAt,
    );

    const sql = await getDbClient();
    const rows = await sql<{ picks: unknown; updatedAt: string | null }[]>`
      SELECT picks, updated_at AS "updatedAt"
      FROM entry_event_picks
      WHERE entry_id = ${ENTRY_ID} AND event_id = 1
    `;
    expect(rows[0]?.picks).toEqual(newerPicks);
    expect(new Date(rows[0]?.updatedAt ?? '')).toEqual(newerEvidenceAt);
  });

  test('incomplete picks never advance the rich-result checkpoint', async () => {
    const sql = await getDbClient();
    const before = await sql<{ richSyncedAt: string | null }[]>`
      SELECT rich_synced_at AS "richSyncedAt"
      FROM entry_event_results
      WHERE entry_id = ${ENTRY_ID} AND event_id = 1
    `;
    const beforeMarker = before[0]?.richSyncedAt ?? null;

    await expect(
      entryEventResultsRepository.upsertFromPicksAndLive(
        ENTRY_ID,
        1,
        {
          active_chip: null,
          automatic_subs: [],
          picks: [],
          entry_history: {
            event: 1,
            points: 60,
            total_points: 60,
            rank: 90,
            overall_rank: 90,
            bank: 0,
            value: 1000,
            event_transfers: 0,
            event_transfers_cost: 0,
            points_on_bench: 0,
          },
        },
        { elements: [] },
        new Date('2026-08-04T10:00:00.000Z'),
      ),
    ).rejects.toThrow('Refusing incomplete rich picks');

    const after = await sql<{ richSyncedAt: string | null }[]>`
      SELECT rich_synced_at AS "richSyncedAt"
      FROM entry_event_results
      WHERE entry_id = ${ENTRY_ID} AND event_id = 1
    `;
    expect(after[0]?.richSyncedAt ?? null).toBe(beforeMarker);
  });

  test('event-mismatched picks never advance standalone or rich checkpoints', async () => {
    const sql = await getDbClient();
    await sql`DELETE FROM entry_event_picks WHERE entry_id = ${ENTRY_ID} AND event_id = 1`;
    const picks = {
      active_chip: null,
      automatic_subs: [],
      picks: completePicks(),
      entry_history: {
        event: 2,
        points: 60,
        total_points: 60,
        rank: 90,
        overall_rank: 90,
        bank: 0,
        value: 1000,
        event_transfers: 0,
        event_transfers_cost: 0,
        points_on_bench: 0,
      },
    };
    const before = await sql<{ richSyncedAt: string | null }[]>`
      SELECT rich_synced_at AS "richSyncedAt"
      FROM entry_event_results
      WHERE entry_id = ${ENTRY_ID} AND event_id = 1
    `;

    await expect(
      entryEventPicksRepository.upsertFromPicks(ENTRY_ID, 1, picks, new Date()),
    ).rejects.toThrow();
    await expect(
      entryEventResultsRepository.upsertFromPicksAndLive(
        ENTRY_ID,
        1,
        picks,
        completeEventLive(),
        new Date(),
      ),
    ).rejects.toThrow('Refusing rich picks for an unexpected event');

    const rows = await sql<{ picks: number; richSyncedAt: string | null }[]>`
      SELECT
        (SELECT count(*)::int FROM entry_event_picks
         WHERE entry_id = ${ENTRY_ID} AND event_id = 1) AS picks,
        result.rich_synced_at AS "richSyncedAt"
      FROM entry_event_results result
      WHERE result.entry_id = ${ENTRY_ID} AND result.event_id = 1
    `;
    expect(rows[0]?.picks).toBe(0);
    expect(rows[0]?.richSyncedAt ?? null).toBe(before[0]?.richSyncedAt ?? null);
  });

  test('partial event-live coverage never advances the rich-result checkpoint', async () => {
    const sql = await getDbClient();
    const before = await sql<{ richSyncedAt: string | null }[]>`
      SELECT rich_synced_at AS "richSyncedAt"
      FROM entry_event_results
      WHERE entry_id = ${ENTRY_ID} AND event_id = 1
    `;
    const beforeMarker = before[0]?.richSyncedAt ?? null;
    const picks = completePicks();

    await expect(
      entryEventResultsRepository.upsertFromPicksAndLive(
        ENTRY_ID,
        1,
        {
          active_chip: null,
          automatic_subs: [],
          picks,
          entry_history: {
            event: 1,
            points: 60,
            total_points: 60,
            rank: 90,
            overall_rank: 90,
            bank: 0,
            value: 1000,
            event_transfers: 0,
            event_transfers_cost: 0,
            points_on_bench: 0,
          },
        },
        {
          elements: picks.slice(0, 14).map((pick) => ({
            id: pick.element,
            stats: { total_points: 0 },
          })),
        },
        new Date('2026-08-04T10:05:00.000Z'),
      ),
    ).rejects.toThrow('Refusing incomplete event-live coverage');

    const after = await sql<{ richSyncedAt: string | null }[]>`
      SELECT rich_synced_at AS "richSyncedAt"
      FROM entry_event_results
      WHERE entry_id = ${ENTRY_ID} AND event_id = 1
    `;
    expect(after[0]?.richSyncedAt ?? null).toBe(beforeMarker);
  });

  test('invalid automatic substitutions never advance the rich-result checkpoint', async () => {
    const sql = await getDbClient();
    const before = await sql<{ richSyncedAt: string | null }[]>`
      SELECT rich_synced_at AS "richSyncedAt"
      FROM entry_event_results
      WHERE entry_id = ${ENTRY_ID} AND event_id = 1
    `;
    const beforeMarker = before[0]?.richSyncedAt ?? null;
    const picks = completePicks();

    await expect(
      entryEventResultsRepository.upsertFromPicksAndLive(
        ENTRY_ID,
        1,
        {
          active_chip: null,
          automatic_subs: [
            {
              entry: ENTRY_ID,
              element_in: 999_999,
              element_out: picks[0].element,
              event: 1,
            },
          ],
          picks,
          entry_history: {
            event: 1,
            points: 60,
            total_points: 60,
            rank: 90,
            overall_rank: 90,
            bank: 0,
            value: 1000,
            event_transfers: 0,
            event_transfers_cost: 0,
            points_on_bench: 0,
          },
        },
        {
          elements: picks.map((pick) => ({
            id: pick.element,
            stats: { total_points: 0 },
          })),
        },
        new Date('2026-08-04T10:10:00.000Z'),
      ),
    ).rejects.toThrow('Refusing invalid automatic substitutions');

    const after = await sql<{ richSyncedAt: string | null }[]>`
      SELECT rich_synced_at AS "richSyncedAt"
      FROM entry_event_results
      WHERE entry_id = ${ENTRY_ID} AND event_id = 1
    `;
    expect(after[0]?.richSyncedAt ?? null).toBe(beforeMarker);
  });

  test('republishes a checkpointed entry from canonical storage without upstream calls', async () => {
    await syncEntryInfo(ENTRY_ID, client, 12);
    const redis = await redisSingleton.getClient();
    await redis.hdel(`EntryInfo:${TEST_SEASON}`, String(ENTRY_ID));
    expect(await entryInfosCache.getEntry(ENTRY_ID)).toBeNull();

    await republishEntryInfoCache(ENTRY_ID);

    expect(await entryInfosCache.getEntry(ENTRY_ID)).toMatchObject({
      id: ENTRY_ID,
      entryName: 'Checkpoint XI',
    });
  });

  test('preseason zero is complete only for a preseason target', async () => {
    const sql = await getDbClient();
    await sql`
      UPDATE entry_infos
      SET entry_snapshot_synced_through_event_id = 0,
          entry_snapshot_synced_season = ${TEST_SEASON},
          entry_transfers_synced_through_event_id = 0,
          entry_transfers_synced_season = ${TEST_SEASON}
      WHERE id = ${ENTRY_ID}
    `;

    expect(
      await entryInfoRepository.findIdsNeedingSnapshotSync([ENTRY_ID], 0, TEST_SEASON),
    ).toEqual([]);
    expect(
      await entryInfoRepository.findIdsNeedingSnapshotSync([ENTRY_ID], 1, TEST_SEASON),
    ).toEqual([ENTRY_ID]);
    expect(
      await entryEventTransfersRepository.findEntryIdsNeedingSync([ENTRY_ID], 0, TEST_SEASON),
    ).toEqual([]);
    expect(
      await entryEventTransfersRepository.findEntryIdsNeedingSync([ENTRY_ID], 1, TEST_SEASON),
    ).toEqual([ENTRY_ID]);
  });

  test('preseason enrichment establishes an empty transfer checkpoint without picks calls', async () => {
    const sql = await getDbClient();
    await sql`
      UPDATE entry_infos
      SET entry_transfers_synced_through_event_id = NULL,
          entry_transfers_synced_season = NULL
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
      SET entry_snapshot_synced_through_event_id = NULL,
          entry_snapshot_synced_season = NULL
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

  test('season rollover before commit rejects the stale entry snapshot', async () => {
    const sql = await getDbClient();
    const redis = await redisSingleton.getClient();
    await sql`
      UPDATE entry_infos
      SET entry_snapshot_synced_through_event_id = NULL,
          entry_snapshot_synced_season = NULL
      WHERE id = ${ENTRY_ID}
    `;

    try {
      await redis.set('Season:active', '2627');
      resetActiveSeasonMemo();
      await expect(syncEntryInfo(ENTRY_ID, client, 12, TEST_SEASON)).rejects.toThrow(
        'Active season changed from 2526 to 2627',
      );
      expect((await checkpointRow())?.snapshot).toBeNull();
      expect((await checkpointRow())?.snapshotSeason).toBeNull();
    } finally {
      await redis.set('Season:active', TEST_SEASON);
      resetActiveSeasonMemo();
    }
  });

  test('reused tournament snapshots abort when the planned season changes', async () => {
    const sql = await getDbClient();
    const redis = await redisSingleton.getClient();
    await sql`
      UPDATE entry_infos
      SET entry_snapshot_synced_through_event_id = 12,
          entry_snapshot_synced_season = ${TEST_SEASON}
      WHERE id = ${ENTRY_ID}
    `;

    try {
      await expect(
        syncTournamentEntryDetails([ENTRY_ID], {
          targetEventId: 12,
          season: TEST_SEASON,
          onPlan: async (plan) => {
            expect(plan.requestedEntries).toBe(0);
            await redis.set('Season:active', '2627');
            resetActiveSeasonMemo();
          },
        }),
      ).rejects.toThrow('Active season changed from 2526 to 2627 during tournament entry sync');
    } finally {
      await redis.set('Season:active', TEST_SEASON);
      resetActiveSeasonMemo();
    }
  });

  test('post-event live reads require finalized current-season source evidence', async () => {
    const sql = await getDbClient();
    const originalEvents = await sql<
      Array<{
        id: number;
        deadlineTime: Date | null;
        finished: boolean;
        dataChecked: boolean;
        updatedAt: Date;
        liveSnapshotCheckedAt: Date | null;
        liveSnapshotFinalizedAt: Date | null;
      }>
    >`
      SELECT
        id,
        deadline_time AS "deadlineTime",
        finished,
        data_checked AS "dataChecked",
        updated_at AS "updatedAt",
        live_snapshot_checked_at AS "liveSnapshotCheckedAt",
        live_snapshot_finalized_at AS "liveSnapshotFinalizedAt"
      FROM events
      WHERE id IN (1, 12)
      ORDER BY id
    `;

    try {
      await sql`
        UPDATE events
        SET deadline_time = CASE id
              WHEN 1 THEN '2025-08-15T18:30:00Z'::timestamptz
              ELSE '2025-11-01T18:30:00Z'::timestamptz
            END,
            finished = true,
            data_checked = true,
            updated_at = '2025-11-01T00:00:00Z'::timestamptz,
            live_snapshot_checked_at = '2025-11-02T00:00:00Z'::timestamptz,
            live_snapshot_finalized_at = NULL
        WHERE id IN (1, 12)
      `;
      await sql`DELETE FROM event_lives WHERE element_id = ${SOURCE_PLAYER_ID}`;
      await sql`
        INSERT INTO event_lives (event_id, element_id, total_points, updated_at)
        VALUES (12, ${SOURCE_PLAYER_ID}, 9, '2024-11-02T00:00:00Z'::timestamptz)
      `;

      const stale = await eventLiveRepository.findFinalizedByEventIdForSeason(12, TEST_SEASON);
      expect(stale.some((row) => row.elementId === SOURCE_PLAYER_ID)).toBe(false);

      await sql`
        UPDATE event_lives
        SET updated_at = '2025-11-02T00:00:00Z'::timestamptz
        WHERE element_id = ${SOURCE_PLAYER_ID}
      `;
      const staleConsolidation = await eventLiveRepository.findFinalizedByEventIdForSeason(
        12,
        TEST_SEASON,
      );
      expect(staleConsolidation.some((row) => row.elementId === SOURCE_PLAYER_ID)).toBe(false);

      await sql`
        UPDATE events
        SET live_snapshot_finalized_at = '2025-11-03T00:00:00Z'::timestamptz
        WHERE id IN (1, 12)
      `;
      const finalizedBeforeFreshRows = await eventLiveRepository.findFinalizedByEventIdForSeason(
        12,
        TEST_SEASON,
      );
      expect(finalizedBeforeFreshRows.some((row) => row.elementId === SOURCE_PLAYER_ID)).toBe(
        false,
      );

      await sql`
        UPDATE events
        SET live_snapshot_finalized_at = '2025-11-01T00:00:00Z'::timestamptz
        WHERE id IN (1, 12)
      `;
      const current = await eventLiveRepository.findFinalizedByEventIdForSeason(12, TEST_SEASON);
      expect(current.find((row) => row.elementId === SOURCE_PLAYER_ID)?.totalPoints).toBe(9);
      const wrongSeason = await eventLiveRepository.findFinalizedByEventIdForSeason(12, '2627');
      expect(wrongSeason.some((row) => row.elementId === SOURCE_PLAYER_ID)).toBe(false);
    } finally {
      await sql`DELETE FROM event_lives WHERE element_id = ${SOURCE_PLAYER_ID}`;
      for (const event of originalEvents) {
        await sql`
          UPDATE events
          SET deadline_time = ${event.deadlineTime},
              finished = ${event.finished},
              data_checked = ${event.dataChecked},
              updated_at = ${event.updatedAt},
              live_snapshot_checked_at = ${event.liveSnapshotCheckedAt},
              live_snapshot_finalized_at = ${event.liveSnapshotFinalizedAt}
          WHERE id = ${event.id}
        `;
      }
    }
  });

  test('season rollover before commit rejects stale transfer history atomically', async () => {
    const sql = await getDbClient();
    const redis = await redisSingleton.getClient();
    await sql`DELETE FROM entry_event_transfers WHERE entry_id = ${ENTRY_ID}`;
    await sql`
      UPDATE entry_infos
      SET entry_transfers_synced_through_event_id = NULL,
          entry_transfers_synced_season = NULL
      WHERE id = ${ENTRY_ID}
    `;
    await sql`
      INSERT INTO entry_event_transfers (entry_id, event_id, transfer_time)
      VALUES (${ENTRY_ID}, 1, '2026-08-01T00:00:00Z')
    `;

    try {
      await redis.set('Season:active', '2627');
      resetActiveSeasonMemo();
      let rejected: unknown;
      try {
        await entryEventTransfersRepository.replaceForEvent(ENTRY_ID, 12, [], undefined, {
          syncMode: 'all',
          checkpointSeason: TEST_SEASON,
        });
      } catch (error) {
        rejected = error;
      }

      expect((rejected as { cause?: Error })?.cause?.message).toContain(
        'Active season changed from 2526 to 2627 during entry event sync',
      );
      const rows = await sql<Array<{ count: number }>>`
        SELECT count(*)::int AS count
        FROM entry_event_transfers
        WHERE entry_id = ${ENTRY_ID}
      `;
      expect(rows[0]?.count).toBe(1);
      expect((await checkpointRow())?.transfers).toBeNull();
      expect((await checkpointRow())?.transfersSeason).toBeNull();
    } finally {
      await redis.set('Season:active', TEST_SEASON);
      resetActiveSeasonMemo();
    }
  });

  test('post-event transfer points update under the entry and season fences', async () => {
    const sql = await getDbClient();
    const redis = await redisSingleton.getClient();
    await sql`DELETE FROM entry_event_transfers WHERE entry_id = ${ENTRY_ID} AND event_id = 12`;
    await sql`
      UPDATE entry_infos
      SET entry_snapshot_synced_through_event_id = 12,
          entry_snapshot_synced_season = ${TEST_SEASON}
      WHERE id = ${ENTRY_ID}
    `;
    const inserted = await sql<Array<{ id: number }>>`
      INSERT INTO entry_event_transfers (
        entry_id,
        event_id,
        element_in_id,
        element_out_id,
        transfer_time,
        element_in_points,
        element_out_points
      )
      VALUES (
        ${ENTRY_ID},
        12,
        ${PICK_PLAYER_ID},
        ${TRANSFER_PLAYER_ID},
        '2026-01-01T00:00:00Z',
        0,
        0
      )
      RETURNING id
    `;
    const update = {
      id: inserted[0]!.id,
      entryId: ENTRY_ID,
      elementInPoints: 8,
      elementOutPoints: 2,
      elementInPlayed: true,
    };

    try {
      expect(await entryEventTransfersRepository.updateBatchById([update], TEST_SEASON)).toBe(1);
      const current = await sql<
        Array<{
          elementInPoints: number | null;
          elementOutPoints: number | null;
          elementInPlayed: boolean | null;
        }>
      >`
        SELECT
          element_in_points AS "elementInPoints",
          element_out_points AS "elementOutPoints",
          element_in_played AS "elementInPlayed"
        FROM entry_event_transfers
        WHERE id = ${update.id}
      `;
      expect(current[0]).toEqual({
        elementInPoints: 8,
        elementOutPoints: 2,
        elementInPlayed: true,
      });

      await sql`DELETE FROM entry_event_transfers WHERE id = ${update.id}`;
      let missingRowError: unknown;
      try {
        await entryEventTransfersRepository.updateBatchById([update], TEST_SEASON);
      } catch (error) {
        missingRowError = error;
      }
      expect((missingRowError as { cause?: Error })?.cause?.message).toContain(
        'Entry event transfer rows changed while waiting for the entry season write fence',
      );
      await sql`
        INSERT INTO entry_event_transfers (
          id,
          entry_id,
          event_id,
          element_in_id,
          element_out_id,
          transfer_time,
          element_in_points,
          element_out_points
        )
        VALUES (
          ${update.id},
          ${ENTRY_ID},
          12,
          ${PICK_PLAYER_ID},
          ${TRANSFER_PLAYER_ID},
          '2026-01-01T00:00:00Z',
          8,
          2
        )
      `;

      await redis.set('Season:active', '2627');
      resetActiveSeasonMemo();
      let rejected: unknown;
      try {
        await entryEventTransfersRepository.updateBatchById(
          [{ ...update, elementInPoints: 99 }],
          TEST_SEASON,
        );
      } catch (error) {
        rejected = error;
      }
      expect((rejected as { cause?: Error })?.cause?.message).toContain(
        'Active season changed from 2526 to 2627 during entry event sync',
      );
      const preserved = await sql<Array<{ elementInPoints: number | null }>>`
        SELECT element_in_points AS "elementInPoints"
        FROM entry_event_transfers
        WHERE id = ${update.id}
      `;
      expect(preserved[0]?.elementInPoints).toBe(8);
    } finally {
      await redis.set('Season:active', TEST_SEASON);
      resetActiveSeasonMemo();
      await sql`DELETE FROM entry_event_transfers WHERE id = ${update.id}`;
    }
  });

  test('pick aggregation reads canonical picks before result enrichment exists', async () => {
    const sql = await getDbClient();
    await sql`DELETE FROM entry_event_results WHERE entry_id = ${ENTRY_ID} AND event_id = 11`;
    await sql`
      INSERT INTO entry_event_picks (entry_id, event_id, chip, picks, transfers, transfers_cost)
      VALUES (
        ${ENTRY_ID},
        11,
        'n/a',
        ${JSON.stringify([
          {
            element: PICK_PLAYER_ID,
            position: 1,
            multiplier: 1,
            is_captain: false,
            is_vice_captain: true,
          },
        ])}::jsonb,
        0,
        0
      )
      ON CONFLICT (entry_id, event_id) DO UPDATE SET picks = excluded.picks
    `;

    try {
      const rows = await sql<
        Array<{ element_id: number; pick_count: string; vice_captain_count: string }>
      >`
        SELECT element_id, pick_count, vice_captain_count
        FROM get_pick_aggregation(11, ARRAY[${ENTRY_ID}]::integer[])
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.element_id).toBe(PICK_PLAYER_ID);
      expect(Number(rows[0]?.pick_count)).toBe(1);
      expect(Number(rows[0]?.vice_captain_count)).toBe(1);
    } finally {
      await sql`DELETE FROM entry_event_picks WHERE entry_id = ${ENTRY_ID} AND event_id = 11`;
    }
  });

  test('transfer aggregation returns zero for a missing direction', async () => {
    const sql = await getDbClient();
    await sql`DELETE FROM entry_event_transfers WHERE entry_id = ${ENTRY_ID} AND event_id = 11`;
    await sql`
      INSERT INTO entry_event_transfers (
        entry_id,
        event_id,
        element_in_id,
        element_out_id,
        transfer_time
      )
      VALUES (
        ${ENTRY_ID},
        11,
        ${PICK_PLAYER_ID},
        ${TRANSFER_PLAYER_ID},
        '2026-10-01T00:00:00Z'
      )
    `;

    try {
      const rows = await sql<
        Array<{
          elementId: number;
          transferInCount: string;
          transferOutCount: string;
        }>
      >`
        SELECT
          element_id AS "elementId",
          transfer_in_count AS "transferInCount",
          transfer_out_count AS "transferOutCount"
        FROM get_transfer_aggregation(11, ARRAY[${ENTRY_ID}]::integer[])
        ORDER BY element_id
      `;
      expect(Array.from(rows)).toEqual([
        {
          elementId: PICK_PLAYER_ID,
          transferInCount: '1',
          transferOutCount: '0',
        },
        {
          elementId: TRANSFER_PLAYER_ID,
          transferInCount: '0',
          transferOutCount: '1',
        },
      ]);
    } finally {
      await sql`DELETE FROM entry_event_transfers WHERE entry_id = ${ENTRY_ID} AND event_id = 11`;
    }
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
      SET entry_snapshot_synced_through_event_id = NULL,
          entry_snapshot_synced_season = NULL
      WHERE id = ${ENTRY_ID}
    `;
    try {
      await syncEntryInfo(ENTRY_ID, client);
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

  test('seeds pre-entry baselines under the entry season write fence', async () => {
    try {
      await expectBlockedByEntrySeasonLock(
        () =>
          ensureTournamentCoreResults([LATE_ENTRY_ID], {
            startEventId: 1,
            endEventId: 12,
          }),
        LATE_ENTRY_ID,
        async () => {
          const redis = await redisSingleton.getClient();
          await redis.set('Season:active', '2627');
          resetActiveSeasonMemo();
        },
      );
      throw new Error('Expected baseline seeding to reject the stale season');
    } catch (error) {
      expect(String((error as { cause?: Error })?.cause?.message ?? error)).toContain(
        'Active season changed from 2526 to 2627 during entry event sync',
      );
    } finally {
      const redis = await redisSingleton.getClient();
      await redis.set('Season:active', TEST_SEASON);
      resetActiveSeasonMemo();
    }
  });

  test('requires canonical picks before treating knockout core rows as complete', async () => {
    const sql = await getDbClient();
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
      VALUES (${ENTRY_ID}, 12, 55, 0, 0, 55, 600, 500)
      ON CONFLICT (entry_id, event_id) DO UPDATE SET
        event_points = 55,
        event_picks = NULL,
        event_chip = NULL
    `;
    await sql`
      INSERT INTO entry_event_picks (
        entry_id,
        event_id,
        chip,
        picks,
        transfers,
        transfers_cost
      )
      VALUES (
        ${ENTRY_ID},
        12,
        'n/a',
        '[{"element":999,"position":1,"multiplier":1}]'::jsonb,
        0,
        0
      )
      ON CONFLICT (entry_id, event_id) DO UPDATE SET
        picks = excluded.picks,
        updated_at = now()
    `;
    let picksCalls = 0;
    mockFPLClient({
      getEventLive: async () => completeEventLive(),
      getEntryEventPicks: async () => {
        picksCalls += 1;
        return {
          active_chip: null,
          automatic_subs: [],
          entry_history: {
            event: 12,
            points: 55,
            total_points: 600,
            rank: 1,
            overall_rank: 500,
            bank: 10,
            value: 1010,
            event_transfers: 0,
            event_transfers_cost: 0,
            points_on_bench: 0,
          },
          picks: completePicks(),
        };
      },
    });

    try {
      const plans: TournamentCoreSyncPlan[] = [];
      await ensureTournamentCoreResults(
        [ENTRY_ID],
        { startEventId: 12, endEventId: 12 },
        undefined,
        (plan) => {
          plans.push(plan);
        },
        { requirePicksForEvents: [12] },
      );

      expect(picksCalls).toBe(1);
      expect(plans).toEqual([{ totalPairs: 1, missingPairs: 1, reusedPairs: 0 }]);
      const rows = await sql<{ resultPicks: unknown; pickRows: number }[]>`
        SELECT
          result.event_picks AS "resultPicks",
          (
            SELECT count(*)::int
            FROM entry_event_picks picks
            WHERE picks.entry_id = ${ENTRY_ID} AND picks.event_id = 12
          ) AS "pickRows"
        FROM entry_event_results result
        WHERE result.entry_id = ${ENTRY_ID} AND result.event_id = 12
      `;
      expect(rows[0]?.pickRows).toBe(1);
      expect(rows[0]?.resultPicks).toEqual(completePicks());
    } finally {
      resetMockFPLClient();
    }
  });

  test('empty full transfer history is a completed canonical sync', async () => {
    const sql = await getDbClient();
    await sql`
      UPDATE entry_infos
      SET entry_transfers_synced_through_event_id = NULL,
          entry_transfers_synced_season = NULL
      WHERE id = ${ENTRY_ID}
    `;
    await entryEventTransfersRepository.replaceForEvent(ENTRY_ID, 10, [], undefined, {
      syncMode: 'all',
      checkpointSeason: TEST_SEASON,
    });

    expect((await checkpointRow())?.transfers).toBe(10);
    expect(
      await entryEventTransfersRepository.findEntryIdsNeedingSync([ENTRY_ID], 10, TEST_SEASON),
    ).toEqual([]);
    expect(
      await entryEventTransfersRepository.findEntryIdsNeedingSync([ENTRY_ID], 11, TEST_SEASON),
    ).toEqual([ENTRY_ID]);
  });

  test('tournament backfill checkpoints the full transfer payload it fetched', async () => {
    const sql = await getDbClient();
    await sql`
      UPDATE entry_infos
      SET entry_transfers_synced_through_event_id = NULL,
          entry_transfers_synced_season = NULL
      WHERE id = ${ENTRY_ID}
    `;
    mockFPLClient({
      getEntryEventPicks: async () => ({
        active_chip: null,
        automatic_subs: [],
        entry_history: {
          event: 12,
          points: 55,
          total_points: 600,
          rank: 1,
          overall_rank: 500,
          bank: 10,
          value: 1010,
          event_transfers: 0,
          event_transfers_cost: 0,
          points_on_bench: 0,
        },
        picks: completePicks(),
      }),
      getEntryTransfers: async () => [],
    });
    try {
      await syncTournamentEventResultsForEntryIds([ENTRY_ID], 12, {
        live: completeEventLive(),
      });
    } finally {
      resetMockFPLClient();
    }

    expect((await checkpointRow())?.transfers).toBe(12);
    expect(
      await entryEventTransfersRepository.findEntryIdsNeedingSync([ENTRY_ID], 12, TEST_SEASON),
    ).toEqual([]);
  });

  test('per-event sync advances only a contiguous checkpoint', async () => {
    const sql = await getDbClient();
    await sql`
      UPDATE entry_infos
      SET entry_transfers_synced_through_event_id = 9,
          entry_transfers_synced_season = ${TEST_SEASON}
      WHERE id = ${ENTRY_ID}
    `;

    await entryEventTransfersRepository.replaceForEvent(ENTRY_ID, 10, [], undefined, {
      syncMode: 'latest',
      checkpointSeason: TEST_SEASON,
    });
    await entryEventTransfersRepository.replaceForEvent(ENTRY_ID, 12, [], undefined, {
      syncMode: 'latest',
      checkpointSeason: TEST_SEASON,
    });
    expect((await checkpointRow())?.transfers).toBe(10);

    await entryEventTransfersRepository.replaceForEvent(ENTRY_ID, 11, [], undefined, {
      syncMode: 'latest',
      checkpointSeason: TEST_SEASON,
    });
    await entryEventTransfersRepository.replaceForEvent(ENTRY_ID, 12, [], undefined, {
      syncMode: 'latest',
      checkpointSeason: TEST_SEASON,
    });
    expect((await checkpointRow())?.transfers).toBe(12);
  });

  test('concurrent full syncs preserve the highest checkpoint', async () => {
    const sql = await getDbClient();
    await sql`
      UPDATE entry_infos
      SET entry_transfers_synced_through_event_id = NULL,
          entry_transfers_synced_season = NULL
      WHERE id = ${ENTRY_ID}
    `;
    await Promise.all([
      entryEventTransfersRepository.replaceForEvent(ENTRY_ID, 10, [], undefined, {
        syncMode: 'all',
        checkpointSeason: TEST_SEASON,
      }),
      entryEventTransfersRepository.replaceForEvent(ENTRY_ID, 12, [], undefined, {
        syncMode: 'all',
        checkpointSeason: TEST_SEASON,
      }),
    ]);
    expect((await checkpointRow())?.transfers).toBe(12);
  });

  test('concurrent snapshot syncs preserve the highest checkpoint', async () => {
    const sql = await getDbClient();
    await sql`
      UPDATE entry_infos
      SET entry_snapshot_synced_through_event_id = NULL,
          entry_snapshot_synced_season = NULL
      WHERE id = ${ENTRY_ID}
    `;
    await Promise.all([syncEntryInfo(ENTRY_ID, client, 10), syncEntryInfo(ENTRY_ID, client, 12)]);
    expect((await checkpointRow())?.snapshot).toBe(12);
  });

  test('event result sync preserves every transfer made in the same GW', async () => {
    const sql = await getDbClient();
    await sql`DELETE FROM entry_event_transfers WHERE entry_id = ${ENTRY_ID}`;
    await sql`
      UPDATE entry_infos
      SET entry_transfers_synced_through_event_id = NULL,
          entry_transfers_synced_season = NULL
      WHERE id = ${ENTRY_ID}
    `;
    mockFPLClient({
      async getEntryEventPicks() {
        return {
          active_chip: null,
          automatic_subs: [],
          entry_history: {
            event: 12,
            points: 50,
            total_points: 600,
            rank: 100,
            overall_rank: 1_000,
            bank: 5,
            value: 1_000,
            event_transfers: 2,
            event_transfers_cost: 4,
            points_on_bench: 3,
          },
          picks: completePicks(),
        };
      },
      async getEntryTransfers() {
        return [
          {
            entry: ENTRY_ID,
            event: 12,
            element_in: PICK_PLAYER_ID,
            element_in_cost: 50,
            element_out: TRANSFER_PLAYER_ID,
            element_out_cost: 51,
            time: '2026-10-08T10:00:00Z',
          },
          {
            entry: ENTRY_ID,
            event: 12,
            element_in: TRANSFER_PLAYER_ID,
            element_in_cost: 51,
            element_out: PICK_PLAYER_ID,
            element_out_cost: 50,
            time: '2026-10-08T11:00:00Z',
          },
        ];
      },
    });

    try {
      const result = await syncTournamentEventResultsForEntryIds([ENTRY_ID], 12, {
        live: {
          elements: completeEventLive().elements.map((element) =>
            element.id === PICK_PLAYER_ID
              ? { ...element, stats: { total_points: 2 } }
              : element.id === TRANSFER_PLAYER_ID
                ? { ...element, stats: { total_points: 6 } }
                : element,
          ),
        },
      });
      expect(result.synced).toBe(1);

      const rows = await sql<Array<{ elementInId: number; transferTime: Date }>>`
        SELECT element_in_id AS "elementInId", transfer_time AS "transferTime"
        FROM entry_event_transfers
        WHERE entry_id = ${ENTRY_ID} AND event_id = 12
        ORDER BY transfer_time
      `;
      expect(rows.map((row) => row.elementInId)).toEqual([PICK_PLAYER_ID, TRANSFER_PLAYER_ID]);
      expect((await checkpointRow())?.transfers).toBe(12);
    } finally {
      resetMockFPLClient();
    }
  });

  test('season rollover rejects picks, results, and transfers as one atomic write', async () => {
    const sql = await getDbClient();
    const redis = await redisSingleton.getClient();
    await sql`DELETE FROM entry_event_transfers WHERE entry_id = ${ENTRY_ID}`;
    await sql`DELETE FROM entry_event_picks WHERE entry_id = ${ENTRY_ID} AND event_id = 12`;
    await sql`DELETE FROM entry_event_results WHERE entry_id = ${ENTRY_ID} AND event_id = 12`;
    await sql`
      UPDATE entry_infos
      SET entry_snapshot_synced_through_event_id = 12,
          entry_snapshot_synced_season = ${TEST_SEASON},
          entry_transfers_synced_through_event_id = NULL,
          entry_transfers_synced_season = NULL
      WHERE id = ${ENTRY_ID}
    `;
    await redis.set('Season:active', TEST_SEASON);
    resetActiveSeasonMemo();
    mockFPLClient({
      async getEntryEventPicks() {
        return {
          active_chip: null,
          automatic_subs: [],
          entry_history: {
            event: 12,
            points: 50,
            total_points: 600,
            rank: 100,
            overall_rank: 1_000,
            bank: 5,
            value: 1_000,
            event_transfers: 0,
            event_transfers_cost: 0,
            points_on_bench: 3,
          },
          picks: [],
        };
      },
      async getEntryTransfers() {
        await redis.set('Season:active', '2627');
        return [];
      },
    });

    try {
      await expect(
        syncTournamentEventResultsForEntryIds([ENTRY_ID], 12, {
          live: { elements: [] },
        }),
      ).rejects.toThrow('Tournament event results did not converge for every requested entry');
      const rows = await sql<Array<{ picks: number; results: number; transfers: number }>>`
        SELECT
          (SELECT count(*)::int FROM entry_event_picks
           WHERE entry_id = ${ENTRY_ID} AND event_id = 12) AS picks,
          (SELECT count(*)::int FROM entry_event_results
           WHERE entry_id = ${ENTRY_ID} AND event_id = 12) AS results,
          (SELECT count(*)::int FROM entry_event_transfers
           WHERE entry_id = ${ENTRY_ID}) AS transfers
      `;
      expect(rows[0]).toEqual({ picks: 0, results: 0, transfers: 0 });
      expect((await checkpointRow())?.transfers).toBeNull();
    } finally {
      resetMockFPLClient();
      await redis.set('Season:active', TEST_SEASON);
      resetActiveSeasonMemo();
    }
  });

  test('event result sync fetches authoritative live points instead of stored provisional rows', async () => {
    const sql = await getDbClient();
    await sql`DELETE FROM entry_event_transfers WHERE entry_id = ${ENTRY_ID}`;
    await sql`DELETE FROM entry_event_picks WHERE entry_id = ${ENTRY_ID} AND event_id = 12`;
    await sql`DELETE FROM entry_event_results WHERE entry_id = ${ENTRY_ID} AND event_id = 12`;
    await sql`
      UPDATE entry_infos
      SET entry_snapshot_synced_through_event_id = 12,
          entry_snapshot_synced_season = ${TEST_SEASON},
          entry_transfers_synced_through_event_id = NULL,
          entry_transfers_synced_season = NULL
      WHERE id = ${ENTRY_ID}
    `;
    await sql`
      INSERT INTO event_lives (event_id, element_id, total_points)
      VALUES (12, ${PICK_PLAYER_ID}, 1)
      ON CONFLICT (event_id, element_id) DO UPDATE SET total_points = excluded.total_points
    `;
    const redis = await redisSingleton.getClient();
    await redis.del('EventLive:2526:12');
    let liveCalls = 0;
    mockFPLClient({
      async getEventLive() {
        liveCalls += 1;
        const live = completeRawEventLive();
        live.elements[1]!.stats.total_points = 7;
        return live;
      },
      async getEntryEventPicks() {
        const picks = completePicks().map((pick) => {
          if (pick.is_captain) return { ...pick, multiplier: 0 };
          if (pick.is_vice_captain) return { ...pick, multiplier: 2 };
          return pick;
        });
        return {
          active_chip: null,
          automatic_subs: [],
          entry_history: {
            event: 12,
            points: 50,
            total_points: 600,
            rank: 100,
            overall_rank: 1_000,
            bank: 5,
            value: 1_000,
            event_transfers: 0,
            event_transfers_cost: 0,
            points_on_bench: 3,
          },
          picks,
        };
      },
      async getEntryTransfers() {
        return [];
      },
    });

    try {
      const result = await syncTournamentEventResultsForEntryIds([ENTRY_ID], 12);
      expect(result.synced).toBe(1);
      const rows = await sql<
        Array<{ captainPoints: number | null; playedCaptainId: number | null }>
      >`
        SELECT
          event_captain_points AS "captainPoints",
          event_played_captain AS "playedCaptainId"
        FROM entry_event_results
        WHERE entry_id = ${ENTRY_ID} AND event_id = 12
      `;
      const canonicalLive = await sql<Array<{ totalPoints: number }>>`
        SELECT total_points AS "totalPoints"
        FROM event_lives
        WHERE event_id = 12 AND element_id = ${PICK_PLAYER_ID}
      `;
      expect(liveCalls).toBe(1);
      expect(rows[0]?.captainPoints).toBe(14);
      expect(rows[0]?.playedCaptainId).toBe(PICK_PLAYER_ID + 1);
      expect(canonicalLive[0]?.totalPoints).toBe(1);
    } finally {
      resetMockFPLClient();
      await sql`DELETE FROM event_lives WHERE event_id = 12`;
      await redis.del('EventLive:2526:12');
    }
  });

  test('range constraint rolls back an invalid checkpoint update', async () => {
    const before = (await checkpointRow())?.transfers;
    await expect(
      entryEventTransfersRepository.replaceForEvent(ENTRY_ID, 39, [], undefined, {
        syncMode: 'all',
        checkpointSeason: TEST_SEASON,
      }),
    ).rejects.toThrow();
    expect((await checkpointRow())?.transfers).toBe(before);
  });
});
