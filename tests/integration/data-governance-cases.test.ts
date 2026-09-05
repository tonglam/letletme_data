import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import { getDbClient } from '../../src/db/singleton';
import { explicitSeasonRef } from '../../src/domain/fpl-season';
import {
  listGovernanceCases,
  listQueueHealthWindows,
  markFreshnessWindowNotApplicable,
  openGovernanceCase,
  recordPendingLiveSnapshotCheckpointEvidence,
  retireLivePicksEmptyCohortFreshnessWindow,
  retirePublicTrendsIneligibleFreshnessWindow,
  settleLivePicksNoSourceWorkFreshnessWindow,
  settlePublicTrendsReusedFreshnessWindow,
  upsertFreshnessWindow,
  transitionGovernanceCase,
} from '../../src/services/data-governance.service';
import { persistLivePicksDurableFreshnessEvidence } from '../../src/services/live-lifecycle-orchestrator';
import {
  readPublicTrendFreshnessEvidence,
  updatePublicTrendsCatalog,
} from '../../src/services/trends-catalog.service';

const SCOPE_KEY = 'integration:governance-case-cas';
const FINGERPRINT = 'integration:governance-case-cas:v1';
const WINDOW_SLO_KEY = 'integration:consumer-evidence-freeze';
const WINDOW_SCOPE_KEY = 'integration:consumer-evidence-freeze';
const NO_SOURCE_FINGERPRINT = 'integration:live-picks-no-source-work:breach';
const NO_SOURCE_SEASON_ID = 2097;
const PUBLIC_TRENDS_SLO_KEY = 'integration:public-trends-reused';
const PUBLIC_TRENDS_SCOPE_KEY = 'integration:public-trends-reused';
const PUBLIC_TRENDS_FINGERPRINT = 'integration:public-trends-reused:breach';
const PUBLIC_TRENDS_INELIGIBLE_FINGERPRINT = 'integration:public-trends-ineligible:breach';
const PUBLIC_TRENDS_TOURNAMENT_IDS = [990_431, 990_432] as const;
const PUBLIC_TRENDS_ENTRY_IDS = [990_431, 990_432] as const;
const LIVE_CHECKPOINT_SEASON_ID = 2096;
const LIVE_CHECKPOINT_SEASON_CODE = '9697';
const LIVE_CHECKPOINT_SLO_KEY = 'integration:live-checkpoint-ordering';
const LIVE_CHECKPOINT_SCOPE_KEY = 'integration:live-checkpoint-ordering';
const EMPTY_COHORT_SLO_KEY = 'integration:live-picks-empty-cohort';
const EMPTY_COHORT_SCOPE_KEY = 'integration:live-picks-empty-cohort';
const EMPTY_COHORT_FINGERPRINT = 'integration:live-picks-empty-cohort:breach';
const EMPTY_COHORT_SEASON_ID = 2098;
const EMPTY_COHORT_ENTRY_ID = 990_433;
const LEGACY_QUEUE_EVIDENCE_NAME = 'integration-legacy-pause-evidence';

async function cleanup(): Promise<void> {
  const sql = await getDbClient();
  await sql`
    DELETE FROM ops.queue_health_windows
    WHERE queue_name = ${LEGACY_QUEUE_EVIDENCE_NAME}
  `;
  await sql`
    DELETE FROM ops.data_governance_cases
    WHERE (scope_key = ${SCOPE_KEY} AND fingerprint = ${FINGERPRINT})
       OR (scope_key = ${WINDOW_SCOPE_KEY} AND fingerprint = ${NO_SOURCE_FINGERPRINT})
       OR (scope_key = ${PUBLIC_TRENDS_SCOPE_KEY} AND fingerprint = ${PUBLIC_TRENDS_FINGERPRINT})
       OR (scope_key = ${PUBLIC_TRENDS_SCOPE_KEY} AND fingerprint = ${PUBLIC_TRENDS_INELIGIBLE_FINGERPRINT})
       OR (scope_key = ${EMPTY_COHORT_SCOPE_KEY} AND fingerprint = ${EMPTY_COHORT_FINGERPRINT})
  `;
  await sql`
    DELETE FROM ops.freshness_slo_windows
    WHERE (slo_key = ${WINDOW_SLO_KEY} AND scope_key = ${WINDOW_SCOPE_KEY})
       OR (slo_key = ${PUBLIC_TRENDS_SLO_KEY} AND scope_key = ${PUBLIC_TRENDS_SCOPE_KEY})
       OR (slo_key = ${LIVE_CHECKPOINT_SLO_KEY} AND scope_key = ${LIVE_CHECKPOINT_SCOPE_KEY})
       OR (slo_key = ${EMPTY_COHORT_SLO_KEY} AND scope_key = ${EMPTY_COHORT_SCOPE_KEY})
  `;
  await sql`
    DELETE FROM competition.live_points_publication_checkpoints
    WHERE season_id = ${LIVE_CHECKPOINT_SEASON_ID}
  `;
  await sql`
    DELETE FROM reporting.tournament_selection_stat_publications
    WHERE season_id = ${NO_SOURCE_SEASON_ID}
  `;
  await sql`
    DELETE FROM competition.public_league_trends
    WHERE season_id = ${NO_SOURCE_SEASON_ID}
  `;
  await sql`
    DELETE FROM competition.tournaments
    WHERE season_id = ${NO_SOURCE_SEASON_ID}
      AND tournament_id = ANY(${[...PUBLIC_TRENDS_TOURNAMENT_IDS]}::integer[])
  `;
  await sql`
    DELETE FROM competition.entries
    WHERE (season_id = ${EMPTY_COHORT_SEASON_ID} AND entry_id = ${EMPTY_COHORT_ENTRY_ID})
       OR (season_id = ${NO_SOURCE_SEASON_ID} AND entry_id = ANY(${[...PUBLIC_TRENDS_ENTRY_IDS]}::integer[]))
  `;
  await sql`
    DELETE FROM fpl.events
    WHERE season_id IN (${NO_SOURCE_SEASON_ID}, ${LIVE_CHECKPOINT_SEASON_ID})
  `;
  await sql`
    DELETE FROM fpl.seasons
    WHERE season_id IN (
      ${NO_SOURCE_SEASON_ID}, ${EMPTY_COHORT_SEASON_ID}, ${LIVE_CHECKPOINT_SEASON_ID}
    )
  `;
}

