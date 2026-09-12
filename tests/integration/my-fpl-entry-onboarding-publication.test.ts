import * as globalCheckpoints from '../../src/services/live-publication-v2-checkpoint.service';
import type { RawFPLEventLiveResponse } from '../../src/types';
import { fplClient } from '../../src/clients/fpl';
import { findMissingCoreResults } from '../../src/services/tournament-backfill.service';
import { syncTournamentEventResultsForEntryIds } from '../../src/services/tournament-event-results.service';
import { entryEventPicksRepository } from '../../src/repositories/entry-event-picks';
import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, beforeAll, describe, expect, test, spyOn } from 'bun:test';

import { redisSingleton } from '../../src/cache/singleton';
import type { EventLive } from '../../src/domain/event-lives';
import type { FplSeasonRef } from '../../src/domain/fpl-season';
import {
  entryLiveInputFromFplPicks,
  entryLiveV2Key,
  isEntryPublicationActiveAndCheckpointedV2,
  publishEntryLiveInputV2,
  publishLivePublicationV2,
  readEntryLiveInputV2,
  readLivePublicationV2,
  liveV2Key,
} from '../../src/cache/live-publication-v2';
import {
  checkpointFinalEntryFromProviderResponse,
  checkpointEntryLiveInputV2,
  hasFinalEntryCheckpoint,
  rebuildFinalEntryLiveInputsV2,
} from '../../src/services/entries.service';
import { getDbClient } from '../../src/db/singleton';
import {
  captureMyFplSnapshot,
  dispatchMyFplSnapshotPublicationOutbox,
  auditMyFplSnapshotIntegrity,
  myFplSnapshotRedisManifestKey,
  MyFplSnapshotIncompleteError,
  type MyFplSnapshotRedisManifest,
} from '../../src/services/my-fpl-snapshot-publication.service';

const SEASON: FplSeasonRef = { seasonId: 2098, seasonCode: '9899' };
const EVENT_ID = 1;
const TEAM_ID = 998_100;
const ENTRY_IDS = [998_201, 998_202] as const;
const DRIFT_TOURNAMENT_ID = 998_901;
const DRIFT_LEAGUE_ID = 998_901;
const PLAYER_IDS = Array.from({ length: 15 }, (_, index) => 998_301 + index);
const EVENT_PICKS = PLAYER_IDS.map((element, index) => ({
  element,
  position: index + 1,
  multiplier: index === 0 ? 2 : index < 11 ? 1 : 0,
  is_captain: index === 0,
  is_vice_captain: index === 1,
}));
const SNAPSHOT_DATE = '2026-08-23';
// The provisional authority enforces a 90-second live-heartbeat fence and a
// 15-minute picks fence. Keep the fixture inside those production freshness
// bounds regardless of when CI runs.
const CAPTURE_NOW = new Date();
const MANIFEST_KEY = myFplSnapshotRedisManifestKey(SEASON.seasonCode, EVENT_ID);

