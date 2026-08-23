import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { drizzle } from 'drizzle-orm/postgres-js';

import { getDbClient } from '../../src/db/singleton';
import * as schema from '../../src/db/schemas/index.schema';
import type { FplSeasonRef } from '../../src/domain/fpl-season';
import {
  createManagerScoreCheckpointRepository,
  type ManagerScoreCheckpoint,
} from '../../src/repositories/live-window';

const SEASON: FplSeasonRef = { seasonId: 2095, seasonCode: '9596' };
const EVENT_ID = 1;
const ENTRY_ID = 9_501;
const SCOPE = { scopeType: 'CLASSIC_LEAGUE' as const, scopeId: 88_639 };

const checkpoint = (
  checkedAt: string,
  overallRankPublicationStartedAt: string | null,
): ManagerScoreCheckpoint => ({
  entryId: ENTRY_ID,
  eventPoints: 43,
  netEventPoints: null,
  totalPoints: 43,
  totalScope: 'CLASSIC_PHASE',
  eventRank: null,
  overallRank: 640_000,
  leagueRank: 25,
  source: 'FPL_CLASSIC_STANDINGS',
  transferCost: null,
  eventPointSemantics: 'UNKNOWN',
  contentRevision: 'same-rank-content',
  checkedAt: new Date(checkedAt),
  upstreamUpdatedAt: null,
  overallRankPublicationStartedAt,
});

async function seed(): Promise<void> {
  await cleanup();
  const sql = await getDbClient();
  await sql`
    INSERT INTO fpl.seasons (
      season_id, season_code, display_name, start_year, end_year, lifecycle_state, is_current
    ) VALUES (
      ${SEASON.seasonId}, ${SEASON.seasonCode}, '2095/96 manager checkpoint ordering',
      ${SEASON.seasonId}, ${SEASON.seasonId + 1}, 'completed', false
    )
  `;
  await sql`
    INSERT INTO fpl.events (season_id, event_id, name)
    VALUES (${SEASON.seasonId}, ${EVENT_ID}, 'GW1')
  `;
}

async function cleanup(): Promise<void> {
  const sql = await getDbClient();
  await sql`
    DELETE FROM fpl.manager_event_score_snapshots
    WHERE season_id = ${SEASON.seasonId}
  `;
  await sql`DELETE FROM fpl.events WHERE season_id = ${SEASON.seasonId}`;
  await sql`DELETE FROM fpl.seasons WHERE season_id = ${SEASON.seasonId}`;
}

beforeAll(seed);
afterAll(cleanup);

describe('Classic manager checkpoint OR ordering', () => {
  test('advances only for accepted valid OR publications', async () => {
    const sql = await getDbClient();
    const db = drizzle(sql, { schema });
    const repository = createManagerScoreCheckpointRepository(db);

    await repository.upsertBatch(SEASON, EVENT_ID, SCOPE, [
      checkpoint('2026-08-23T08:00:00.000Z', null),
    ]);
    await repository.upsertBatch(SEASON, EVENT_ID, SCOPE, [
      checkpoint('2026-08-23T08:00:01.000Z', '2026-08-23T08:00:01.000100Z'),
    ]);
    await repository.upsertBatch(SEASON, EVENT_ID, SCOPE, [
      checkpoint('2026-08-23T08:00:02.000Z', null),
    ]);
    await repository.upsertBatch(SEASON, EVENT_ID, SCOPE, [
      checkpoint('2026-08-23T08:00:03.000Z', '2026-08-23T08:00:01.000099Z'),
    ]);

    let [stored] = await repository.findByScopeAndEntryIds(SEASON, EVENT_ID, SCOPE, [ENTRY_ID]);
    expect(stored?.checkedAt.toISOString()).toBe('2026-08-23T08:00:03.000Z');
    expect(stored?.overallRankPublicationStartedAtExact).toBe('2026-08-23T08:00:01.000100Z');

    await repository.upsertBatch(SEASON, EVENT_ID, SCOPE, [
      checkpoint('2026-08-23T08:00:04.000Z', '2026-08-23T08:00:01.000101Z'),
    ]);
    [stored] = await repository.findByScopeAndEntryIds(SEASON, EVENT_ID, SCOPE, [ENTRY_ID]);
    expect(stored?.overallRankPublicationStartedAtExact).toBe('2026-08-23T08:00:01.000101Z');
  });
});
