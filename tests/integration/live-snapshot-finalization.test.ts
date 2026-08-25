import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { getDbClient } from '../../src/db/singleton';
import type { FplSeasonRef } from '../../src/domain/fpl-season';
import {
  persistLiveSnapshotDurably,
  type PreparedLiveSnapshot,
} from '../../src/services/live-snapshot.service';

const SEASON: FplSeasonRef = { seasonId: 2097, seasonCode: '9798' };
const EVENT_ID = 1;
const FINALIZED_AT = new Date('2026-08-25T16:08:07.277Z');

async function cleanup(): Promise<void> {
  const sql = await getDbClient();
  await sql`DELETE FROM fpl.events WHERE season_id = ${SEASON.seasonId}`;
  await sql`DELETE FROM fpl.seasons WHERE season_id = ${SEASON.seasonId}`;
}

async function seed(): Promise<void> {
  await cleanup();
  const sql = await getDbClient();
  await sql`
    INSERT INTO fpl.seasons (
      season_id, season_code, display_name, start_year, end_year, lifecycle_state, is_current
    ) VALUES (
      ${SEASON.seasonId}, ${SEASON.seasonCode}, '2097/98 finalization fence',
      ${SEASON.seasonId}, ${SEASON.seasonId + 1}, 'completed', false
    )
  `;
  await sql`
    INSERT INTO fpl.events (
      season_id, event_id, name, finished, data_checked, data_checked_at,
      live_snapshot_checked_at, live_snapshot_finalized_at, live_facts_persisted_at
    ) VALUES (
      ${SEASON.seasonId}, ${EVENT_ID}, 'GW1', true, true,
      ${FINALIZED_AT.toISOString()}::timestamptz,
      ${FINALIZED_AT.toISOString()}::timestamptz,
      ${FINALIZED_AT.toISOString()}::timestamptz,
      ${FINALIZED_AT.toISOString()}::timestamptz
    )
  `;
}

beforeAll(seed);
afterAll(cleanup);

describe('live snapshot finalization fence', () => {
  test('treats a later finalization replay as an immutable no-op', async () => {
    const prepared: PreparedLiveSnapshot = {
      season: SEASON.seasonCode,
      eventId: EVENT_ID,
      eventLives: {
        eventId: EVENT_ID,
        sourceCount: 0,
        eventLives: [],
        explains: [],
        fixtureEvidence: [],
        errors: 0,
      },
      fixtures: [],
      state: 'settled',
      liveIdentityBaseline: 'published-event',
    };

    const result = await persistLiveSnapshotDurably({
      season: SEASON,
      eventId: EVENT_ID,
      checkedAt: new Date('2026-08-25T17:04:30.606Z'),
      prepared,
      persistFixtures: true,
      persistEventLives: true,
      finalizeEvent: true,
    });

    expect(result).toEqual({
      accepted: false,
      winnerCheckedAt: FINALIZED_AT,
      persistedFixtures: false,
      persistedEventLives: false,
    });

    const sql = await getDbClient();
    const [event] = await sql<{ checkedAt: Date | null; finalizedAt: Date | null }[]>`
      SELECT live_snapshot_checked_at AS "checkedAt",
             live_snapshot_finalized_at AS "finalizedAt"
      FROM fpl.events
      WHERE season_id = ${SEASON.seasonId} AND event_id = ${EVENT_ID}
    `;
    expect(event?.checkedAt).toEqual(FINALIZED_AT);
    expect(event?.finalizedAt).toEqual(FINALIZED_AT);
  });
});