beforeEach(cleanup);
afterAll(cleanup);

async function seedPublicTrendsEvidence() {
  const sql = await getDbClient();
  await sql`
    INSERT INTO fpl.seasons (
      season_id, season_code, display_name, start_year, end_year, lifecycle_state, is_current
    )
    VALUES (
      ${NO_SOURCE_SEASON_ID}, '9798', 'Public Trends governance integration',
      ${NO_SOURCE_SEASON_ID}, ${NO_SOURCE_SEASON_ID + 1}, 'completed', false
    )
  `;
  await sql`
    INSERT INTO competition.entries (season_id, entry_id, entry_name, player_name)
    SELECT ${NO_SOURCE_SEASON_ID}, entry_id,
      'Trends entry ' || entry_id::text,
      'Trends manager ' || entry_id::text
    FROM unnest(${[...PUBLIC_TRENDS_ENTRY_IDS]}::integer[]) AS entry_ids(entry_id)
  `;
  await sql`
    INSERT INTO fpl.events (season_id, event_id, name, is_current)
    VALUES (${NO_SOURCE_SEASON_ID}, 3, 'Gameweek 3', true)
  `;
  await sql`
    INSERT INTO competition.tournaments (
      tournament_id, season_id, name, creator, admin_entry_id, league_id,
      league_type, total_team_num, tournament_mode, group_mode,
      group_auto_averages, state, setup_status
    )
    SELECT tournament_id, ${NO_SOURCE_SEASON_ID},
      'Trends tournament ' || tournament_id::text,
      'integration-test', entry_id, tournament_id,
      'classic', 1, 'normal', 'no_group', false, 'active', 'ready'
    FROM unnest(
      ${[...PUBLIC_TRENDS_TOURNAMENT_IDS]}::integer[],
      ${[...PUBLIC_TRENDS_ENTRY_IDS]}::integer[]
    ) AS roster(tournament_id, entry_id)
  `;
  await sql`
    INSERT INTO competition.public_league_trends (
      season_id, tournament_id, display_name, sort_order, enabled
    )
    SELECT ${NO_SOURCE_SEASON_ID}, tournament_id,
      'Public cohort ' || tournament_id::text,
      ordinal::integer,
      true
    FROM unnest(${[...PUBLIC_TRENDS_TOURNAMENT_IDS]}::integer[]) WITH ORDINALITY
      AS catalog(tournament_id, ordinal)
  `;
  const publications = await sql<Array<{ publicationId: number; tournamentId: number }>>`
    INSERT INTO reporting.tournament_selection_stat_publications (
      season_id, tournament_id, event_id, revision, publication_state, is_active,
      source_watermark, source_checksum, expected_entries, complete_pick_entries,
      transfer_checkpoint_entries, ownership_state, captaincy_state,
      vice_captaincy_state, transfers_state, published_at
    )
    SELECT ${NO_SOURCE_SEASON_ID}, tournament_id, 3, 1, 'READY', true,
      '2026-09-05T00:01:00.000Z'::timestamptz,
      repeat('a', 64), 1, 1, 1,
      'READY', 'READY', 'READY', 'READY',
      '2026-09-05T00:02:00.000Z'::timestamptz
    FROM unnest(${[...PUBLIC_TRENDS_TOURNAMENT_IDS]}::integer[]) AS ids(tournament_id)
    RETURNING publication_id AS "publicationId", tournament_id AS "tournamentId"
  `;
  await sql`
    INSERT INTO reporting.tournament_selection_stat_rows (
      publication_id, element_id, selected_count, effective_selection_count,
      captain_count, vice_captain_count, transfer_in_count, transfer_out_count,
      player_name, player_position, team_short_name
    )
    SELECT publication_id, tournament_id, 1, 1, 1, 0, 0, 0,
      'Integration player', 1, 'INT'
    FROM unnest(
      ${publications.map((row) => row.publicationId)}::bigint[],
      ${publications.map((row) => row.tournamentId)}::integer[]
    ) AS publication_rows(publication_id, tournament_id)
  `;
  return readPublicTrendFreshnessEvidence('9798', 3);
}

