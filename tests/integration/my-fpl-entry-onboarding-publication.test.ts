import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { redisSingleton } from '../../src/cache/singleton';
import type { FplSeasonRef } from '../../src/domain/fpl-season';
import { getDbClient } from '../../src/db/singleton';
import {
  captureMyFplSnapshot,
  dispatchMyFplSnapshotPublicationOutbox,
  getMyFplSnapshotOperationalStatus,
  myFplSnapshotRedisManifestKey,
  MyFplSnapshotIncompleteError,
  type MyFplSnapshotRedisManifest,
} from '../../src/services/my-fpl-snapshot-publication.service';

const SEASON: FplSeasonRef = { seasonId: 2098, seasonCode: '9899' };
const EVENT_ID = 1;
const TEAM_ID = 998_100;
const ENTRY_IDS = [998_201, 998_202] as const;
const PLAYER_IDS = Array.from({ length: 15 }, (_, index) => 998_301 + index);
const SNAPSHOT_DATE = '2026-08-23';
const CAPTURE_NOW = new Date('2026-08-23T04:00:00.000Z');
const MANIFEST_KEY = myFplSnapshotRedisManifestKey(SEASON.seasonCode, EVENT_ID);

async function cleanup(): Promise<void> {
  const sql = await getDbClient();
  await sql`
    DELETE FROM competition.my_fpl_snapshot_publications
    WHERE season_id = ${SEASON.seasonId} AND event_id = ${EVENT_ID}
  `;
  await sql`
    DELETE FROM competition.entry_event_transfers
    WHERE season_id = ${SEASON.seasonId}
      AND entry_id = ANY(${[...ENTRY_IDS]}::integer[])
  `;
  await sql`
    DELETE FROM competition.entry_event_picks
    WHERE season_id = ${SEASON.seasonId}
      AND entry_id = ANY(${[...ENTRY_IDS]}::integer[])
  `;
  await sql`
    DELETE FROM competition.entry_event_results
    WHERE season_id = ${SEASON.seasonId}
      AND entry_id = ANY(${[...ENTRY_IDS]}::integer[])
  `;
  await sql`
    DELETE FROM competition.entries
    WHERE season_id = ${SEASON.seasonId}
      AND entry_id = ANY(${[...ENTRY_IDS]}::integer[])
  `;
  await sql`
    DELETE FROM fpl.player_gameweek_stats
    WHERE season_id = ${SEASON.seasonId} AND event_id = ${EVENT_ID}
  `;
  await sql`
    DELETE FROM fpl.players
    WHERE season_id = ${SEASON.seasonId}
      AND element_id = ANY(${PLAYER_IDS}::integer[])
  `;
  await sql`
    DELETE FROM fpl.events
    WHERE season_id = ${SEASON.seasonId} AND event_id = ${EVENT_ID}
  `;
  await sql`
    DELETE FROM fpl.teams
    WHERE season_id = ${SEASON.seasonId} AND team_id = ${TEAM_ID}
  `;
  await sql`
    DELETE FROM fpl.seasons
    WHERE season_id = ${SEASON.seasonId} AND season_code = ${SEASON.seasonCode}
  `;
  const cache = await redisSingleton.getClient();
  await cache.unlink(MANIFEST_KEY);
}

async function seedBase(): Promise<void> {
  const sql = await getDbClient();
  await cleanup();
  await sql`
    INSERT INTO fpl.seasons (
      season_id, season_code, display_name, start_year, end_year, lifecycle_state, is_current
    )
    VALUES (
      ${SEASON.seasonId}, ${SEASON.seasonCode}, 'My FPL onboarding integration 2098/99',
      ${SEASON.seasonId}, ${SEASON.seasonId + 1}, 'completed', false
    )
  `;
  await sql`
    INSERT INTO fpl.teams (season_id, team_id, code, name, short_name)
    VALUES (${SEASON.seasonId}, ${TEAM_ID}, ${TEAM_ID}, 'Onboarding Integration', 'OBI')
  `;
  await sql`
    INSERT INTO fpl.events (
      season_id, event_id, name, deadline_time, finished, data_checked
    )
    VALUES (
      ${SEASON.seasonId}, ${EVENT_ID}, 'Integration GW 1',
      timestamptz '2026-08-22 04:00:00+00', false, false
    )
  `;
  await sql`
    INSERT INTO fpl.players (
      season_id, element_id, code, element_type, team_id, web_name
    )
    SELECT
      ${SEASON.seasonId}, player.element_id, player.element_id + 100000,
      ((player.ordinality - 1) % 4 + 1)::integer,
      ${TEAM_ID}, 'Onboarding Player ' || player.ordinality::text
    FROM unnest(${PLAYER_IDS}::integer[])
      WITH ORDINALITY AS player(element_id, ordinality)
  `;
  await sql`
    INSERT INTO fpl.player_gameweek_stats (
      season_id, event_id, element_id, minutes, total_points
    )
    SELECT
      ${SEASON.seasonId}, ${EVENT_ID}, player.element_id, 90,
      player.ordinality::integer
    FROM unnest(${PLAYER_IDS}::integer[])
      WITH ORDINALITY AS player(element_id, ordinality)
  `;
}