const liveRows: EventLive[] = PLAYER_IDS.map((elementId, index) => ({
  eventId: EVENT_ID,
  elementId,
  minutes: 90,
  goalsScored: 0,
  assists: 0,
  cleanSheets: 0,
  goalsConceded: 0,
  ownGoals: 0,
  penaltiesSaved: 0,
  penaltiesMissed: 0,
  yellowCards: 0,
  redCards: 0,
  saves: 0,
  bonus: 0,
  bps: 0,
  defensiveContribution: 0,
  starts: true,
  expectedGoals: null,
  expectedAssists: null,
  expectedGoalInvolvements: null,
  expectedGoalsConceded: null,
  inDreamTeam: false,
  totalPoints: index + 1,
  createdAt: CAPTURE_NOW,
}));
async function cleanup(): Promise<void> {
  const sql = await getDbClient();
  await sql`
    DELETE FROM competition.my_fpl_snapshot_publications
    WHERE season_id = ${SEASON.seasonId} AND event_id = ${EVENT_ID}
  `;
  await sql`
    DELETE FROM ops.dataset_publications
    WHERE dataset = 'redis:v2:fpl:live'
      AND season_id = ${SEASON.seasonId}
      AND event_id = ${EVENT_ID}
  `;
  await sql`
    DELETE FROM fpl.manager_event_score_heads
    WHERE season_id = ${SEASON.seasonId} AND event_id = ${EVENT_ID}
  `;
  await sql`
    DELETE FROM fpl.manager_event_score_materializations
    WHERE season_id = ${SEASON.seasonId} AND event_id = ${EVENT_ID}
  `;
  await sql`
    DELETE FROM competition.entry_event_transfers
    WHERE season_id = ${SEASON.seasonId}
      AND entry_id = ANY(${sql.array([...ENTRY_IDS])}::integer[])
  `;
  await sql`
    DELETE FROM competition.entry_event_pick_heads
    WHERE season_id = ${SEASON.seasonId}
      AND entry_id = ANY(${sql.array([...ENTRY_IDS])}::integer[])
  `;
  await sql`
    DELETE FROM competition.entry_event_pick_repairs
    WHERE season_id = ${SEASON.seasonId}
      AND entry_id = ANY(${sql.array([...ENTRY_IDS])}::integer[])
  `;
  await sql`
    DELETE FROM competition.entry_event_picks
    WHERE season_id = ${SEASON.seasonId}
      AND entry_id = ANY(${sql.array([...ENTRY_IDS])}::integer[])
  `;
  await sql`
    DELETE FROM competition.entry_event_results
    WHERE season_id = ${SEASON.seasonId}
      AND entry_id = ANY(${sql.array([...ENTRY_IDS])}::integer[])
  `;
  await sql`
    DELETE FROM competition.tournament_entries
    WHERE season_id = ${SEASON.seasonId} AND tournament_id = ${DRIFT_TOURNAMENT_ID}
  `;
  await sql`
    DELETE FROM competition.tournaments
    WHERE season_id = ${SEASON.seasonId} AND tournament_id = ${DRIFT_TOURNAMENT_ID}
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
      AND element_id = ANY(${sql.array(PLAYER_IDS)}::integer[])
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
  for (const pattern of [
    `llm:data:v2:fpl:live:${SEASON.seasonCode}:${EVENT_ID}:*`,
    `llm:data:v2:fpl:entry-live:${SEASON.seasonCode}:${EVENT_ID}:*`,
  ]) {
    let cursor = '0';
    do {
      const [next, keys] = await cache.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = next;
      if (keys.length > 0) await cache.unlink(...keys);
    } while (cursor !== '0');
  }
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
      CASE
        WHEN player.ordinality = 1 THEN 1
        WHEN player.ordinality BETWEEN 2 AND 6 THEN 2
        WHEN player.ordinality BETWEEN 7 AND 10 THEN 3
        ELSE 4
      END::integer,
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
  await publishLivePublicationV2({
    season: SEASON.seasonCode,
    eventId: EVENT_ID,
    state: 'LIVE_ACTIVE',
    sourceCheckedAt: CAPTURE_NOW,
    eventLives: liveRows,
    fixtures: [],
  });
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
      67, 1000, 10, 1000, 0,
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
      event_auto_sub_points, event_rank, overall_points, overall_rank,
      played_captain_element_id, captain_points, automatic_substitutions,
      team_value, bank, rich_synced_at, event_picks
    )
    VALUES (
      ${SEASON.seasonId}, ${entryId}, ${EVENT_ID}, 67, 0,
      0, 67, 0, 0, 1, 67, 1000,
      ${PLAYER_IDS[0]}, 2, '[]'::jsonb, 1000, 10,
      ${CAPTURE_NOW.toISOString()}::timestamptz,
      ${JSON.stringify(EVENT_PICKS)}::jsonb
    )
  `;
  await sql`
    INSERT INTO competition.entry_event_picks (
      season_id, entry_id, event_id, position, element_id, multiplier,
      is_captain, is_vice_captain, transfers, transfers_cost,
      source_created_at, source_updated_at, event_team_id
    )
    SELECT
      ${SEASON.seasonId}, ${entryId}, ${EVENT_ID}, player.ordinality::smallint,
      player.element_id,
      CASE WHEN player.ordinality = 1 THEN 2 WHEN player.ordinality <= 11 THEN 1 ELSE 0 END::smallint,
      player.ordinality = 1, player.ordinality = 2,
      CASE WHEN player.ordinality = 1 THEN 0 ELSE NULL END::integer,
      CASE WHEN player.ordinality = 1 THEN 0 ELSE NULL END::integer,
      ${CAPTURE_NOW.toISOString()}::timestamptz,
      ${CAPTURE_NOW.toISOString()}::timestamptz,
      ${TEAM_ID}
    FROM unnest(${PLAYER_IDS}::integer[])
      WITH ORDINALITY AS player(element_id, ordinality)
  `;
  await sql`
    UPDATE competition.entries
    SET transfers_synced_through_event_id = ${EVENT_ID},
        transfers_source_checked_at = ${CAPTURE_NOW.toISOString()}::timestamptz
    WHERE season_id = ${SEASON.seasonId} AND entry_id = ${entryId}
  `;
  const entryInput = entryLiveInputFromFplPicks(
    SEASON,
    EVENT_ID,
    entryId,
    {
      active_chip: null,
      automatic_subs: [],
      entry_history: {
        event: EVENT_ID,
        points: 67,
        total_points: 67,
        rank: 1,
        overall_rank: 1_000,
        bank: 10,
        value: 1_000,
        event_transfers: 0,
        event_transfers_cost: 0,
        points_on_bench: 0,
      },
      picks: EVENT_PICKS,
    },
    CAPTURE_NOW,
  );
  await publishEntryLiveInputV2({
    season: SEASON.seasonCode,
    eventId: EVENT_ID,
    entryId,
    input: entryInput,
    sourceCheckedAt: CAPTURE_NOW,
    generationFloor: 0,
  });
}

beforeAll(async () => {
  await seedBase();
});
afterAll(async () => {
  await cleanup();
});