describe('data governance case CAS', () => {
  test('uses the exact PostgreSQL timestamp token for operator actions', async () => {
    const inserted = await openGovernanceCase({
      caseKind: 'scheduler-failure',
      contractKey: 'housekeeping',
      lane: 'housekeeping',
      scopeKey: SCOPE_KEY,
      errorClass: 'TRANSIENT_INFRA',
      errorCode: 'INTEGRATION_CAS',
      fingerprint: FINGERPRINT,
      compensator: 'integration test',
    });
    expect(inserted).not.toBeNull();

    const raw = await getDbClient();
    const [rawRow] = await raw<{ updatedAt: string }[]>`
      SELECT updated_at::text AS "updatedAt"
      FROM ops.data_governance_cases
      WHERE scope_key = ${SCOPE_KEY} AND fingerprint = ${FINGERPRINT}
    `;
    // PostgreSQL preserves the exact text token used by the CAS predicate;
    // the server may expose milliseconds or microseconds depending on the
    // configured timestamp precision, so do not couple the test to a scale.
    expect(rawRow?.updatedAt).toMatch(/\.\d+\+\d{2}$/);

    const [listed] = await listGovernanceCases({ status: 'OPEN', limit: 10 });
    expect(listed?.scopeKey).toBe(SCOPE_KEY);
    expect(typeof listed?.updatedAt).toBe('string');
    expect(
      await transitionGovernanceCase({
        caseId: listed!.caseId,
        expectedUpdatedAt: listed!.updatedAt,
        action: 'dry-run',
      }),
    ).toBe(true);

    // The old token is fenced after the state transition; only the exact
    // microsecond-preserving token returned by the next read can proceed.
    expect(
      await transitionGovernanceCase({
        caseId: listed!.caseId,
        expectedUpdatedAt: listed!.updatedAt,
        action: 'dismiss',
      }),
    ).toBe(false);
    const [reviewed] = await listGovernanceCases({ status: 'REQUIRES_REVIEW', limit: 10 });
    expect(reviewed?.scopeKey).toBe(SCOPE_KEY);
    expect(
      await transitionGovernanceCase({
        caseId: reviewed!.caseId,
        expectedUpdatedAt: reviewed!.updatedAt,
        action: 'dismiss',
      }),
    ).toBe(true);
  });

  test('freezes freshness reservation policies on re-reservation', async () => {
    const base = {
      sloKey: WINDOW_SLO_KEY,
      contractKey: 'my-fpl',
      scopeKey: WINDOW_SCOPE_KEY,
      periodKey: 'freeze-v1',
      eligibleAt: new Date('2026-08-28T00:00:00.000Z'),
      dueAt: new Date('2026-08-28T00:15:00.000Z'),
    } as const;

    await upsertFreshnessWindow({
      ...base,
      evidence: {
        consumerEvidenceRequired: false,
        redisEvidenceRequired: false,
        freshnessPublicationMustFollowEligibility: false,
      },
    });
    await upsertFreshnessWindow({
      ...base,
      evidence: {
        consumerEvidenceRequired: true,
        redisEvidenceRequired: true,
        freshnessPublicationMustFollowEligibility: true,
      },
    });

    const sql = await getDbClient();
    const [row] = await sql<Array<{ consumer: boolean; redis: boolean; publication: boolean }>>`
      SELECT
        (evidence ->> 'consumerEvidenceRequired')::boolean AS consumer,
        (evidence ->> 'redisEvidenceRequired')::boolean AS redis,
        (evidence ->> 'freshnessPublicationMustFollowEligibility')::boolean AS publication
      FROM ops.freshness_slo_windows
      WHERE slo_key = ${WINDOW_SLO_KEY}
        AND scope_key = ${WINDOW_SCOPE_KEY}
        AND period_key = 'freeze-v1'
    `;
    expect(row).toEqual({ consumer: false, redis: true, publication: false });
  });

  test('keeps legacy queue pause evidence unknown in raw and hourly history', async () => {
    const sql = await getDbClient();
    const legacyAt = new Date('2096-09-05T00:00:00.000Z');
    const explicitAt = new Date('2096-09-05T01:00:00.000Z');
    await sql`
      INSERT INTO ops.queue_health_windows (window_start, queue_name)
      VALUES (${legacyAt.toISOString()}, ${LEGACY_QUEUE_EVIDENCE_NAME})
    `;
    await sql`
      INSERT INTO ops.queue_health_windows (
        window_start, queue_name, consumer_paused, paused_count, pause_owner_state
      )
      VALUES (${explicitAt.toISOString()}, ${LEGACY_QUEUE_EVIDENCE_NAME}, true, 2, 'OPERATOR')
    `;

    const raw = (await listQueueHealthWindows({ since: legacyAt, limit: 10 })).filter(
      (item) => item.queueName === LEGACY_QUEUE_EVIDENCE_NAME,
    );
    expect(raw).toHaveLength(2);
    expect(raw[1]).toMatchObject({
      consumerPaused: null,
      pausedCount: null,
      pauseOwnerState: null,
    });

    const hourly = (
      await listQueueHealthWindows({
        since: legacyAt,
        limit: 10,
        bucket: 'hour',
      })
    ).filter((item) => item.queueName === LEGACY_QUEUE_EVIDENCE_NAME);
    expect(hourly).toHaveLength(2);
    expect(hourly[1]).toMatchObject({
      consumerPaused: null,
      pausedCount: null,
      pauseOwnerState: null,
    });
    expect(hourly[0]).toMatchObject({
      consumerPaused: true,
      pausedCount: 2,
      pauseOwnerState: 'OPERATOR',
    });
  });

  test('enables a Trends cohort only from the canonical current event', async () => {
    const sql = await getDbClient();
    await seedPublicTrendsEvidence();
    const tournamentId = PUBLIC_TRENDS_TOURNAMENT_IDS[0];
    await sql`
      UPDATE competition.public_league_trends
      SET enabled = false
      WHERE season_id = ${NO_SOURCE_SEASON_ID} AND tournament_id = ${tournamentId}
    `;
    const enabled = await updatePublicTrendsCatalog('9798', tournamentId, { enabled: true });
    expect(enabled).toMatchObject({ tournamentId, enabled: true });
  });

  test('drains a coalesced live checkpoint backlog without trusting a mutable heartbeat', async () => {
    const sql = await getDbClient();
    const publicationA = '00000000-0000-4000-8000-000000000111';
    const publicationB = '00000000-0000-4000-8000-000000000222';
    const revisionA = `${publicationA}:1`;
    const revisionB = `${publicationB}:2`;
    const sourceA = new Date('2026-09-05T00:00:00.000Z');
    const checkpointA = new Date('2026-09-05T00:01:00.000Z');
    const sourceB = new Date('2026-09-05T00:02:00.000Z');
    const checkpointB = new Date('2026-09-05T00:03:00.000Z');
    await sql`
      INSERT INTO fpl.seasons (
        season_id, season_code, display_name, start_year, end_year, lifecycle_state, is_current
      )
      VALUES (
        ${LIVE_CHECKPOINT_SEASON_ID}, ${LIVE_CHECKPOINT_SEASON_CODE},
        'Live checkpoint ordering integration', ${LIVE_CHECKPOINT_SEASON_ID},
        ${LIVE_CHECKPOINT_SEASON_ID + 1}, 'completed', false
      )
    `;
    await sql`
      INSERT INTO fpl.events (season_id, event_id, name)
      VALUES (${LIVE_CHECKPOINT_SEASON_ID}, 3, 'Gameweek 3')
    `;
    await sql`
      INSERT INTO competition.live_points_publication_checkpoints (
        season_id, event_id, publication_id, generation, state,
        source_checked_at, published_at, checkpointed_at, revisions,
        event_live, fixtures, event_live_bytes, fixtures_bytes,
        event_live_sha256, fixtures_sha256, event_live_count, fixtures_count
      )
      VALUES (
        ${LIVE_CHECKPOINT_SEASON_ID}, 3, ${publicationB}, 2, 'LIVE_ACTIVE',
        ${sourceB.toISOString()}, ${sourceB.toISOString()}, ${checkpointB.toISOString()}, '{}'::jsonb,
        '[]'::jsonb, '[]'::jsonb, 2, 2,
        ${'a'.repeat(64)}, ${'b'.repeat(64)}, 0, 0
      )
    `;
    const windowA = await upsertFreshnessWindow({
      sloKey: LIVE_CHECKPOINT_SLO_KEY,
      contractKey: 'live-snapshot',
      seasonId: LIVE_CHECKPOINT_SEASON_ID,
      scopeKey: LIVE_CHECKPOINT_SCOPE_KEY,
      periodKey: 'generation-a',
      eventId: 3,
      eligibleAt: sourceA,
      dueAt: new Date('2026-09-05T00:10:00.000Z'),
      evidence: { consumerEvidenceRequired: false, redisEvidenceRequired: false },
    });
    const windowB = await upsertFreshnessWindow({
      sloKey: LIVE_CHECKPOINT_SLO_KEY,
      contractKey: 'live-snapshot',
      seasonId: LIVE_CHECKPOINT_SEASON_ID,
      scopeKey: LIVE_CHECKPOINT_SCOPE_KEY,
      periodKey: 'generation-b',
      eventId: 3,
      eligibleAt: sourceB,
      dueAt: new Date('2026-09-05T00:12:00.000Z'),
      evidence: { consumerEvidenceRequired: false, redisEvidenceRequired: false },
    });
    await sql`
      UPDATE ops.freshness_slo_windows
      SET producer_revision = CASE window_id
            WHEN ${windowA} THEN ${revisionA}
            ELSE ${revisionB}
          END,
          redis_revision = CASE window_id
            WHEN ${windowA} THEN ${revisionA}
            ELSE ${revisionB}
          END,
          evidence = evidence || jsonb_build_object('liveCheckpointPending', true)
      WHERE window_id IN (${windowA}, ${windowB})
    `;
    await sql`
      INSERT INTO ops.freshness_slo_windows (
        slo_key, contract_key, season_id, scope_key, period_key, event_id,
        eligible_at, due_at, producer_revision, redis_revision, evidence
      )
      SELECT
        ${LIVE_CHECKPOINT_SLO_KEY}, 'live-snapshot', ${LIVE_CHECKPOINT_SEASON_ID},
        ${LIVE_CHECKPOINT_SCOPE_KEY}, 'generation-b-backlog-' || item::text, 3,
        ${sourceB.toISOString()}::timestamptz,
        ${new Date('2026-09-05T00:12:00.000Z').toISOString()}::timestamptz
          + item * interval '1 second',
        ${revisionB}, ${revisionB},
        jsonb_build_object(
          'consumerEvidenceRequired', false,
          'redisEvidenceRequired', false,
          'liveCheckpointPending', true
        )
      FROM generate_series(1, 149) AS item
    `;

    expect(
      await recordPendingLiveSnapshotCheckpointEvidence({
        seasonId: LIVE_CHECKPOINT_SEASON_ID,
        eventId: 3,
        sourceCheckedAt: sourceA,
        pgPublishedAt: checkpointA,
        revision: revisionA,
      }),
    ).toBe(0);
    expect(
      await recordPendingLiveSnapshotCheckpointEvidence({
        seasonId: LIVE_CHECKPOINT_SEASON_ID,
        eventId: 3,
        sourceCheckedAt: new Date('2026-09-05T00:04:00.000Z'),
        pgPublishedAt: checkpointB,
        revision: revisionB,
      }),
    ).toBe(100);
    expect(
      await recordPendingLiveSnapshotCheckpointEvidence({
        seasonId: LIVE_CHECKPOINT_SEASON_ID,
        eventId: 3,
        sourceCheckedAt: new Date('2026-09-05T00:05:00.000Z'),
        pgPublishedAt: checkpointB,
        revision: revisionB,
      }),
    ).toBe(50);
    expect(
      await recordPendingLiveSnapshotCheckpointEvidence({
        seasonId: LIVE_CHECKPOINT_SEASON_ID,
        eventId: 3,
        sourceCheckedAt: new Date('2026-09-05T00:06:00.000Z'),
        pgPublishedAt: checkpointB,
        revision: revisionB,
      }),
    ).toBe(0);

    const rows = await sql<
      Array<{
        revision: string;
        total: number;
        pending: number;
        minSource: string | Date | null;
        maxSource: string | Date | null;
      }>
    >`
      SELECT producer_revision AS revision, count(*)::integer AS total,
        count(*) FILTER (
          WHERE (evidence->>'liveCheckpointPending')::boolean
        )::integer AS pending,
        min(source_checked_at) AS "minSource",
        max(source_checked_at) AS "maxSource"
      FROM ops.freshness_slo_windows
      WHERE slo_key = ${LIVE_CHECKPOINT_SLO_KEY}
        AND scope_key = ${LIVE_CHECKPOINT_SCOPE_KEY}
      GROUP BY producer_revision
      ORDER BY producer_revision
    `;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ revision: revisionA, total: 1, pending: 1 });
    expect(rows[0]?.minSource).toBeNull();
    expect(rows[1]).toMatchObject({ revision: revisionB, total: 150, pending: 0 });
    expect(new Date(rows[1]!.minSource!).toISOString()).toBe(sourceB.toISOString());
    expect(new Date(rows[1]!.maxSource!).toISOString()).toBe(sourceB.toISOString());
  });

  test('preserves a consumer breach and retires only a pending no-source-work Live Picks window', async () => {
    const sql = await getDbClient();
    const sourceCheckedAt = new Date('2026-09-05T00:04:00.000Z');
    const pgPublishedAt = new Date('2026-09-05T00:05:00.000Z');
    const producerRevision = `live-picks-v1:${'a'.repeat(64)}`;
    await sql`
      INSERT INTO fpl.seasons (
        season_id, season_code, display_name, start_year, end_year, lifecycle_state, is_current
      )
      VALUES (
        ${NO_SOURCE_SEASON_ID}, '9798', 'No source work governance integration',
        ${NO_SOURCE_SEASON_ID}, ${NO_SOURCE_SEASON_ID + 1}, 'completed', false
      )
    `;
    const windowId = await upsertFreshnessWindow({
      sloKey: WINDOW_SLO_KEY,
      contractKey: 'live-picks',
      seasonId: NO_SOURCE_SEASON_ID,
      scopeKey: WINDOW_SCOPE_KEY,
      periodKey: 'no-source-work-v1',
      eventId: 3,
      eligibleAt: new Date('2026-09-05T00:00:00.000Z'),
      dueAt: new Date('2026-09-05T00:10:30.000Z'),
      evidence: { consumerEvidenceRequired: true, redisEvidenceRequired: false },
    });
    await sql`
      UPDATE ops.freshness_slo_windows
      SET status = 'BREACHED',
          completeness_status = 'INCOMPLETE',
          breach_code = 'DEADLINE_OR_INCOMPLETE'
      WHERE window_id = ${windowId}
    `;
    await sql`
      INSERT INTO ops.data_governance_cases (
        case_kind, contract_key, lane, slo_window_id, scope_key,
        error_class, error_code, fingerprint, evidence, repair_target,
        compensator, status, repair_job_id, repair_deadline_at
      )
      VALUES (
        'freshness-breach',
        'live-picks',
        'live-picks',
        ${windowId}::bigint,
        ${WINDOW_SCOPE_KEY},
        'DATA_INCOMPLETE',
        'FRESHNESS_DEADLINE_OR_INCOMPLETE',
        ${NO_SOURCE_FINGERPRINT},
        '{}'::jsonb,
        jsonb_build_object('windowId', ${windowId}::bigint),
        'integration test',
        'AUTO_REPAIRING',
        'integration-no-source-repair',
        clock_timestamp() + interval '5 minutes'
      )
    `;

    expect(
      await settleLivePicksNoSourceWorkFreshnessWindow({
        windowId,
        eventId: 3,
        expectedCount: 12,
        observedCount: 11,
        sourceCheckedAt,
        pgPublishedAt,
        producerRevision,
      }),
    ).toBeNull();
    expect(
      await settleLivePicksNoSourceWorkFreshnessWindow({
        windowId,
        eventId: 4,
        expectedCount: 12,
        observedCount: 12,
        sourceCheckedAt,
        pgPublishedAt,
        producerRevision,
      }),
    ).toBeNull();
    expect(
      await settleLivePicksNoSourceWorkFreshnessWindow({
        windowId,
        eventId: 3,
        expectedCount: 12,
        observedCount: 12,
        sourceCheckedAt,
        pgPublishedAt,
        producerRevision,
      }),
    ).toBe('BREACHED');

    const [window, governanceCase] = await Promise.all([
      sql<
        Array<{
          status: string;
          completenessStatus: string;
          reason: string | null;
          expectedCount: number;
          observedCount: number;
          producerRevision: string | null;
          recovered: boolean;
        }>
      >`
        SELECT
          status,
          completeness_status AS "completenessStatus",
          evidence->>'reason' AS reason,
          (evidence->>'expectedCount')::integer AS "expectedCount",
          (evidence->>'observedCount')::integer AS "observedCount",
          producer_revision AS "producerRevision",
          recovered_at IS NOT NULL AS recovered
        FROM ops.freshness_slo_windows
        WHERE window_id = ${windowId}
      `,
      sql<Array<{ status: string; reason: string | null }>>`
        SELECT status, evidence->>'notApplicableReason' AS reason
        FROM ops.data_governance_cases
        WHERE slo_window_id = ${windowId}
          AND fingerprint = ${NO_SOURCE_FINGERPRINT}
      `,
    ]);
    expect(window[0]).toEqual({
      status: 'BREACHED',
      completenessStatus: 'COMPLETE',
      reason: 'LIVE_PICKS_NO_SOURCE_WORK',
      expectedCount: 12,
      observedCount: 12,
      producerRevision,
      recovered: false,
    });
    expect(governanceCase[0]).toEqual({
      status: 'AUTO_REPAIRING',
      reason: null,
    });

    const pendingWindowId = await upsertFreshnessWindow({
      sloKey: WINDOW_SLO_KEY,
      contractKey: 'live-picks',
      seasonId: NO_SOURCE_SEASON_ID,
      scopeKey: WINDOW_SCOPE_KEY,
      periodKey: 'no-source-work-pending-v1',
      eventId: 3,
      eligibleAt: new Date('2026-09-05T00:00:00.000Z'),
      dueAt: new Date('2026-09-05T00:10:30.000Z'),
      evidence: { consumerEvidenceRequired: true, redisEvidenceRequired: false },
    });
    expect(
      await settleLivePicksNoSourceWorkFreshnessWindow({
        windowId: pendingWindowId,
        eventId: 3,
        expectedCount: 12,
        observedCount: 12,
        sourceCheckedAt,
        pgPublishedAt,
        producerRevision,
      }),
    ).toBe('NOT_APPLICABLE');
    const [pendingWindow] = await sql<
      Array<{ status: string; completenessStatus: string; reason: string | null }>
    >`
      SELECT status, completeness_status AS "completenessStatus",
        evidence->>'notApplicableReason' AS reason
      FROM ops.freshness_slo_windows
      WHERE window_id = ${pendingWindowId}
    `;
    expect(pendingWindow).toEqual({
      status: 'NOT_APPLICABLE',
      completenessStatus: 'NOT_APPLICABLE',
      reason: 'LIVE_PICKS_NO_SOURCE_WORK',
    });
  });

  test('keeps a reused Trends breach and retires only a pending historical window', async () => {
    const sql = await getDbClient();
    const currentEvidence = await seedPublicTrendsEvidence();
    const windowId = await upsertFreshnessWindow({
      sloKey: PUBLIC_TRENDS_SLO_KEY,
      contractKey: 'public-league-trends',
      seasonId: NO_SOURCE_SEASON_ID,
      scopeKey: PUBLIC_TRENDS_SCOPE_KEY,
      periodKey: 'reused-v1',
      eventId: 3,
      eligibleAt: new Date('2026-09-05T00:00:00.000Z'),
      dueAt: new Date('2026-09-05T00:05:00.000Z'),
      evidence: { consumerEvidenceRequired: true, redisEvidenceRequired: false },
    });
    await sql`
      UPDATE ops.freshness_slo_windows
      SET status = 'BREACHED',
          completeness_status = 'INCOMPLETE',
          breach_code = 'DEADLINE_OR_INCOMPLETE'
      WHERE window_id = ${windowId}
    `;
    await sql`
      INSERT INTO ops.data_governance_cases (
        case_kind, contract_key, lane, slo_window_id, scope_key,
        error_class, error_code, fingerprint, evidence, repair_target,
        compensator, status, repair_job_id, repair_deadline_at
      )
      VALUES (
        'freshness-breach',
        'public-league-trends',
        'data-repair',
        ${windowId}::bigint,
        ${PUBLIC_TRENDS_SCOPE_KEY},
        'DATA_INCOMPLETE',
        'FRESHNESS_DEADLINE_OR_INCOMPLETE',
        ${PUBLIC_TRENDS_FINGERPRINT},
        '{}'::jsonb,
        jsonb_build_object('windowId', ${windowId}::bigint),
        'integration test',
        'AUTO_REPAIRING',
        'integration-reused-trends-repair',
        clock_timestamp() + interval '5 minutes'
      )
    `;
    const evidence = {
      windowId,
      eventId: 3,
      expectedCohortCount: currentEvidence.expectedCohortCount,
      observedCohortCount: currentEvidence.observedCohortCount,
      enabledTournamentIds: currentEvidence.cohorts.map((cohort) => cohort.tournamentId),
      enabledReusedCount: currentEvidence.expectedCohortCount,
      repairTargetCount: 2,
      succeededCount: 2,
      failedCount: 0,
      catalogRevision: currentEvidence.catalogRevision,
      producerRevision: currentEvidence.revision,
      sourceCheckedAt: currentEvidence.sourceCheckedAt!,
      pgPublishedAt: currentEvidence.pgPublishedAt!,
    } as const;

    expect(
      await settlePublicTrendsReusedFreshnessWindow({ ...evidence, enabledReusedCount: 1 }),
    ).toBeNull();
    expect(await settlePublicTrendsReusedFreshnessWindow({ ...evidence, eventId: 4 })).toBeNull();
    await sql`
      UPDATE competition.public_league_trends
      SET enabled = false
      WHERE season_id = ${NO_SOURCE_SEASON_ID}
        AND tournament_id = ${PUBLIC_TRENDS_TOURNAMENT_IDS[1]}
    `;
    expect(await settlePublicTrendsReusedFreshnessWindow(evidence)).toBeNull();
    await sql`
      UPDATE competition.public_league_trends
      SET enabled = true
      WHERE season_id = ${NO_SOURCE_SEASON_ID}
        AND tournament_id = ${PUBLIC_TRENDS_TOURNAMENT_IDS[1]}
    `;
    await sql`
      UPDATE fpl.events
      SET is_current = false
      WHERE season_id = ${NO_SOURCE_SEASON_ID} AND event_id = 3
    `;
    await sql`
      INSERT INTO fpl.events (season_id, event_id, name, is_current)
      VALUES (${NO_SOURCE_SEASON_ID}, 4, 'Gameweek 4', true)
    `;
    expect(await settlePublicTrendsReusedFreshnessWindow(evidence)).toBe('BREACHED');

    const [window, governanceCase] = await Promise.all([
      sql<
        Array<{
          status: string;
          completenessStatus: string;
          reason: string | null;
          recovered: boolean;
          producerRevision: string | null;
        }>
      >`
        SELECT status, completeness_status AS "completenessStatus",
          evidence->>'reason' AS reason, recovered_at IS NOT NULL AS recovered,
          producer_revision AS "producerRevision"
        FROM ops.freshness_slo_windows
        WHERE window_id = ${windowId}
      `,
      sql<Array<{ status: string; reason: string | null }>>`
        SELECT status, evidence->>'notApplicableReason' AS reason
        FROM ops.data_governance_cases
        WHERE slo_window_id = ${windowId}
          AND fingerprint = ${PUBLIC_TRENDS_FINGERPRINT}
      `,
    ]);
    expect(window[0]).toEqual({
      status: 'BREACHED',
      completenessStatus: 'COMPLETE',
      reason: 'PUBLIC_TRENDS_NO_SOURCE_WORK',
      recovered: false,
      producerRevision: currentEvidence.revision,
    });
    expect(governanceCase[0]).toEqual({
      status: 'AUTO_REPAIRING',
      reason: null,
    });

    const pendingWindowId = await upsertFreshnessWindow({
      sloKey: PUBLIC_TRENDS_SLO_KEY,
      contractKey: 'public-league-trends',
      seasonId: NO_SOURCE_SEASON_ID,
      scopeKey: PUBLIC_TRENDS_SCOPE_KEY,
      periodKey: 'reused-pending-v1',
      eventId: 3,
      eligibleAt: new Date('2026-09-05T00:00:00.000Z'),
      dueAt: new Date('2026-09-05T00:05:00.000Z'),
      evidence: { consumerEvidenceRequired: true, redisEvidenceRequired: false },
    });
    expect(
      await settlePublicTrendsReusedFreshnessWindow({
        ...evidence,
        windowId: pendingWindowId,
      }),
    ).toBe('NOT_APPLICABLE');
    const [pendingWindow] = await sql<
      Array<{ status: string; completenessStatus: string; reason: string | null }>
    >`
      SELECT status, completeness_status AS "completenessStatus",
        evidence->>'notApplicableReason' AS reason
      FROM ops.freshness_slo_windows
      WHERE window_id = ${pendingWindowId}
    `;
    expect(pendingWindow).toEqual({
      status: 'NOT_APPLICABLE',
      completenessStatus: 'NOT_APPLICABLE',
      reason: 'PUBLIC_TRENDS_NO_SOURCE_WORK',
    });
  });

  test('retires a late Public Trends breach only while no enabled cohort exists', async () => {
    const sql = await getDbClient();
    await seedPublicTrendsEvidence();
    const windowId = await upsertFreshnessWindow({
      sloKey: PUBLIC_TRENDS_SLO_KEY,
      contractKey: 'public-league-trends',
      seasonId: NO_SOURCE_SEASON_ID,
      scopeKey: PUBLIC_TRENDS_SCOPE_KEY,
      periodKey: 'ineligible-v1',
      eventId: 3,
      eligibleAt: new Date('2026-09-05T00:00:00.000Z'),
      dueAt: new Date('2026-09-05T00:05:00.000Z'),
      evidence: { consumerEvidenceRequired: false, redisEvidenceRequired: false },
    });
    await sql`
      UPDATE ops.freshness_slo_windows
      SET status = 'BREACHED',
          completeness_status = 'INCOMPLETE',
          breach_code = 'DEADLINE_OR_INCOMPLETE'
      WHERE window_id = ${windowId}
    `;
    await sql`
      INSERT INTO ops.data_governance_cases (
        case_kind, contract_key, lane, slo_window_id, scope_key,
        error_class, error_code, fingerprint, evidence, repair_target,
        compensator, status, repair_job_id, repair_deadline_at
      )
      VALUES (
        'freshness-breach', 'public-league-trends', 'data-repair', ${windowId}::bigint,
        ${PUBLIC_TRENDS_SCOPE_KEY}, 'DATA_INCOMPLETE',
        'FRESHNESS_DEADLINE_OR_INCOMPLETE', ${PUBLIC_TRENDS_INELIGIBLE_FINGERPRINT},
        '{}'::jsonb, jsonb_build_object('windowId', ${windowId}::bigint),
        'integration test', 'AUTO_REPAIRING', 'integration-ineligible-trends-repair',
        clock_timestamp() + interval '5 minutes'
      )
    `;

    expect(
      await retirePublicTrendsIneligibleFreshnessWindow({
        windowId,
        reasonCode: 'PUBLIC_TRENDS_NO_ENABLED_COHORTS',
        eventId: 3,
      }),
    ).toBe(false);
    await sql`
      UPDATE competition.public_league_trends
      SET enabled = false
      WHERE season_id = ${NO_SOURCE_SEASON_ID}
    `;
    expect(
      await retirePublicTrendsIneligibleFreshnessWindow({
        windowId,
        reasonCode: 'PUBLIC_TRENDS_NO_ENABLED_COHORTS',
        eventId: 4,
      }),
    ).toBe(false);
    expect(
      await retirePublicTrendsIneligibleFreshnessWindow({
        windowId,
        reasonCode: 'PUBLIC_TRENDS_NO_ENABLED_COHORTS',
        eventId: 3,
      }),
    ).toBe(true);

    const [window, governanceCase] = await Promise.all([
      sql<Array<{ status: string; reason: string | null }>>`
        SELECT status, evidence->>'notApplicableReason' AS reason
        FROM ops.freshness_slo_windows
        WHERE window_id = ${windowId}
      `,
      sql<Array<{ status: string; reason: string | null }>>`
        SELECT status, evidence->>'notApplicableReason' AS reason
        FROM ops.data_governance_cases
        WHERE slo_window_id = ${windowId}
          AND fingerprint = ${PUBLIC_TRENDS_INELIGIBLE_FINGERPRINT}
      `,
    ]);
    expect(window[0]).toEqual({
      status: 'NOT_APPLICABLE',
      reason: 'PUBLIC_TRENDS_NO_ENABLED_COHORTS',
    });
    expect(governanceCase[0]).toEqual({
      status: 'DISMISSED',
      reason: 'PUBLIC_TRENDS_NO_ENABLED_COHORTS',
    });
  });

  test('atomically retires a breached empty cohort and dismisses its repair case', async () => {
    const sql = await getDbClient();
    await sql`
      INSERT INTO fpl.seasons (
        season_id, season_code, display_name, start_year, end_year, lifecycle_state, is_current
      )
      VALUES (
        ${EMPTY_COHORT_SEASON_ID}, '9899', 'Empty cohort governance integration',
        ${EMPTY_COHORT_SEASON_ID}, ${EMPTY_COHORT_SEASON_ID + 1}, 'completed', false
      )
    `;
    const windowId = await upsertFreshnessWindow({
      sloKey: EMPTY_COHORT_SLO_KEY,
      contractKey: 'live-picks',
      seasonId: EMPTY_COHORT_SEASON_ID,
      scopeKey: EMPTY_COHORT_SCOPE_KEY,
      periodKey: 'event-3',
      eventId: 3,
      eligibleAt: new Date('2026-09-05T00:00:00.000Z'),
      dueAt: new Date('2026-09-05T00:10:30.000Z'),
      evidence: { consumerEvidenceRequired: false, redisEvidenceRequired: false },
    });
    await sql`
      UPDATE ops.freshness_slo_windows
      SET status = 'BREACHED',
          completeness_status = 'INCOMPLETE',
          breach_code = 'DEADLINE_OR_INCOMPLETE'
      WHERE window_id = ${windowId}
    `;
    await sql`
      INSERT INTO ops.data_governance_cases (
        case_kind, contract_key, lane, slo_window_id, scope_key,
        error_class, error_code, fingerprint, evidence, repair_target,
        compensator, status, repair_job_id, repair_deadline_at
      )
      VALUES (
        'freshness-breach',
        'live-picks',
        'live-picks',
        ${windowId}::bigint,
        ${EMPTY_COHORT_SCOPE_KEY},
        'DATA_INCOMPLETE',
        'FRESHNESS_DEADLINE_OR_INCOMPLETE',
        ${EMPTY_COHORT_FINGERPRINT},
        '{}'::jsonb,
        jsonb_build_object('windowId', ${windowId}::bigint),
        'integration test',
        'AUTO_REPAIRING',
        'integration-empty-cohort-repair',
        clock_timestamp() + interval '5 minutes'
      )
    `;

    expect(
      await markFreshnessWindowNotApplicable({
        windowId,
        reasonCode: 'GENERIC_NO_OP',
      }),
    ).toBe(false);
    const [stillBreached, stillRepairing] = await Promise.all([
      sql<Array<{ status: string }>>`
        SELECT status FROM ops.freshness_slo_windows WHERE window_id = ${windowId}
      `,
      sql<Array<{ status: string }>>`
        SELECT status
        FROM ops.data_governance_cases
        WHERE slo_window_id = ${windowId}
          AND fingerprint = ${EMPTY_COHORT_FINGERPRINT}
      `,
    ]);
    expect(stillBreached[0]?.status).toBe('BREACHED');
    expect(stillRepairing[0]?.status).toBe('AUTO_REPAIRING');
    expect(
      await retireLivePicksEmptyCohortFreshnessWindow({
        windowId,
        eventId: 4,
      }),
    ).toBe(false);

    await sql`
      INSERT INTO competition.entries (
        season_id, entry_id, entry_name, player_name, started_event
      )
      VALUES (
        ${EMPTY_COHORT_SEASON_ID}, ${EMPTY_COHORT_ENTRY_ID},
        'Eligible integration entry', 'Eligible integration player', 3
      )
    `;
    expect(
      await retireLivePicksEmptyCohortFreshnessWindow({
        windowId,
        eventId: 3,
      }),
    ).toBe(false);
    await expect(
      persistLivePicksDurableFreshnessEvidence(explicitSeasonRef('9899'), 3, windowId, true),
    ).rejects.toThrow('Live Picks durable evidence is incomplete: 0/1');
    const [incomplete] = await sql<
      Array<{
        expectedCount: number;
        observedCount: number;
        completenessStatus: string;
        scanComplete: boolean;
      }>
    >`
      SELECT
        expected_count AS "expectedCount",
        observed_count AS "observedCount",
        completeness_status AS "completenessStatus",
        (evidence ->> 'scanComplete')::boolean AS "scanComplete"
      FROM ops.freshness_slo_windows
      WHERE window_id = ${windowId}
    `;
    expect(incomplete).toEqual({
      expectedCount: 1,
      observedCount: 0,
      completenessStatus: 'INCOMPLETE',
      scanComplete: true,
    });
    await sql`
      DELETE FROM competition.entries
      WHERE season_id = ${EMPTY_COHORT_SEASON_ID}
        AND entry_id = ${EMPTY_COHORT_ENTRY_ID}
    `;

    const evidence = await persistLivePicksDurableFreshnessEvidence(
      explicitSeasonRef('9899'),
      3,
      windowId,
      true,
    );
    expect(evidence).toMatchObject({
      expectedCount: 0,
      observedCount: 0,
      complete: false,
    });

    const [window, governanceCase] = await Promise.all([
      sql<
        Array<{
          status: string;
          completenessStatus: string;
          breachCode: string | null;
          reason: string | null;
        }>
      >`
        SELECT
          status,
          completeness_status AS "completenessStatus",
          breach_code AS "breachCode",
          evidence->>'notApplicableReason' AS reason
        FROM ops.freshness_slo_windows
        WHERE window_id = ${windowId}
      `,
      sql<
        Array<{
          status: string;
          lastError: string | null;
          repairJobId: string | null;
          repairDeadlineAt: Date | null;
          reason: string | null;
        }>
      >`
        SELECT
          status,
          last_error AS "lastError",
          repair_job_id AS "repairJobId",
          repair_deadline_at AS "repairDeadlineAt",
          evidence->>'notApplicableReason' AS reason
        FROM ops.data_governance_cases
        WHERE slo_window_id = ${windowId}
          AND fingerprint = ${EMPTY_COHORT_FINGERPRINT}
      `,
    ]);
    expect(window[0]).toEqual({
      status: 'NOT_APPLICABLE',
      completenessStatus: 'NOT_APPLICABLE',
      breachCode: null,
      reason: 'LIVE_PICKS_NO_ELIGIBLE_ENTRIES',
    });
    expect(governanceCase[0]).toEqual({
      status: 'DISMISSED',
      lastError: null,
      repairJobId: null,
      repairDeadlineAt: null,
      reason: 'LIVE_PICKS_NO_ELIGIBLE_ENTRIES',
    });
  });
});