async function seedEntry(entryId: number, complete: boolean): Promise<void> {
  const sql = await getDbClient();
  await sql`
    INSERT INTO competition.entries (
      season_id, entry_id, entry_name, player_name, started_event,
      overall_points, overall_rank, bank, team_value, total_transfers,
      last_event_id, snapshot_synced_through_event_id,
      transfers_synced_through_event_id, transfers_source_checked_at,
      past_seasons_checked_at, past_seasons_count
    )
    VALUES (
      ${SEASON.seasonId}, ${entryId}, ${`Integration Entry ${entryId}`},
      ${`Integration Manager ${entryId}`}, 1,
      60, 1000, 10, 1000, 0,
      ${EVENT_ID}, ${EVENT_ID}, ${complete ? EVENT_ID : null},
      ${complete ? CAPTURE_NOW.toISOString() : null}::timestamptz,
      ${CAPTURE_NOW.toISOString()}::timestamptz, 0
    )
  `;
  if (complete) await seedEntryEventData(entryId);
}

async function seedEntryEventData(entryId: number): Promise<void> {
  const sql = await getDbClient();
  await sql`
    INSERT INTO competition.entry_event_results (
      season_id, entry_id, event_id, event_points, event_transfers,
      event_transfers_cost, event_net_points, event_bench_points,
      event_auto_sub_points, overall_points, overall_rank,
      played_captain_element_id, captain_points, automatic_substitutions,
      team_value, bank, rich_synced_at
    )
    VALUES (
      ${SEASON.seasonId}, ${entryId}, ${EVENT_ID}, 60, 0,
      0, 60, 5, 0, 60, 1000,
      ${PLAYER_IDS[0]}, 10, '[]'::jsonb, 1000, 10,
      ${CAPTURE_NOW.toISOString()}::timestamptz
    )
  `;
  await sql`
    INSERT INTO competition.entry_event_picks (
      season_id, entry_id, event_id, position, element_id, multiplier,
      is_captain, is_vice_captain, source_created_at, source_updated_at
    )
    SELECT
      ${SEASON.seasonId}, ${entryId}, ${EVENT_ID}, player.ordinality::smallint,
      player.element_id,
      CASE WHEN player.ordinality = 1 THEN 2 WHEN player.ordinality <= 11 THEN 1 ELSE 0 END::smallint,
      player.ordinality = 1, player.ordinality = 2,
      ${CAPTURE_NOW.toISOString()}::timestamptz,
      ${CAPTURE_NOW.toISOString()}::timestamptz
    FROM unnest(${PLAYER_IDS}::integer[])
      WITH ORDINALITY AS player(element_id, ordinality)
  `;
  await sql`
    UPDATE competition.entries
    SET transfers_synced_through_event_id = ${EVENT_ID},
        transfers_source_checked_at = ${CAPTURE_NOW.toISOString()}::timestamptz
    WHERE season_id = ${SEASON.seasonId} AND entry_id = ${entryId}
  `;
}

beforeAll(seedBase);
afterAll(cleanup);

