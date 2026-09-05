import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import { getDbClient } from '../../src/db/singleton';
import { explicitSeasonRef } from '../../src/domain/fpl-season';
import {
  listGovernanceCases,
  markLivePicksNoSourceWorkFreshnessWindowNotApplicable,
  markFreshnessWindowNotApplicable,
  openGovernanceCase,
  retireLivePicksEmptyCohortFreshnessWindow,
  upsertFreshnessWindow,
  transitionGovernanceCase,
} from '../../src/services/data-governance.service';
import { persistLivePicksDurableFreshnessEvidence } from '../../src/services/live-lifecycle-orchestrator';

const SCOPE_KEY = 'integration:governance-case-cas';
const FINGERPRINT = 'integration:governance-case-cas:v1';
const WINDOW_SLO_KEY = 'integration:consumer-evidence-freeze';
const WINDOW_SCOPE_KEY = 'integration:consumer-evidence-freeze';
const EMPTY_COHORT_SLO_KEY = 'integration:live-picks-empty-cohort';
const EMPTY_COHORT_SCOPE_KEY = 'integration:live-picks-empty-cohort';
const EMPTY_COHORT_FINGERPRINT = 'integration:live-picks-empty-cohort:breach';
const EMPTY_COHORT_SEASON_ID = 2098;
const EMPTY_COHORT_ENTRY_ID = 990_433;

async function cleanup(): Promise<void> {
  const sql = await getDbClient();
  await sql`
    DELETE FROM ops.data_governance_cases
    WHERE (scope_key = ${SCOPE_KEY} AND fingerprint = ${FINGERPRINT})
       OR (scope_key = ${EMPTY_COHORT_SCOPE_KEY} AND fingerprint = ${EMPTY_COHORT_FINGERPRINT})
  `;
  await sql`
    DELETE FROM ops.freshness_slo_windows
    WHERE (slo_key = ${WINDOW_SLO_KEY} AND scope_key = ${WINDOW_SCOPE_KEY})
       OR (slo_key = ${EMPTY_COHORT_SLO_KEY} AND scope_key = ${EMPTY_COHORT_SCOPE_KEY})
  `;
  await sql`
    DELETE FROM competition.entries
    WHERE season_id = ${EMPTY_COHORT_SEASON_ID}
      AND entry_id = ${EMPTY_COHORT_ENTRY_ID}
  `;
  await sql`
    DELETE FROM fpl.seasons
    WHERE season_id = ${EMPTY_COHORT_SEASON_ID}
  `;
}

beforeEach(cleanup);
afterAll(cleanup);

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

  test('retires a complete no-source-work Live Picks window without stale timestamps', async () => {
    const windowId = await upsertFreshnessWindow({
      sloKey: WINDOW_SLO_KEY,
      contractKey: 'live-picks',
      scopeKey: WINDOW_SCOPE_KEY,
      periodKey: 'no-source-work-v1',
      eventId: 3,
      eligibleAt: new Date('2026-09-05T00:00:00.000Z'),
      dueAt: new Date('2026-09-05T00:10:30.000Z'),
      evidence: { consumerEvidenceRequired: false, redisEvidenceRequired: false },
    });

    expect(
      await markLivePicksNoSourceWorkFreshnessWindowNotApplicable({
        windowId,
        eventId: 3,
        expectedCount: 12,
        observedCount: 11,
      }),
    ).toBe(false);
    expect(
      await markLivePicksNoSourceWorkFreshnessWindowNotApplicable({
        windowId,
        eventId: 3,
        expectedCount: 12,
        observedCount: 12,
      }),
    ).toBe(true);

    const sql = await getDbClient();
    const [window] = await sql<
      Array<{
        status: string;
        completenessStatus: string;
        reason: string | null;
        expectedCount: number;
        observedCount: number;
      }>
    >`
      SELECT
        status,
        completeness_status AS "completenessStatus",
        evidence->>'notApplicableReason' AS reason,
        (evidence->>'expectedCount')::integer AS "expectedCount",
        (evidence->>'observedCount')::integer AS "observedCount"
      FROM ops.freshness_slo_windows
      WHERE window_id = ${windowId}
    `;
    expect(window).toEqual({
      status: 'NOT_APPLICABLE',
      completenessStatus: 'NOT_APPLICABLE',
      reason: 'LIVE_PICKS_NO_SOURCE_WORK',
      expectedCount: 12,
      observedCount: 12,
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
