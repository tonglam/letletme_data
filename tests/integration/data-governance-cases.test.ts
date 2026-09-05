import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import { getDbClient } from '../../src/db/singleton';
import {
  listGovernanceCases,
  markFreshnessWindowNotApplicable,
  openGovernanceCase,
  retireLivePicksEmptyCohortFreshnessWindow,
  upsertFreshnessWindow,
  transitionGovernanceCase,
} from '../../src/services/data-governance.service';

const SCOPE_KEY = 'integration:governance-case-cas';
const FINGERPRINT = 'integration:governance-case-cas:v1';
const WINDOW_SLO_KEY = 'integration:consumer-evidence-freeze';
const WINDOW_SCOPE_KEY = 'integration:consumer-evidence-freeze';
const EMPTY_COHORT_SLO_KEY = 'integration:live-picks-empty-cohort';
const EMPTY_COHORT_SCOPE_KEY = 'integration:live-picks-empty-cohort';
const EMPTY_COHORT_FINGERPRINT = 'integration:live-picks-empty-cohort:breach';

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

  test('freezes consumer evidence requirements on freshness-window re-reservation', async () => {
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
      evidence: { consumerEvidenceRequired: false, redisEvidenceRequired: false },
    });
    await upsertFreshnessWindow({
      ...base,
      evidence: { consumerEvidenceRequired: true, redisEvidenceRequired: true },
    });

    const sql = await getDbClient();
    const [row] = await sql<Array<{ consumer: boolean; redis: boolean }>>`
      SELECT
        (evidence ->> 'consumerEvidenceRequired')::boolean AS consumer,
        (evidence ->> 'redisEvidenceRequired')::boolean AS redis
      FROM ops.freshness_slo_windows
      WHERE slo_key = ${WINDOW_SLO_KEY}
        AND scope_key = ${WINDOW_SCOPE_KEY}
        AND period_key = 'freeze-v1'
    `;
    expect(row).toEqual({ consumer: false, redis: true });
  });

  test('atomically retires a breached empty cohort and dismisses its repair case', async () => {
    const windowId = await upsertFreshnessWindow({
      sloKey: EMPTY_COHORT_SLO_KEY,
      contractKey: 'live-picks',
      scopeKey: EMPTY_COHORT_SCOPE_KEY,
      periodKey: 'event-3',
      eventId: 3,
      eligibleAt: new Date('2026-09-05T00:00:00.000Z'),
      dueAt: new Date('2026-09-05T00:10:30.000Z'),
      evidence: { consumerEvidenceRequired: false, redisEvidenceRequired: false },
    });
    const sql = await getDbClient();
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

    expect(
      await retireLivePicksEmptyCohortFreshnessWindow({
        windowId,
        eventId: 3,
      }),
    ).toBe(true);

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
