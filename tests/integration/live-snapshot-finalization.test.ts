import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import type { LiveSnapshotCacheContents } from '../../src/cache/live-snapshot-cache';
import { getDbClient } from '../../src/db/singleton';
import type { FplSeasonRef } from '../../src/domain/fpl-season';
import {
  persistLiveSnapshotDurably,
  syncLiveSnapshot,
  type LiveSnapshotReferenceData,
  type PreparedLiveSnapshot,
} from '../../src/services/live-snapshot.service';
import type { RawFPLFixture } from '../../src/types';
import { mockEventLiveResponseFixture } from '../fixtures/event-lives.fixtures';
import { mockRawFPLFixture1 } from '../fixtures/fixtures.fixtures';

const SEASON: FplSeasonRef = { seasonId: 2097, seasonCode: '9798' };
const EVENT_ID = 1;
const FINALIZED_AT = new Date('2026-08-25T16:08:07.277Z');
let preservedCurrentSeasonId: number | null = null;

async function removeFixtureSeason(): Promise<void> {
  const sql = await getDbClient();
  await sql`
    DELETE FROM ops.sync_items
    WHERE run_id IN (SELECT run_id FROM ops.sync_runs WHERE season_id = ${SEASON.seasonId})
  `;
  await sql`
    DELETE FROM ops.data_publication_outbox
    WHERE season_id = ${SEASON.seasonId}
  `;
  await sql`
    UPDATE ops.sync_runs
    SET publication_id = NULL
    WHERE season_id = ${SEASON.seasonId}
  `;
  await sql`
    DELETE FROM ops.dataset_publication_items
    WHERE publication_id IN (
      SELECT publication_id
      FROM ops.dataset_publications
      WHERE season_id = ${SEASON.seasonId}
    )
  `;
  await sql`DELETE FROM ops.dataset_publications WHERE season_id = ${SEASON.seasonId}`;
  await sql`DELETE FROM ops.sync_runs WHERE season_id = ${SEASON.seasonId}`;
  await sql`DELETE FROM fpl.events WHERE season_id = ${SEASON.seasonId}`;
  await sql`DELETE FROM fpl.seasons WHERE season_id = ${SEASON.seasonId}`;
}

