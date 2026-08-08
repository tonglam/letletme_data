import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';

import { resetActiveSeasonMemo } from '../../src/cache/cache-season';
import { redisSingleton } from '../../src/cache/singleton';
import { fplClient } from '../../src/clients/fpl';
import { getDbClient } from '../../src/db/singleton';
import { syncEntryEventResults } from '../../src/services/entries.service';
import { syncTournamentEventResultsForEntryIds } from '../../src/services/tournament-event-results.service';

const ENTRY_ID = 99_042_003;
const EVENT_ID = 99_042_012;
const TEAM_ID = 99_042_299;
const PICK_PLAYER_ID = 99_042_301;
const TEST_SEASON = '2526';

const originalGetEntryEventPicks = fplClient.getEntryEventPicks;
const originalGetEventLive = fplClient.getEventLive;
let previousActiveSeason: string | null = null;

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

beforeAll(async () => {
  const redis = await redisSingleton.getClient();
  previousActiveSeason = await redis.get('Season:active');
  await redis.set('Season:active', TEST_SEASON);
  resetActiveSeasonMemo();

  const sql = await getDbClient();
  await sql`
    INSERT INTO events (id, name)
    VALUES (${EVENT_ID}, 'Evidence checkpoint GW')
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO teams (id, code, name, short_name, pulse_id)
    VALUES (${TEAM_ID}, ${TEAM_ID}, 'Evidence Team', 'EVD', ${TEAM_ID})
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO players (id, code, type, team_id, web_name)
    SELECT
      player_id,
      player_id,
      1,
      ${TEAM_ID},
      'Evidence Player ' || player_id
    FROM generate_series(
      ${PICK_PLAYER_ID}::integer,
      ${PICK_PLAYER_ID + 14}::integer
    ) AS generated(player_id)
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO entry_infos (
      id,
      entry_name,
      player_name,
      entry_snapshot_synced_through_event_id,
      entry_snapshot_synced_season
    )
    VALUES (${ENTRY_ID}, 'Evidence XI', 'Evidence Manager', 38, ${TEST_SEASON})
    ON CONFLICT (id) DO UPDATE
    SET entry_snapshot_synced_through_event_id = 38,
        entry_snapshot_synced_season = excluded.entry_snapshot_synced_season
  `;
});

afterAll(async () => {
  const sql = await getDbClient();
  await sql`DELETE FROM entry_event_results WHERE entry_id = ${ENTRY_ID}`;
  await sql`DELETE FROM entry_event_picks WHERE entry_id = ${ENTRY_ID}`;
  await sql`DELETE FROM entry_infos WHERE id = ${ENTRY_ID}`;
  await sql`DELETE FROM players WHERE id BETWEEN ${PICK_PLAYER_ID} AND ${PICK_PLAYER_ID + 14}`;
  await sql`DELETE FROM teams WHERE id = ${TEAM_ID}`;
  await sql`DELETE FROM events WHERE id = ${EVENT_ID}`;

  const redis = await redisSingleton.getClient();
  if (previousActiveSeason) await redis.set('Season:active', previousActiveSeason);
  else await redis.del('Season:active');
  resetActiveSeasonMemo();
});

afterEach(() => {
  fplClient.getEntryEventPicks = originalGetEntryEventPicks;
  fplClient.getEventLive = originalGetEventLive;
});

describe('entry result evidence checkpoint', () => {
  test('timestamps evidence before picks and live requests can cross finalization', async () => {
    let startedRequests = 0;
    let releaseRequests!: () => void;
    let signalRequestsStarted!: () => void;
    const requestsStarted = new Promise<void>((resolve) => {
      signalRequestsStarted = resolve;
    });
    const requestsReleased = new Promise<void>((resolve) => {
      releaseRequests = resolve;
    });
    const observeStart = async () => {
      startedRequests += 1;
      if (startedRequests === 2) signalRequestsStarted();
      await requestsReleased;
    };

    fplClient.getEntryEventPicks = async () => {
      await observeStart();
      return {
        active_chip: null,
        automatic_subs: [],
        picks: completePicks(),
        entry_history: {
          event: EVENT_ID,
          points: 50,
          total_points: 600,
          rank: 100,
          overall_rank: 1_000,
          bank: 0,
          value: 1_000,
          event_transfers: 0,
          event_transfers_cost: 0,
          points_on_bench: 0,
        },
      };
    };
    fplClient.getEventLive = async () => {
      await observeStart();
      return completeEventLive();
    };

    const sync = syncEntryEventResults(ENTRY_ID, EVENT_ID);
    await requestsStarted;
    const sql = await getDbClient();
    const finalizationRows = await sql<{ finalizedAt: string }[]>`
      SELECT clock_timestamp()::text AS "finalizedAt"
    `;
    const finalizedAt = finalizationRows[0]!.finalizedAt;
    releaseRequests();
    await sync;

    const rows = await sql<{ richSyncedAt: string | null; evidenceBeforeFinalization: boolean }[]>`
      SELECT
        rich_synced_at AS "richSyncedAt",
        rich_synced_at < ${finalizedAt}::timestamptz AS "evidenceBeforeFinalization"
      FROM entry_event_results
      WHERE entry_id = ${ENTRY_ID} AND event_id = ${EVENT_ID}
    `;
    expect(rows[0]?.richSyncedAt).not.toBeNull();
    expect(rows[0]!.evidenceBeforeFinalization).toBe(true);
  });

  test('timestamps tournament evidence with PostgreSQL before its picks request', async () => {
    let releaseRequest!: () => void;
    let signalRequestStarted!: () => void;
    const requestStarted = new Promise<void>((resolve) => {
      signalRequestStarted = resolve;
    });
    const requestReleased = new Promise<void>((resolve) => {
      releaseRequest = resolve;
    });

    fplClient.getEntryEventPicks = async () => {
      signalRequestStarted();
      await requestReleased;
      return {
        active_chip: null,
        automatic_subs: [],
        picks: completePicks(),
        entry_history: {
          event: EVENT_ID,
          points: 50,
          total_points: 600,
          rank: 100,
          overall_rank: 1_000,
          bank: 0,
          value: 1_000,
          event_transfers: 0,
          event_transfers_cost: 0,
          points_on_bench: 0,
        },
      };
    };

    const sync = syncTournamentEventResultsForEntryIds([ENTRY_ID], EVENT_ID, {
      live: completeEventLive(),
      season: TEST_SEASON,
      skipTransfers: true,
    });
    await requestStarted;
    const sql = await getDbClient();
    const finalizationRows = await sql<{ finalizedAt: string }[]>`
      SELECT clock_timestamp()::text AS "finalizedAt"
    `;
    releaseRequest();
    await sync;

    const rows = await sql<{ evidenceBeforeFinalization: boolean }[]>`
      SELECT rich_synced_at < ${finalizationRows[0]!.finalizedAt}::timestamptz
        AS "evidenceBeforeFinalization"
      FROM entry_event_results
      WHERE entry_id = ${ENTRY_ID} AND event_id = ${EVENT_ID}
    `;
    expect(rows[0]!.evidenceBeforeFinalization).toBe(true);
  });
});