describe('My FPL onboarding publication correction', () => {
  test('keeps the old active revision until all new-entry data is complete', async () => {
    const sql = await getDbClient();
    await seedEntry(ENTRY_IDS[0], true);
    const first = await captureMyFplSnapshot(SEASON, EVENT_ID, 'PROVISIONAL', {
      snapshotDate: SNAPSHOT_DATE,
      now: CAPTURE_NOW,
    });
    expect(first).toMatchObject({
      status: 'published',
      publication: { expectedEntryCount: 1, readyEntryCount: 1 },
    });

    await seedEntry(ENTRY_IDS[1], false);
    const pendingStatus = (await getMyFplSnapshotOperationalStatus(SEASON)).find(
      (row) => row.eventId === EVENT_ID,
    );
    expect(pendingStatus).toMatchObject({
      currentEntryCount: 2,
      pendingCorrectionEntryCount: 1,
      coverageState: 'CORRECTION_PENDING',
    });

    const beforeFailure = await sql<
      Array<{ active_revision: number; publication_count: number; outbox_count: number }>
    >`
      SELECT
        max(revision) FILTER (WHERE active)::integer AS active_revision,
        count(*)::integer AS publication_count,
        (SELECT count(*)::integer
         FROM competition.my_fpl_snapshot_publication_outbox outbox
         WHERE outbox.season_id = ${SEASON.seasonId}
           AND outbox.event_id = ${EVENT_ID}) AS outbox_count
      FROM competition.my_fpl_snapshot_publications
      WHERE season_id = ${SEASON.seasonId} AND event_id = ${EVENT_ID}
    `;
    await expect(
      captureMyFplSnapshot(SEASON, EVENT_ID, 'PROVISIONAL', {
        snapshotDate: SNAPSHOT_DATE,
        now: CAPTURE_NOW,
      }),
    ).rejects.toBeInstanceOf(MyFplSnapshotIncompleteError);
    const afterFailure = await sql<
      Array<{ active_revision: number; publication_count: number; outbox_count: number }>
    >`
      SELECT
        max(revision) FILTER (WHERE active)::integer AS active_revision,
        count(*)::integer AS publication_count,
        (SELECT count(*)::integer
         FROM competition.my_fpl_snapshot_publication_outbox outbox
         WHERE outbox.season_id = ${SEASON.seasonId}
           AND outbox.event_id = ${EVENT_ID}) AS outbox_count
      FROM competition.my_fpl_snapshot_publications
      WHERE season_id = ${SEASON.seasonId} AND event_id = ${EVENT_ID}
    `;
    expect(afterFailure).toEqual(beforeFailure);

    await seedEntryEventData(ENTRY_IDS[1]);
    const corrected = await captureMyFplSnapshot(SEASON, EVENT_ID, 'PROVISIONAL', {
      snapshotDate: SNAPSHOT_DATE,
      now: CAPTURE_NOW,
    });
    expect(corrected).toMatchObject({
      status: 'published',
      publication: { expectedEntryCount: 2, readyEntryCount: 2 },
    });
    expect(corrected.publication.revision).toBeGreaterThan(first.publication.revision);
    expect(corrected.publication.contentSha256).not.toBe(first.publication.contentSha256);

    const repeated = await captureMyFplSnapshot(SEASON, EVENT_ID, 'PROVISIONAL', {
      snapshotDate: SNAPSHOT_DATE,
      now: CAPTURE_NOW,
    });
    expect(repeated).toMatchObject({
      status: 'noop',
      publication: {
        revision: corrected.publication.revision,
        contentSha256: corrected.publication.contentSha256,
      },
    });

    await sql`
      UPDATE competition.entries
      SET overall_points = 61
      WHERE season_id = ${SEASON.seasonId} AND entry_id = ${ENTRY_IDS[0]}
    `;
    await sql`
      UPDATE competition.entry_event_results
      SET overall_points = 61
      WHERE season_id = ${SEASON.seasonId}
        AND event_id = ${EVENT_ID}
        AND entry_id = ${ENTRY_IDS[0]}
    `;
    const concurrent = await Promise.all([
      captureMyFplSnapshot(SEASON, EVENT_ID, 'PROVISIONAL', {
        snapshotDate: SNAPSHOT_DATE,
        now: CAPTURE_NOW,
      }),
      captureMyFplSnapshot(SEASON, EVENT_ID, 'PROVISIONAL', {
        snapshotDate: SNAPSHOT_DATE,
        now: CAPTURE_NOW,
      }),
    ]);
    expect(concurrent.map((result) => result.status).sort()).toEqual(['noop', 'published']);
    const concurrentPublished = concurrent.find((result) => result.status === 'published');
    expect(concurrentPublished).toBeDefined();
    expect(concurrent[0].publication.revision).toBe(concurrent[1].publication.revision);
    expect(concurrent[0].publication.revision).toBeGreaterThan(corrected.publication.revision);
    const latestPublication = concurrentPublished!.publication;

    await dispatchMyFplSnapshotPublicationOutbox({ limit: 20 });
    const [databaseActive] = await sql<
      Array<{ revision: number; content_sha256: string; entry_count: number }>
    >`
      SELECT publication.revision::integer AS revision, publication.content_sha256,
             count(entry.entry_id)::integer AS entry_count
      FROM competition.my_fpl_snapshot_publications publication
      JOIN competition.my_fpl_snapshot_entries entry
        ON entry.season_id = publication.season_id
       AND entry.event_id = publication.event_id
       AND entry.revision = publication.revision
      WHERE publication.season_id = ${SEASON.seasonId}
        AND publication.event_id = ${EVENT_ID}
        AND publication.active
      GROUP BY publication.revision, publication.content_sha256
    `;
    const cache = await redisSingleton.getClient();
    const redisManifest = JSON.parse(
      (await cache.get(MANIFEST_KEY)) ?? 'null',
    ) as MyFplSnapshotRedisManifest | null;
    expect(databaseActive).toEqual({
      revision: latestPublication.revision,
      content_sha256: latestPublication.contentSha256,
      entry_count: 2,
    });
    expect(redisManifest).toMatchObject({
      revision: databaseActive.revision,
      contentSha256: databaseActive.content_sha256,
    });

    const completeStatus = (await getMyFplSnapshotOperationalStatus(SEASON)).find(
      (row) => row.eventId === EVENT_ID,
    );
    expect(completeStatus).toMatchObject({
      currentEntryCount: 2,
      pendingCorrectionEntryCount: 0,
      coverageState: 'COMPLETE',
    });

    await sql`
      UPDATE fpl.events
      SET finished = true, data_checked = true,
          data_checked_at = ${CAPTURE_NOW.toISOString()}::timestamptz
      WHERE season_id = ${SEASON.seasonId} AND event_id = ${EVENT_ID}
    `;
    const finalOverride = {
      snapshotDate: SNAPSHOT_DATE,
      now: CAPTURE_NOW,
      actor: 'integration-test',
      reason: 'verify concurrent final idempotency',
      idempotencyKey: 'my-fpl-concurrent-final-integration',
    };
    const concurrentFinal = await Promise.all([
      captureMyFplSnapshot(SEASON, EVENT_ID, 'FINAL', finalOverride),
      captureMyFplSnapshot(SEASON, EVENT_ID, 'FINAL', finalOverride),
    ]);
    expect(concurrentFinal.map((result) => result.status).sort()).toEqual(['noop', 'published']);
    expect(concurrentFinal[0].publication.revision).toBe(concurrentFinal[1].publication.revision);
    expect(concurrentFinal[0].publication).toMatchObject({
      kind: 'FINAL',
      idempotencyKey: finalOverride.idempotencyKey,
    });

    const originalFinalRevision = concurrentFinal[0].publication.revision;
    const supersedingFinal = await captureMyFplSnapshot(SEASON, EVENT_ID, 'FINAL', {
      ...finalOverride,
      reason: 'supersede the first explicit final override',
      idempotencyKey: 'my-fpl-superseding-final-integration',
    });
    expect(supersedingFinal.status).toBe('published');
    expect(supersedingFinal.publication.revision).toBeGreaterThan(originalFinalRevision);

    const historicalReplay = await captureMyFplSnapshot(SEASON, EVENT_ID, 'FINAL', finalOverride);
    expect(historicalReplay).toMatchObject({
      status: 'noop',
      publication: {
        revision: originalFinalRevision,
        idempotencyKey: finalOverride.idempotencyKey,
      },
    });
    const finalPublicationState = await sql<
      { publication_count: number; active_revision: number }[]
    >`
      SELECT count(*)::integer AS publication_count,
             max(revision) FILTER (WHERE active)::integer AS active_revision
      FROM competition.my_fpl_snapshot_publications
      WHERE season_id = ${SEASON.seasonId} AND event_id = ${EVENT_ID}
    `;
    expect(finalPublicationState[0]).toEqual({
      publication_count: 5,
      active_revision: supersedingFinal.publication.revision,
    });
  });
});