describe('My FPL onboarding publication correction', () => {
  test('keeps the old active revision until all new-entry data is complete', async () => {
    const sql = await getDbClient();
    await seedEntry(ENTRY_IDS[0], true);
    // The source publisher may have no pending desired pointer yet. The first
    // audit must reconstruct that obligation; once the exact durable head is
    // fenced, a later audit should be a marker-only idempotent success.
    expect(await checkpointEntryLiveInputV2(SEASON, EVENT_ID, ENTRY_IDS[0])).toBe('checkpointed');
    expect(await checkpointEntryLiveInputV2(SEASON, EVENT_ID, ENTRY_IDS[0])).toBe('checkpointed');

    // A previous fallback is not proof that the current active generation was
    // durably checkpointed. Publish a newer, uncheckpointed generation so the
    // previous pointer is a valid but older checkpointed fallback.
    const currentEntry = await readEntryLiveInputV2({
      season: SEASON.seasonCode,
      eventId: EVENT_ID,
      entryId: ENTRY_IDS[0],
    });
    expect(currentEntry).not.toBeNull();
    expect(await isEntryPublicationActiveAndCheckpointedV2(currentEntry!.publication)).toBe(true);
    await publishEntryLiveInputV2({
      season: SEASON.seasonCode,
      eventId: EVENT_ID,
      entryId: ENTRY_IDS[0],
      input: currentEntry!.input,
      sourceCheckedAt: CAPTURE_NOW,
      generationFloor: currentEntry!.publication.generation,
    });
    expect(await isEntryPublicationActiveAndCheckpointedV2(currentEntry!.publication)).toBe(false);
    // Removing only the active pointer must therefore stay recoverable/missing
    // instead of taking the marker-only fast path from the older publication.
    const checkpointCache = await redisSingleton.getClient();
    await checkpointCache.unlink(
      entryLiveV2Key(
        { season: SEASON.seasonCode, eventId: EVENT_ID, entryId: ENTRY_IDS[0] },
        'active',
      ),
    );
    expect(await checkpointEntryLiveInputV2(SEASON, EVENT_ID, ENTRY_IDS[0])).toBe('missing');
    const first = await captureMyFplSnapshot(SEASON, EVENT_ID, 'PROVISIONAL', {
      snapshotDate: SNAPSHOT_DATE,
      now: CAPTURE_NOW,
    });
    expect(first).toMatchObject({
      status: 'published',
      publication: { expectedEntryCount: 1, readyEntryCount: 1 },
    });

    await seedEntry(ENTRY_IDS[1], false);
    const pendingStatus = (await auditMyFplSnapshotIntegrity(SEASON)).find(
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
      SET overall_rank = 1001
      WHERE season_id = ${SEASON.seasonId} AND entry_id = ${ENTRY_IDS[0]}
    `;
    await sql`
      UPDATE competition.entry_event_results
      SET overall_rank = 1001
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

    const completeStatus = (await auditMyFplSnapshotIntegrity(SEASON)).find(
      (row) => row.eventId === EVENT_ID,
    );
    expect(completeStatus).toMatchObject({
      currentEntryCount: 2,
      pendingCorrectionEntryCount: 0,
      coverageState: 'COMPLETE',
    });

    // A late entrant can move from the eligible scope to the future-start
    // scope without changing the number of source rows. The retained deep
    // diagnostic must still reject the old provisional publication.
    await sql`
      UPDATE competition.entries
      SET started_event = 2
      WHERE season_id = ${SEASON.seasonId} AND entry_id = ${ENTRY_IDS[0]}
    `;
    const futureStartStatus = (await auditMyFplSnapshotIntegrity(SEASON)).find(
      (row) => row.eventId === EVENT_ID,
    );
    expect(futureStartStatus).toMatchObject({
      pendingCorrectionEntryCount: 1,
      coverageState: 'CORRECTION_PENDING',
    });
    await sql`
      UPDATE competition.entries
      SET started_event = 1
      WHERE season_id = ${SEASON.seasonId} AND entry_id = ${ENTRY_IDS[0]}
    `;

    // Tournament membership is an independent provisional scope family. A
    // new roster row must not be hidden by matching publication counts.
    await sql`
      INSERT INTO competition.tournaments (
        tournament_id, season_id, name, creator, admin_entry_id, league_id,
        league_type, total_team_num, tournament_mode, group_mode,
        group_auto_averages, state
      ) VALUES (
        ${DRIFT_TOURNAMENT_ID}, ${SEASON.seasonId}, 'Drift Tournament',
        'integration-test', ${ENTRY_IDS[0]}, ${DRIFT_LEAGUE_ID}, 'classic', 1,
        'normal', 'no_group', false, 'active'
      )
    `;
    await sql`
      INSERT INTO competition.tournament_entries (
        tournament_id, season_id, league_id, entry_id
      ) VALUES (
        ${DRIFT_TOURNAMENT_ID}, ${SEASON.seasonId}, ${DRIFT_LEAGUE_ID}, ${ENTRY_IDS[0]}
      )
    `;
    const tournamentDriftStatus = (await auditMyFplSnapshotIntegrity(SEASON)).find(
      (row) => row.eventId === EVENT_ID,
    );
    expect(tournamentDriftStatus).toMatchObject({
      pendingCorrectionEntryCount: 1,
      coverageState: 'CORRECTION_PENDING',
    });
    await sql`
      DELETE FROM competition.tournament_entries
      WHERE season_id = ${SEASON.seasonId} AND tournament_id = ${DRIFT_TOURNAMENT_ID}
    `;
    await sql`
      DELETE FROM competition.tournaments
      WHERE season_id = ${SEASON.seasonId} AND tournament_id = ${DRIFT_TOURNAMENT_ID}
    `;

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

test('historical result with no durable input or Redis pointer gains one idempotent FINAL checkpoint', async () => {
  await cleanup();
  await seedBase();
  await seedEntry(ENTRY_IDS[0], true);
  const sql = await getDbClient();
  const redis = await redisSingleton.getClient();
  const scope = { season: SEASON.seasonCode, eventId: EVENT_ID, entryId: ENTRY_IDS[0] };
  const boundary = new Date(CAPTURE_NOW.getTime() - 1000);
  await sql`UPDATE fpl.events SET finished = true, data_checked = true,
    data_checked_at = ${boundary.toISOString()}::timestamptz
    WHERE season_id = ${SEASON.seasonId} AND event_id = ${EVENT_ID}`;
  const picks = {
    active_chip: null,
    automatic_subs: [],
    picks: EVENT_PICKS,
    entry_history: {
      event: EVENT_ID,
      points: 67,
      total_points: 67,
      rank: 1,
      overall_rank: 1000,
      bank: 10,
      value: 1000,
      event_transfers: 0,
      event_transfers_cost: 0,
      points_on_bench: 0,
    },
  };
  await entryEventPicksRepository.upsertFromPicks(
    SEASON,
    ENTRY_IDS[0],
    EVENT_ID,
    picks,
    CAPTURE_NOW,
  );
  await redis.unlink(entryLiveV2Key(scope, 'active'), entryLiveV2Key(scope, 'previous'));
  const before = await entryEventPicksRepository.findHead(SEASON, ENTRY_IDS[0], EVENT_ID);
  expect(before?.inputPayload).toBeNull();
  expect(hasFinalEntryCheckpoint(SEASON, EVENT_ID, before!, boundary)).toBe(false);
  await expect(
    checkpointFinalEntryFromProviderResponse(
      SEASON,
      ENTRY_IDS[0],
      EVENT_ID,
      picks,
      CAPTURE_NOW,
      new Date(CAPTURE_NOW.getTime() + 1000),
    ),
  ).rejects.toThrow('accepted source result');
  expect(await readEntryLiveInputV2(scope)).toBeNull();
  const window = { startEventId: EVENT_ID, endEventId: EVENT_ID };
  expect((await findMissingCoreResults(SEASON, [ENTRY_IDS[0]], window)).get(EVENT_ID)).toEqual([
    ENTRY_IDS[0],
  ]);
  const adjustedPicks = {
    ...picks,
    picks: EVENT_PICKS.map((pick, index) => ({
      ...pick,
      multiplier: index === 1 ? 0 : index === 11 ? 1 : pick.multiplier,
    })),
    automatic_subs: [
      {
        entry: ENTRY_IDS[0],
        event: EVENT_ID,
        element_in: PLAYER_IDS[11]!,
        element_out: PLAYER_IDS[1]!,
      },
      {
        entry: ENTRY_IDS[0],
        event: EVENT_ID,
        element_in: PLAYER_IDS[12]!,
        element_out: PLAYER_IDS[2]!,
      },
    ],
  };
  const provider = spyOn(fplClient, 'getEntryEventPicks').mockResolvedValue(adjustedPicks);
  try {
    await syncTournamentEventResultsForEntryIds(SEASON, [ENTRY_IDS[0]], EVENT_ID, {
      skipTransfers: true,
      concurrency: 1,
      live: {
        elements: PLAYER_IDS.map((id, index) => ({
          id,
          stats: { total_points: index === 0 ? 33 : index === 1 || index === 11 ? 1 : 0 },
        })),
      },
    });
  } finally {
    provider.mockRestore();
  }
  expect((await findMissingCoreResults(SEASON, [ENTRY_IDS[0]], window)).size).toBe(0);

  const active = await readEntryLiveInputV2(scope);
  const head = await entryEventPicksRepository.findHead(SEASON, ENTRY_IDS[0], EVENT_ID);
  expect(active?.publication.state).toBe('FINAL');
  expect(active?.input.picksBase.picks[1]?.multiplier).toBe(1);
  expect(active?.input.finalResult?.picks[1]?.multiplier).toBe(0);
  const storedBase = await entryEventPicksRepository.findLiveInputPickRowsByEventAndEntryIds(
    SEASON,
    EVENT_ID,
    [ENTRY_IDS[0]],
  );
  expect(storedBase.find((row) => row.position === 2)?.multiplier).toBe(1);

  expect(active?.input.finalResult?.score).toEqual({ eventPoints: 67, totalPoints: 67 });
  expect(head?.publicationId).toBe(active?.publication.publicationId);
  expect(hasFinalEntryCheckpoint(SEASON, EVENT_ID, head!, boundary)).toBe(true);

  await checkpointFinalEntryFromProviderResponse(
    SEASON,
    ENTRY_IDS[0],
    EVENT_ID,
    picks,
    CAPTURE_NOW,
    boundary,
  );
  expect(await entryEventPicksRepository.findHead(SEASON, ENTRY_IDS[0], EVENT_ID)).toEqual(head);
  expect((await readEntryLiveInputV2(scope))?.publication).toEqual(active?.publication);
  // Independent substitutions have no semantic array order.
  await sql`UPDATE competition.entry_event_results
    SET automatic_substitutions=${JSON.stringify([...adjustedPicks.automatic_subs].reverse())}::jsonb
    WHERE season_id=${SEASON.seasonId} AND event_id=${EVENT_ID} AND entry_id=${ENTRY_IDS[0]}`;
  await checkpointFinalEntryFromProviderResponse(
    SEASON,
    ENTRY_IDS[0],
    EVENT_ID,
    picks,
    CAPTURE_NOW,
    boundary,
  );
  expect((await findMissingCoreResults(SEASON, [ENTRY_IDS[0]], window)).size).toBe(0);
  // PostgreSQL committed, but the process died before marking the Redis manifest.
  const unmarked = { ...active!.publication, checkpointedAt: null };
  await redis.set(entryLiveV2Key(scope, 'active'), JSON.stringify(unmarked), 'KEEPTTL');
  expect((await findMissingCoreResults(SEASON, [ENTRY_IDS[0]], window)).get(EVENT_ID)).toEqual([
    ENTRY_IDS[0],
  ]);
  await checkpointFinalEntryFromProviderResponse(
    SEASON,
    ENTRY_IDS[0],
    EVENT_ID,
    picks,
    CAPTURE_NOW,
    boundary,
  );
  const repaired = await readEntryLiveInputV2(scope);
  expect(repaired?.publication.publicationId).toBe(active?.publication.publicationId);
  expect(repaired?.publication.checkpointedAt).not.toBeNull();
  // A previous-only fallback must not suppress active FINAL recovery.
  await redis.set(entryLiveV2Key(scope, 'previous'), JSON.stringify(repaired!.publication));
  await redis.unlink(entryLiveV2Key(scope, 'active'));
  expect((await readEntryLiveInputV2(scope))?.servedFrom).toBe('REDIS_PREVIOUS');
  expect((await findMissingCoreResults(SEASON, [ENTRY_IDS[0]], window)).get(EVENT_ID)).toEqual([
    ENTRY_IDS[0],
  ]);
  await checkpointFinalEntryFromProviderResponse(
    SEASON,
    ENTRY_IDS[0],
    EVENT_ID,
    picks,
    CAPTURE_NOW,
    boundary,
  );
  const restored = await readEntryLiveInputV2(scope);
  expect(restored?.publication.state).toBe('FINAL');
  expect(restored?.input.finalResult?.score).toEqual({ eventPoints: 67, totalPoints: 67 });
  expect(restored?.publication.checkpointedAt).not.toBeNull();
  // A recovery attempt can stop after Redis promotion but before its durable
  // checkpoint. A retry must accept the matching immutable FINAL as progress.
  expect(await rebuildFinalEntryLiveInputsV2(SEASON, EVENT_ID, [ENTRY_IDS[0]], boundary)).toBe(1);
  expect((await findMissingCoreResults(SEASON, [ENTRY_IDS[0]], window)).size).toBe(0);
  // Cache loss followed by a fresh provisional publication cannot downgrade durable FINAL.
  await redis.unlink(entryLiveV2Key(scope, 'active'), entryLiveV2Key(scope, 'previous'));
  const provisional = { ...restored!.input, finalResult: null };
  await publishEntryLiveInputV2({
    ...scope,
    input: provisional,
    sourceCheckedAt: new Date(),
    generationFloor: restored!.publication.generation + 1,
  });
  expect((await readEntryLiveInputV2(scope))?.publication.state).toBe('PROVISIONAL');
  await checkpointFinalEntryFromProviderResponse(
    SEASON,
    ENTRY_IDS[0],
    EVENT_ID,
    picks,
    CAPTURE_NOW,
    boundary,
  );
  const afterProvisional = await readEntryLiveInputV2(scope);
  expect(afterProvisional?.publication.state).toBe('FINAL');
  expect(
    (await entryEventPicksRepository.findHead(SEASON, ENTRY_IDS[0], EVENT_ID))?.inputPayload,
  ).toMatchObject({ finalResult: restored!.input.finalResult });
  expect((await findMissingCoreResults(SEASON, [ENTRY_IDS[0]], window)).size).toBe(0);
  await sql`UPDATE competition.entry_event_results SET event_points = event_points + 1
    WHERE season_id = ${SEASON.seasonId} AND event_id = ${EVENT_ID} AND entry_id = ${ENTRY_IDS[0]}`;
  await expect(
    checkpointFinalEntryFromProviderResponse(
      SEASON,
      ENTRY_IDS[0],
      EVENT_ID,
      picks,
      CAPTURE_NOW,
      boundary,
    ),
  ).rejects.toThrow('explicit correction is required');
  expect((await findMissingCoreResults(SEASON, [ENTRY_IDS[0]], window)).get(EVENT_ID)).toEqual([
    ENTRY_IDS[0],
  ]);
  expect((await readEntryLiveInputV2(scope))?.publication.publicationId).toBe(
    afterProvisional?.publication.publicationId,
  );
  await sql`UPDATE fpl.events SET finished = false, data_checked = false, data_checked_at = null
    WHERE season_id = ${SEASON.seasonId} AND event_id = ${EVENT_ID}`;
  const finalizeDuringFetch = spyOn(fplClient, 'getEntryEventPicks').mockImplementation(
    async () => {
      await sql`UPDATE fpl.events SET finished = true, data_checked = true, data_checked_at = clock_timestamp()
      WHERE season_id = ${SEASON.seasonId} AND event_id = ${EVENT_ID}`;
      return adjustedPicks;
    },
  );
  try {
    for (const alreadyFinalized of [false, true]) {
      await sql`UPDATE fpl.events SET finished=${alreadyFinalized}, data_checked=${alreadyFinalized}, data_checked_at=${alreadyFinalized ? boundary.toISOString() : null}::timestamptz
        WHERE season_id=${SEASON.seasonId} AND event_id=${EVENT_ID}`;
      const syncAttempt = syncTournamentEventResultsForEntryIds(SEASON, [ENTRY_IDS[0]], EVENT_ID, {
        skipTransfers: true,
        concurrency: 1,
        live: {
          elements: PLAYER_IDS.map((id, index) => ({
            id,
            stats: { total_points: index === 0 ? 33 : index === 1 || index === 11 ? 1 : 0 },
          })),
        },
      });
      await expect(syncAttempt).rejects.toThrow(
        alreadyFinalized
          ? 'finalization boundary changed'
          : 'Event finalized during historical sync',
      );
    }
  } finally {
    finalizeDuringFetch.mockRestore();
  }

  await sql`UPDATE fpl.events SET finished=true,data_checked=true,data_checked_at=${boundary.toISOString()}::timestamptz
    WHERE season_id=${SEASON.seasonId} AND event_id=${EVENT_ID}`;
  const reopenDuringFetch = spyOn(fplClient, 'getEntryEventPicks').mockImplementation(async () => {
    await sql`UPDATE fpl.events SET finished=false, data_checked=false, data_checked_at=null
        WHERE season_id=${SEASON.seasonId} AND event_id=${EVENT_ID}`;
    return adjustedPicks;
  });
  try {
    await expect(
      syncTournamentEventResultsForEntryIds(SEASON, [ENTRY_IDS[0]], EVENT_ID, {
        skipTransfers: true,
        concurrency: 1,
        live: {
          elements: PLAYER_IDS.map((id, index) => ({
            id,
            stats: { total_points: index === 0 ? 33 : index === 1 || index === 11 ? 1 : 0 },
          })),
        },
      }),
    ).rejects.toThrow('Event finalization boundary changed');
  } finally {
    reopenDuringFetch.mockRestore();
  }
});

test('cache-only historical FINAL recovery skips the provider for a complete durable head', async () => {
  await cleanup();
  await seedBase();
  await seedEntry(ENTRY_IDS[0], true);
  const sql = await getDbClient();
  const redis = await redisSingleton.getClient();
  const scope = { season: SEASON.seasonCode, eventId: EVENT_ID, entryId: ENTRY_IDS[0] };
  const boundary = new Date(CAPTURE_NOW.getTime() - 1000);
  await sql`UPDATE fpl.events SET finished=true, data_checked=true,
    data_checked_at=${boundary.toISOString()}::timestamptz
    WHERE season_id=${SEASON.seasonId} AND event_id=${EVENT_ID}`;
  const picks = {
    active_chip: null,
    automatic_subs: [],
    picks: EVENT_PICKS,
    entry_history: {
      event: EVENT_ID,
      points: 67,
      total_points: 67,
      rank: 1,
      overall_rank: 1000,
      bank: 10,
      value: 1000,
      event_transfers: 0,
      event_transfers_cost: 0,
      points_on_bench: 0,
    },
  };
  expect(await checkpointEntryLiveInputV2(SEASON, EVENT_ID, ENTRY_IDS[0])).toBe('checkpointed');
  await checkpointFinalEntryFromProviderResponse(
    SEASON,
    ENTRY_IDS[0],
    EVENT_ID,
    picks,
    CAPTURE_NOW,
    boundary,
  );
  await redis.unlink(entryLiveV2Key(scope, 'active'), entryLiveV2Key(scope, 'previous'));

  const providerUnavailable = spyOn(fplClient, 'getEntryEventPicks').mockRejectedValue(
    new Error('historical provider unavailable'),
  );
  try {
    await syncTournamentEventResultsForEntryIds(SEASON, [ENTRY_IDS[0]], EVENT_ID, {
      skipTransfers: true,
      concurrency: 1,
      finalizationRecoveryEntryIds: new Set([ENTRY_IDS[0]]),
    });
  } finally {
    providerUnavailable.mockRestore();
  }
  expect(providerUnavailable).not.toHaveBeenCalled();
  expect((await readEntryLiveInputV2(scope))?.publication.state).toBe('FINAL');
  expect(
    (await findMissingCoreResults(SEASON, [ENTRY_IDS[0]], { startEventId: 1, endEventId: 1 })).size,
  ).toBe(0);
});

test('historical manager input uses a verified FINAL global checkpoint when Redis serves a previous provisional observation', async () => {
  await cleanup();
  await seedBase();
  await seedEntry(ENTRY_IDS[0], true);
  const sql = await getDbClient();
  const redis = await redisSingleton.getClient();
  const observedAt = new Date();
  const boundary = new Date(observedAt.getTime() - 1000);
  await sql`UPDATE fpl.events SET finished=true,data_checked=true,data_checked_at=${boundary.toISOString()}::timestamptz WHERE season_id=${SEASON.seasonId} AND event_id=${EVENT_ID}`;
  await sql`UPDATE competition.entry_event_results SET event_points=67, overall_points=67,
    rich_synced_at=${observedAt.toISOString()}::timestamptz WHERE season_id=${SEASON.seasonId} AND entry_id=${ENTRY_IDS[0]} AND event_id=${EVENT_ID}`;
  const previousGlobal = await readLivePublicationV2({
    season: SEASON.seasonCode,
    eventId: EVENT_ID,
  });
  await publishLivePublicationV2({
    season: SEASON.seasonCode,
    eventId: EVENT_ID,
    state: 'FINALIZED',
    sourceCheckedAt: observedAt,
    eventLives: liveRows,
    fixtures: [],
  });
  const durable = await readLivePublicationV2({ season: SEASON.seasonCode, eventId: EVENT_ID });
  expect(durable?.publication.state).toBe('FINALIZED');
  const scope = { season: SEASON.seasonCode, eventId: EVENT_ID, entryId: ENTRY_IDS[0] };
  await redis.unlink(
    liveV2Key(scope, 'active'),
    liveV2Key(scope, 'previous'),
    entryLiveV2Key(scope, 'active'),
    entryLiveV2Key(scope, 'previous'),
  );
  await redis.set(liveV2Key(scope, 'previous'), JSON.stringify(previousGlobal!.publication));
  expect((await readLivePublicationV2(scope))?.servedFrom).toBe('REDIS_PREVIOUS');
  const checkpoint = spyOn(globalCheckpoints, 'readLivePublicationV2Checkpoint').mockResolvedValue(
    durable,
  );
  const picks = {
    active_chip: 'manager',
    automatic_subs: [],
    picks: EVENT_PICKS,
    entry_history: {
      event: EVENT_ID,
      points: 72,
      total_points: 72,
      rank: 1,
      overall_rank: 1000,
      bank: 10,
      value: 1000,
      event_transfers: 0,
      event_transfers_cost: 0,
      points_on_bench: 0,
    },
  };
  const providerLive = {
    elements: liveRows.map((row) => ({
      id: row.elementId,
      stats: { total_points: row.totalPoints },
    })),
  } as unknown as RawFPLEventLiveResponse;
  const provider = spyOn(fplClient, 'getEntryEventPicks').mockResolvedValue(picks);
  const redundantLive = spyOn(fplClient, 'getEventLive').mockRejectedValue(
    new Error('must reuse event payload'),
  );
  try {
    await syncTournamentEventResultsForEntryIds(SEASON, [ENTRY_IDS[0]], EVENT_ID, {
      skipTransfers: true,
      concurrency: 1,
      live: providerLive,
    });
    expect(redundantLive).not.toHaveBeenCalled();
    const [result] =
      await sql`SELECT event_points,overall_points FROM competition.entry_event_results WHERE season_id=${SEASON.seasonId} AND entry_id=${ENTRY_IDS[0]} AND event_id=${EVENT_ID}`;
    expect(result).toEqual({ event_points: 72, overall_points: 72 });
    const final = await readEntryLiveInputV2(scope);
    expect(final?.publication.state).toBe('FINAL');
    expect(final?.input.finalResult?.score).toEqual({ eventPoints: 72, totalPoints: 72 });
    expect(final?.input.picksBase.assistantManagerPoints?.points).toBe(5);
    expect(final?.input.picksBase.assistantManagerPoints?.livePublicationId).toBe(
      durable?.publication.publicationId,
    );
    expect(checkpoint).toHaveBeenCalledTimes(1);
  } finally {
    checkpoint.mockRestore();
    provider.mockRestore();
    redundantLive.mockRestore();
  }
});

test('historical recovery preserves a durable provisional base and advances an older FINAL fence', async () => {
  await cleanup();
  await seedBase();
  await seedEntry(ENTRY_IDS[0], true);
  const sql = await getDbClient();
  const redis = await redisSingleton.getClient();
  const scope = { season: SEASON.seasonCode, eventId: EVENT_ID, entryId: ENTRY_IDS[0] };
  const boundary = new Date(CAPTURE_NOW.getTime() - 1000);
  await sql`UPDATE fpl.events SET finished=true,data_checked=true,data_checked_at=${boundary.toISOString()}::timestamptz WHERE season_id=${SEASON.seasonId} AND event_id=${EVENT_ID}`;
  await checkpointEntryLiveInputV2(SEASON, EVENT_ID, ENTRY_IDS[0]);
  const durable = await readEntryLiveInputV2(scope);
  const head = await entryEventPicksRepository.findHead(SEASON, ENTRY_IDS[0], EVENT_ID);
  const picks = {
    active_chip: null,
    automatic_subs: [],
    picks: EVENT_PICKS,
    entry_history: {
      event: EVENT_ID,
      points: 67,
      total_points: 67,
      rank: 1,
      overall_rank: 1000,
      bank: 10,
      value: 1000,
      event_transfers: 0,
      event_transfers_cost: 0,
      points_on_bench: 0,
    },
  };
  await redis.unlink(entryLiveV2Key(scope, 'active'), entryLiveV2Key(scope, 'previous'));
  const adjusted = entryLiveInputFromFplPicks(
    SEASON,
    EVENT_ID,
    ENTRY_IDS[0],
    {
      ...picks,
      picks: EVENT_PICKS.map((p, i) => ({
        ...p,
        multiplier: i === 1 ? 0 : i === 11 ? 1 : p.multiplier,
      })),
    },
    CAPTURE_NOW,
  );
  await publishEntryLiveInputV2({
    ...scope,
    input: adjusted,
    sourceCheckedAt: CAPTURE_NOW,
    generationFloor: head!.generation,
  });
  await checkpointFinalEntryFromProviderResponse(
    SEASON,
    ENTRY_IDS[0],
    EVENT_ID,
    picks,
    CAPTURE_NOW,
    boundary,
  );
  const first = await readEntryLiveInputV2(scope);
  expect(first?.input.picksBase).toEqual(durable!.input.picksBase);
  expect(first?.publication.state).toBe('FINAL');
  const supersededFinalItemKey = first!.publication.item.key;
  const advanced = new Date();
  const observed = new Date(advanced.getTime() + 1);
  await sql`UPDATE fpl.events SET data_checked_at=${advanced.toISOString()}::timestamptz WHERE season_id=${SEASON.seasonId} AND event_id=${EVENT_ID}`;
  await sql`UPDATE competition.entry_event_results SET rich_synced_at=${observed.toISOString()}::timestamptz WHERE season_id=${SEASON.seasonId} AND event_id=${EVENT_ID} AND entry_id=${ENTRY_IDS[0]}`;
  await checkpointFinalEntryFromProviderResponse(
    SEASON,
    ENTRY_IDS[0],
    EVENT_ID,
    picks,
    observed,
    advanced,
  );
  const refreshed = await readEntryLiveInputV2(scope);
  expect(refreshed?.publication.generation).toBeGreaterThan(first!.publication.generation);
  expect(refreshed?.input.picksBase).toEqual(durable!.input.picksBase);
  expect(refreshed?.input.finalResult?.score).toEqual(first!.input.finalResult!.score);
  const correctedPrevious = await redis.get(entryLiveV2Key(scope, 'previous'));
  expect(correctedPrevious).not.toBeNull();
  expect(JSON.parse(correctedPrevious!).publicationId).toBe(refreshed?.publication.publicationId);
  expect(await redis.exists(supersededFinalItemKey)).toBe(0);
  expect(await redis.exists(`${supersededFinalItemKey}:meta`)).toBe(0);
  expect(
    hasFinalEntryCheckpoint(
      SEASON,
      EVENT_ID,
      (await entryEventPicksRepository.findHead(SEASON, ENTRY_IDS[0], EVENT_ID))!,
      advanced,
    ),
  ).toBe(true);
  expect(
    (
      await findMissingCoreResults(SEASON, [ENTRY_IDS[0]], {
        startEventId: EVENT_ID,
        endEventId: EVENT_ID,
      })
    ).size,
  ).toBe(0);
  const currentFinal = await readEntryLiveInputV2(scope);
  expect(currentFinal?.publication.state).toBe('FINAL');
  const currentSource = currentFinal!.publication.sourceCheckedAt;
  const currentDate = new Date(currentSource);
  const exactCorrectionBoundary = `${currentSource.slice(0, 19)}.${String(
    currentDate.getUTCMilliseconds(),
  ).padStart(3, '0')}500Z`;
  const microsecondAdvance = await publishEntryLiveInputV2({
    ...scope,
    input: currentFinal!.input,
    sourceCheckedAt: new Date(currentDate.getTime() + 1).toISOString(),
    generationFloor: currentFinal!.publication.generation,
    finalizationCorrectionBoundary: exactCorrectionBoundary,
  });
  expect(microsecondAdvance.published).toBe(true);
  const microsecondPrevious = await redis.get(entryLiveV2Key(scope, 'previous'));
  expect(microsecondPrevious).not.toBeNull();
  expect(JSON.parse(microsecondPrevious!).publicationId).toBe(
    microsecondAdvance.publication.publicationId,
  );
  const refused = await publishEntryLiveInputV2({
    ...scope,
    input: adjusted,
    sourceCheckedAt: new Date(observed.getTime() + 1000),
    generationFloor: microsecondAdvance.publication.generation,
    finalizationCorrectionBoundary: new Date(observed.getTime() + 500),
  });
  expect(refused.published).toBe(false);
  expect((await readEntryLiveInputV2(scope))?.publication.publicationId).toBe(
    microsecondAdvance.publication.publicationId,
  );
});