async function seed(): Promise<void> {
  await removeFixtureSeason();
  const sql = await getDbClient();
  const current = await sql<{ seasonId: number }[]>`
    SELECT season_id AS "seasonId"
    FROM fpl.seasons
    WHERE is_current = true
  `;
  if (current.length > 1) throw new Error('integration database has multiple current seasons');
  preservedCurrentSeasonId = current[0]?.seasonId ?? null;
  try {
    await sql`UPDATE fpl.seasons SET is_current = false WHERE is_current = true`;
    await sql`
      INSERT INTO fpl.seasons (
        season_id, season_code, display_name, start_year, end_year, lifecycle_state, is_current
      ) VALUES (
        ${SEASON.seasonId}, ${SEASON.seasonCode}, '2097/98 finalization fence',
        ${SEASON.seasonId}, ${SEASON.seasonId + 1}, 'active', true
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
  } catch (error) {
    await removeFixtureSeason();
    if (preservedCurrentSeasonId !== null) {
      await sql`
        UPDATE fpl.seasons
        SET is_current = true
        WHERE season_id = ${preservedCurrentSeasonId}
      `;
    }
    throw error;
  }
}

async function cleanup(): Promise<void> {
  await removeFixtureSeason();
  if (preservedCurrentSeasonId !== null) {
    const sql = await getDbClient();
    await sql`
      UPDATE fpl.seasons
      SET is_current = true
      WHERE season_id = ${preservedCurrentSeasonId}
    `;
  }
  preservedCurrentSeasonId = null;
}

beforeAll(seed);
afterAll(cleanup);

describe('live snapshot finalization fence', () => {
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

  test('treats a later finalization replay as an immutable no-op', async () => {
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
      disposition: 'finalized-noop',
      winnerCheckedAt: FINALIZED_AT,
      persistedFixtures: false,
      persistedEventLives: false,
    });

    const sql = await getDbClient();
    const [event] = await sql<{ checkedAtPreserved: boolean; finalizedAtPreserved: boolean }[]>`
      SELECT live_snapshot_checked_at = ${FINALIZED_AT.toISOString()}::timestamptz
               AS "checkedAtPreserved",
             live_snapshot_finalized_at = ${FINALIZED_AT.toISOString()}::timestamptz
               AS "finalizedAtPreserved"
      FROM fpl.events
      WHERE season_id = ${SEASON.seasonId} AND event_id = ${EVENT_ID}
    `;
    expect(event).toEqual({ checkedAtPreserved: true, finalizedAtPreserved: true });
  });

  test('keeps concurrent finalization retries behind the same immutable fence', async () => {
    const results = await Promise.all(
      ['2026-08-25T17:03:30.000Z', '2026-08-25T17:06:31.000Z'].map((checkedAt) =>
        persistLiveSnapshotDurably({
          season: SEASON,
          eventId: EVENT_ID,
          checkedAt: new Date(checkedAt),
          prepared,
          persistFixtures: true,
          persistEventLives: true,
          finalizeEvent: true,
        }),
      ),
    );

    expect(results.map((result) => result.disposition)).toEqual([
      'finalized-noop',
      'finalized-noop',
    ]);

    const sql = await getDbClient();
    const [event] = await sql<{ checkedAtPreserved: boolean; finalizedAtPreserved: boolean }[]>`
      SELECT live_snapshot_checked_at = ${FINALIZED_AT.toISOString()}::timestamptz
               AS "checkedAtPreserved",
             live_snapshot_finalized_at = ${FINALIZED_AT.toISOString()}::timestamptz
               AS "finalizedAtPreserved"
      FROM fpl.events
      WHERE season_id = ${SEASON.seasonId} AND event_id = ${EVENT_ID}
    `;
    expect(event).toEqual({ checkedAtPreserved: true, finalizedAtPreserved: true });
  });

  test('marks a non-final poll behind the immutable checkpoint for final reconciliation', async () => {
    const result = await persistLiveSnapshotDurably({
      season: SEASON,
      eventId: EVENT_ID,
      checkedAt: new Date('2026-08-25T17:07:31.000Z'),
      prepared,
      persistFixtures: true,
      persistEventLives: false,
      finalizeEvent: false,
    });

    expect(result).toEqual({
      disposition: 'finalized-superseded',
      winnerCheckedAt: FINALIZED_AT,
      persistedFixtures: false,
      persistedEventLives: false,
    });
  });

  test('never allocates or activates a publication from changed retry payloads', async () => {
    const rawFixture: RawFPLFixture = {
      ...mockRawFPLFixture1,
      event: EVENT_ID,
      started: true,
      finished: true,
      finished_provisional: true,
      minutes: 90,
    };
    const references: LiveSnapshotReferenceData = {
      season: SEASON.seasonCode,
      nameById: new Map([
        [rawFixture.team_h, 'Home'],
        [rawFixture.team_a, 'Away'],
      ]),
      shortNameById: new Map([
        [rawFixture.team_h, 'HOM'],
        [rawFixture.team_a, 'AWY'],
      ]),
      positionById: new Map([
        [rawFixture.team_h, 1],
        [rawFixture.team_a, 2],
      ]),
      playerTeamById: new Map(
        mockEventLiveResponseFixture.elements.map((element) => [element.id, rawFixture.team_h]),
      ),
    };
    const retained: LiveSnapshotCacheContents = {
      season: SEASON.seasonCode,
      eventId: EVENT_ID,
      state: 'settled',
      eventLives: [],
      fixtures: [],
      manifest: {
        dataset: 'fpl:live',
        seasonCode: SEASON.seasonCode,
        eventId: EVENT_ID,
        revision: 42,
        publicationId: '10000000-0000-4000-8000-000000000042',
        sourceCheckedAt: FINALIZED_AT.toISOString(),
        lastSuccessfulFetchAt: FINALIZED_AT.toISOString(),
        publishedAt: FINALIZED_AT.toISOString(),
        state: 'settled',
        items: [],
      },
    };
    const staleObservedBeforeFence: LiveSnapshotCacheContents = {
      ...retained,
      manifest: {
        ...retained.manifest,
        revision: 41,
        publicationId: '10000000-0000-4000-8000-000000000041',
      },
    };
    let publishedReads = 0;
    const dependencies = {
      getEventLive: async () => mockEventLiveResponseFixture,
      getFixtures: async () => [rawFixture],
      getExpectedFixtureIds: async () => [rawFixture.id],
      getReferenceData: async () => references,
      readOrderingTimestamp: async () => new Date('2026-08-25T17:06:31.000Z'),
      persistDurably: persistLiveSnapshotDurably,
      readPublished: async () => {
        publishedReads += 1;
        return publishedReads <= 2 ? staleObservedBeforeFence : retained;
      },
      refreshHeartbeat: async () => {
        throw new Error('finalized replay must not refresh the canonical manifest');
      },
    };

    const results = await Promise.all([
      syncLiveSnapshot(SEASON, EVENT_ID, {
        persistEventLives: true,
        finalizeEvent: true,
        dependencies,
      }),
      syncLiveSnapshot(SEASON, EVENT_ID, {
        persistEventLives: true,
        finalizeEvent: true,
        dependencies,
      }),
    ]);

    expect(results).toHaveLength(2);
    expect(results.every((result) => !result.changed && !result.stale)).toBe(true);
    expect(
      results.every((result) => result.publicationId === retained.manifest.publicationId),
    ).toBe(true);
    expect(publishedReads).toBe(4);

    const sql = await getDbClient();
    const [publicationCount] = await sql<{ count: number }[]>`
      SELECT count(*)::integer AS count
      FROM ops.dataset_publications
      WHERE dataset = 'fpl:live'
        AND season_id = ${SEASON.seasonId}
        AND event_id = ${EVENT_ID}
    `;
    const runs = await sql<{ status: string }[]>`
      SELECT status
      FROM ops.sync_runs
      WHERE season_id = ${SEASON.seasonId}
        AND event_id = ${EVENT_ID}
        AND scope = 'live-snapshot'
    `;
    expect(publicationCount?.count).toBe(0);
    expect(runs).toHaveLength(2);
    expect(runs.every((run) => run.status === 'skipped')).toBe(true);
  });

  test('reconciles a non-final poll after it observes the finalization fence', async () => {
    const rawFixture: RawFPLFixture = {
      ...mockRawFPLFixture1,
      event: EVENT_ID,
      started: true,
      finished: true,
      finished_provisional: true,
      minutes: 90,
    };
    const references: LiveSnapshotReferenceData = {
      season: SEASON.seasonCode,
      nameById: new Map([
        [rawFixture.team_h, 'Home'],
        [rawFixture.team_a, 'Away'],
      ]),
      shortNameById: new Map([
        [rawFixture.team_h, 'HOM'],
        [rawFixture.team_a, 'AWY'],
      ]),
      positionById: new Map([
        [rawFixture.team_h, 1],
        [rawFixture.team_a, 2],
      ]),
      playerTeamById: new Map(
        mockEventLiveResponseFixture.elements.map((element) => [element.id, rawFixture.team_h]),
      ),
    };
    const retained: LiveSnapshotCacheContents = {
      season: SEASON.seasonCode,
      eventId: EVENT_ID,
      state: 'settled',
      eventLives: [],
      fixtures: [],
      manifest: {
        dataset: 'fpl:live',
        seasonCode: SEASON.seasonCode,
        eventId: EVENT_ID,
        revision: 42,
        publicationId: '20000000-0000-4000-8000-000000000042',
        sourceCheckedAt: FINALIZED_AT.toISOString(),
        lastSuccessfulFetchAt: FINALIZED_AT.toISOString(),
        publishedAt: FINALIZED_AT.toISOString(),
        state: 'settled',
        items: [],
      },
    };
    const staleObservedBeforeFence: LiveSnapshotCacheContents = {
      ...retained,
      manifest: {
        ...retained.manifest,
        revision: 41,
        publicationId: '20000000-0000-4000-8000-000000000041',
      },
    };
    let recovered = false;
    let recoveryCalls = 0;
    let publishedReads = 0;
    const dependencies = {
      getEventLive: async () => mockEventLiveResponseFixture,
      getFixtures: async () => [rawFixture],
      getExpectedFixtureIds: async () => [rawFixture.id],
      getReferenceData: async () => references,
      readOrderingTimestamp: async () => new Date('2026-08-25T17:07:31.000Z'),
      persistDurably: persistLiveSnapshotDurably,
      readPublished: async () => {
        publishedReads += 1;
        return recovered ? retained : staleObservedBeforeFence;
      },
      recoverFinalizedPublication: async () => {
        recoveryCalls += 1;
        recovered = true;
        return 'activated' as const;
      },
      refreshHeartbeat: async () => {
        throw new Error('superseded poll must not refresh the canonical manifest');
      },
    };

    const result = await syncLiveSnapshot(SEASON, EVENT_ID, {
      persistEventLives: false,
      finalizeEvent: false,
      dependencies,
    });

    expect(result.changed).toBe(false);
    expect(result.stale).toBe(false);
    expect(result.revision).toBe(retained.manifest.revision);
    expect(result.publicationId).toBe(retained.manifest.publicationId);
    expect(recoveryCalls).toBe(1);
    expect(publishedReads).toBe(2);

    const sql = await getDbClient();
    const [publicationCount] = await sql<{ count: number }[]>`
      SELECT count(*)::integer AS count
      FROM ops.dataset_publications
      WHERE dataset = 'fpl:live'
        AND season_id = ${SEASON.seasonId}
        AND event_id = ${EVENT_ID}
    `;
    const [latestRun] = await sql<{ status: string }[]>`
      SELECT status
      FROM ops.sync_runs
      WHERE season_id = ${SEASON.seasonId}
        AND event_id = ${EVENT_ID}
        AND scope = 'live-snapshot'
      ORDER BY started_at DESC
      LIMIT 1
    `;
    expect(publicationCount?.count).toBe(0);
    expect(latestRun?.status).toBe('skipped');
  });
});
