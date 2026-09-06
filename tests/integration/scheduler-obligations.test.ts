import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import { getDbClient } from '../../src/db/singleton';
import {
  claimSchedulerObligations,
  completeSchedulerObligation,
  confirmSchedulerObligationEnqueued,
  deferSchedulerObligationForWorker,
  failSchedulerObligation,
  appendSchedulerObligationRecovery,
  findDueSchedulerObligationCandidates,
  findDueSchedulerJobNames,
  getLatestFailedSchedulerObligation,
  listExpiredSchedulerObligations,
  markSchedulerObligationIrrecoverable,
  reconcilePostMatchSchedulerObligations,
  renewSchedulerObligation,
  reserveSchedulerObligation,
  schedulerObligationStatus,
  startSchedulerObligation,
  supersedeSchedulerObligations,
  supersedeSchedulerObligationsByDueAt,
  supersedeSchedulerObligationsByDueAtBatch,
} from '../../src/repositories/scheduler-obligations';
import { upsertFreshnessWindow } from '../../src/services/data-governance.service';

const OBLIGATION_ID = '30000000-0000-4000-8000-000000000001';
const NEWER_OBLIGATION_ID = '30000000-0000-4000-8000-000000000002';
const IN_FLIGHT_OBLIGATION_ID = '30000000-0000-4000-8000-000000000003';
const SECOND_OLDER_OBLIGATION_ID = '30000000-0000-4000-8000-000000000004';
const SECOND_CURRENT_OBLIGATION_ID = '30000000-0000-4000-8000-000000000005';
const LATE_OLDER_OBLIGATION_ID = '30000000-0000-4000-8000-000000000006';
const LATEST_OBLIGATION_ID = '30000000-0000-4000-8000-000000000007';
const IMMUTABLE_DEADLINE_OBLIGATION_ID = '30000000-0000-4000-8000-000000000008';
const IMMUTABLE_CLAIM_OLDER_OBLIGATION_ID = '30000000-0000-4000-8000-000000000009';
const IMMUTABLE_CLAIM_NEWER_OBLIGATION_ID = '30000000-0000-4000-8000-000000000010';
const ACCEPTED_BACKOFF_OBLIGATION_ID = '30000000-0000-4000-8000-000000000011';
const RETRYING_START_OBLIGATION_ID = '30000000-0000-4000-8000-000000000012';
const MY_FPL_PRIORITY_HISTORICAL_OBLIGATION_ID = '30000000-0000-4000-8000-000000000013';
const MY_FPL_PRIORITY_CURRENT_OBLIGATION_ID = '30000000-0000-4000-8000-000000000014';
const MY_FPL_PRIORITY_REFRESH_OBLIGATION_ID = '30000000-0000-4000-8000-000000000015';
const RECOVERY_OLDER_OBLIGATION_ID = '30000000-0000-4000-8000-000000000016';
const RECOVERY_LATEST_OBLIGATION_ID = '30000000-0000-4000-8000-000000000017';
const RECOVERY_NEWEST_OBLIGATION_ID = '30000000-0000-4000-8000-000000000018';
const RECOVERY_SUPERSEDING_SUCCESS_ID = '30000000-0000-4000-8000-000000000019';
const RECOVERY_JOB_NAME = 'integration-scheduler-recovery';
const RECOVERY_SCOPE_KEY = 'integration:event:scheduler-recovery';
const ACCEPTED_BACKOFF_SLO_KEY = 'integration:live-picks-backoff';
const ACCEPTED_BACKOFF_SCOPE_KEY = 'integration:event:accepted-backoff';
const ACCEPTED_BACKOFF_CASE_FINGERPRINT = 'integration:live-picks-backoff:breach';

async function cleanup(): Promise<void> {
  const sql = await getDbClient();
  await sql`
    DELETE FROM ops.scheduler_obligations
    WHERE obligation_id IN (
      ${OBLIGATION_ID}::uuid,
      ${NEWER_OBLIGATION_ID}::uuid,
      ${IN_FLIGHT_OBLIGATION_ID}::uuid,
      ${SECOND_OLDER_OBLIGATION_ID}::uuid,
      ${SECOND_CURRENT_OBLIGATION_ID}::uuid,
      ${LATE_OLDER_OBLIGATION_ID}::uuid,
      ${LATEST_OBLIGATION_ID}::uuid,
      ${IMMUTABLE_DEADLINE_OBLIGATION_ID}::uuid,
      ${IMMUTABLE_CLAIM_OLDER_OBLIGATION_ID}::uuid,
      ${IMMUTABLE_CLAIM_NEWER_OBLIGATION_ID}::uuid,
      ${ACCEPTED_BACKOFF_OBLIGATION_ID}::uuid,
      ${RETRYING_START_OBLIGATION_ID}::uuid,
      ${MY_FPL_PRIORITY_HISTORICAL_OBLIGATION_ID}::uuid,
      ${MY_FPL_PRIORITY_CURRENT_OBLIGATION_ID}::uuid,
      ${MY_FPL_PRIORITY_REFRESH_OBLIGATION_ID}::uuid,
      ${RECOVERY_OLDER_OBLIGATION_ID}::uuid,
      ${RECOVERY_LATEST_OBLIGATION_ID}::uuid,
      ${RECOVERY_NEWEST_OBLIGATION_ID}::uuid,
      ${RECOVERY_SUPERSEDING_SUCCESS_ID}::uuid
    )
       OR scope_key IN (
         'integration:event:atomic-reschedule',
         'integration:event:equal-boundary-reschedule',
         'integration:event:in-flight-correction',
         'integration:event:retry-delay',
         'integration:event:same-slot-correction',
         'integration:event:lane-race',
         'integration:event:immutable-deadline',
         'integration:event:immutable-claim',
         ${ACCEPTED_BACKOFF_SCOPE_KEY},
         'integration:event:my-fpl-priority',
         ${RECOVERY_SCOPE_KEY}
       )
  `;
  await sql`
    DELETE FROM ops.freshness_slo_windows
    WHERE slo_key = ${ACCEPTED_BACKOFF_SLO_KEY}
      AND scope_key = ${ACCEPTED_BACKOFF_SCOPE_KEY}
  `;
  await sql`
    DELETE FROM ops.data_governance_cases
    WHERE fingerprint = ${ACCEPTED_BACKOFF_CASE_FINGERPRINT}
  `;
}

beforeEach(cleanup);
afterAll(cleanup);

describe('scheduler recovery evidence', () => {
  test('does not target a historical failure behind a newer successful obligation', async () => {
    const sql = await getDbClient();
    await sql`
      INSERT INTO ops.scheduler_obligations (
        obligation_id, job_name, scope_key, period_key, cadence, timezone,
        status, source, due_at, generation, attempts, completed_at, last_error, evidence
      )
      VALUES
        (
          ${RECOVERY_OLDER_OBLIGATION_ID}::uuid,
          ${RECOVERY_JOB_NAME},
          ${RECOVERY_SCOPE_KEY},
          'failed-period',
          'integration',
          'UTC',
          'failed',
          'catchup',
          '2026-09-01T00:05:00Z'::timestamptz,
          1,
          1,
          '2026-09-01T00:06:00Z'::timestamptz,
          'historical failure',
          jsonb_build_object('scheduledDueAtMs', ${Date.parse('2026-09-01T00:00:00.000Z')}::bigint)
        ),
        (
          ${RECOVERY_SUPERSEDING_SUCCESS_ID}::uuid,
          ${RECOVERY_JOB_NAME},
          ${RECOVERY_SCOPE_KEY},
          'successful-period',
          'integration',
          'UTC',
          'succeeded',
          'catchup',
          '2026-09-01T01:05:00Z'::timestamptz,
          1,
          1,
          '2026-09-01T01:06:00Z'::timestamptz,
          NULL,
          jsonb_build_object('scheduledDueAtMs', ${Date.parse('2026-09-01T01:00:00.000Z')}::bigint)
        )
    `;

    expect(
      await getLatestFailedSchedulerObligation({
        jobName: RECOVERY_JOB_NAME,
        scopeKey: RECOVERY_SCOPE_KEY,
      }),
    ).toBeNull();
  });

  test('uses immutable schedule time and prevents redispatch of recovered failures', async () => {
    const sql = await getDbClient();
    const olderScheduledDueAtMs = Date.parse('2026-09-01T00:00:00.000Z');
    const latestScheduledDueAtMs = Date.parse('2026-09-01T01:00:00.000Z');
    await sql`
      INSERT INTO ops.scheduler_obligations (
        obligation_id, job_name, scope_key, period_key, cadence, timezone,
        status, source, due_at, generation, attempts, last_error, evidence
      )
      VALUES
        (
          ${RECOVERY_OLDER_OBLIGATION_ID}::uuid,
          ${RECOVERY_JOB_NAME},
          ${RECOVERY_SCOPE_KEY},
          'older-period',
          'integration',
          'UTC',
          'failed',
          'catchup',
          '2026-09-01T01:30:00Z'::timestamptz,
          1,
          1,
          'older failure',
          jsonb_build_object('scheduledDueAtMs', ${olderScheduledDueAtMs}::bigint)
        ),
        (
          ${RECOVERY_LATEST_OBLIGATION_ID}::uuid,
          ${RECOVERY_JOB_NAME},
          ${RECOVERY_SCOPE_KEY},
          'latest-period',
          'integration',
          'UTC',
          'failed',
          'catchup',
          '2026-09-01T00:05:00Z'::timestamptz,
          1,
          1,
          'latest failure',
          jsonb_build_object('scheduledDueAtMs', ${latestScheduledDueAtMs}::bigint)
        )
    `;

    const captured = await getLatestFailedSchedulerObligation({
      jobName: RECOVERY_JOB_NAME,
      scopeKey: RECOVERY_SCOPE_KEY,
    });
    expect(captured).toMatchObject({
      obligationId: RECOVERY_LATEST_OBLIGATION_ID,
      periodKey: 'latest-period',
      generation: 1,
    });

    await sql`
      INSERT INTO ops.scheduler_obligations (
        obligation_id, job_name, scope_key, period_key, cadence, timezone,
        status, source, due_at, generation, attempts, last_error, evidence
      )
      VALUES (
        ${RECOVERY_NEWEST_OBLIGATION_ID}::uuid,
        ${RECOVERY_JOB_NAME},
        ${RECOVERY_SCOPE_KEY},
        'newest-period',
        'integration',
        'UTC',
        'irrecoverable',
        'catchup',
        '2026-09-01T02:05:00Z'::timestamptz,
        2,
        2,
        'newer concurrent failure',
        jsonb_build_object('scheduledDueAtMs', ${latestScheduledDueAtMs}::bigint)
      )
    `;

    expect(
      await appendSchedulerObligationRecovery({
        jobName: RECOVERY_JOB_NAME,
        scopeKey: RECOVERY_SCOPE_KEY,
        obligationId: captured!.obligationId,
        periodKey: captured!.periodKey,
        generation: captured!.generation,
        recoveryRevision: 'recovery-99',
        recoveryActor: 'integration-test',
        recoveryReason: 'verify immutable recovery target',
      }),
    ).toBe(true);
    expect(
      await appendSchedulerObligationRecovery({
        jobName: RECOVERY_JOB_NAME,
        scopeKey: RECOVERY_SCOPE_KEY,
        obligationId: captured!.obligationId,
        periodKey: captured!.periodKey,
        generation: captured!.generation,
        recoveryRevision: 'recovery-99',
        recoveryActor: 'integration-test',
        recoveryReason: 'verify idempotent retry',
      }),
    ).toBe(true);
    expect(
      await appendSchedulerObligationRecovery({
        jobName: RECOVERY_JOB_NAME,
        scopeKey: RECOVERY_SCOPE_KEY,
        obligationId: captured!.obligationId,
        periodKey: captured!.periodKey,
        generation: captured!.generation,
        recoveryRevision: 'recovery-100',
        recoveryActor: 'integration-test',
        recoveryReason: 'must not overwrite first recovery',
      }),
    ).toBe(false);

    const rows = await sql<Array<{ obligation_id: string; evidence: Record<string, unknown> }>>`
      SELECT obligation_id, evidence
      FROM ops.scheduler_obligations
      WHERE obligation_id IN (
        ${RECOVERY_OLDER_OBLIGATION_ID}::uuid,
        ${RECOVERY_LATEST_OBLIGATION_ID}::uuid,
        ${RECOVERY_NEWEST_OBLIGATION_ID}::uuid
      )
      ORDER BY obligation_id
    `;
    expect(
      rows.find((row) => row.obligation_id === RECOVERY_LATEST_OBLIGATION_ID)?.evidence,
    ).toMatchObject({
      schedulerRecovery: {
        recoveryRevision: 'recovery-99',
        status: 'succeeded',
        obligationId: RECOVERY_LATEST_OBLIGATION_ID,
        periodKey: 'latest-period',
        generation: 1,
      },
    });
    expect(
      rows.find((row) => row.obligation_id === RECOVERY_OLDER_OBLIGATION_ID)?.evidence,
    ).not.toHaveProperty('schedulerRecovery');
    expect(
      rows.find((row) => row.obligation_id === RECOVERY_NEWEST_OBLIGATION_ID)?.evidence,
    ).not.toHaveProperty('schedulerRecovery');

    const newest = await getLatestFailedSchedulerObligation({
      jobName: RECOVERY_JOB_NAME,
      scopeKey: RECOVERY_SCOPE_KEY,
    });
    expect(newest).toMatchObject({
      obligationId: RECOVERY_NEWEST_OBLIGATION_ID,
      periodKey: 'newest-period',
      generation: 2,
    });
    expect(
      await appendSchedulerObligationRecovery({
        jobName: RECOVERY_JOB_NAME,
        scopeKey: RECOVERY_SCOPE_KEY,
        obligationId: newest!.obligationId,
        periodKey: newest!.periodKey,
        generation: newest!.generation,
        recoveryRevision: 'recovery-100',
        recoveryActor: 'integration-test',
        recoveryReason: 'recover newest exact target',
      }),
    ).toBe(true);
    expect(
      await getLatestFailedSchedulerObligation({
        jobName: RECOVERY_JOB_NAME,
        scopeKey: RECOVERY_SCOPE_KEY,
      }),
    ).toBeNull();

    expect(await findDueSchedulerJobNames({})).not.toContain(RECOVERY_JOB_NAME);
    expect(await findDueSchedulerObligationCandidates({})).not.toContainEqual(
      expect.objectContaining({ jobName: RECOVERY_JOB_NAME }),
    );
    expect(
      await claimSchedulerObligations({
        limit: 20,
        includedJobNames: [RECOVERY_JOB_NAME],
      }),
    ).toHaveLength(0);

    const status = await schedulerObligationStatus({
      jobName: RECOVERY_JOB_NAME,
      scopeKey: RECOVERY_SCOPE_KEY,
    });
    expect(status.overdue).toBe(false);
    expect(status.consecutiveUnsuccessfulCycles).toBe(0);
    expect(status.latest).toMatchObject({
      obligationId: RECOVERY_NEWEST_OBLIGATION_ID,
      periodKey: 'newest-period',
      status: 'irrecoverable',
      lastError: 'newer concurrent failure',
      generation: 2,
    });
  });
});

describe('scheduler obligation generation fencing', () => {
  test('retires accepted live-picks backoff windows in the completion transaction', async () => {
    const sql = await getDbClient();
    const windowId = await upsertFreshnessWindow({
      sloKey: ACCEPTED_BACKOFF_SLO_KEY,
      contractKey: 'my-fpl',
      scopeKey: ACCEPTED_BACKOFF_SCOPE_KEY,
      periodKey: 'probe-1',
      eligibleAt: new Date('2026-08-28T00:00:00.000Z'),
      dueAt: new Date('2026-08-28T00:05:00.000Z'),
      evidence: { consumerEvidenceRequired: false, redisEvidenceRequired: false },
    });
    await sql`
      INSERT INTO ops.scheduler_obligations (
        obligation_id, job_name, scope_key, period_key, cadence, timezone,
        status, source, due_at, generation, attempts, evidence
      )
      VALUES (
        ${ACCEPTED_BACKOFF_OBLIGATION_ID}::uuid,
        'live-picks-refresh',
        ${ACCEPTED_BACKOFF_SCOPE_KEY},
        'probe-1',
        '*/2 * * * *',
        'UTC',
        'running',
        'schedule',
        clock_timestamp(),
        0,
        1,
        jsonb_build_object(
          'freshnessWindowId', ${windowId}::bigint,
          'freshnessWindowIds', jsonb_build_array(${windowId}::bigint),
          'scanComplete', false
        )
      )
    `;
    await sql`
      UPDATE ops.freshness_slo_windows
      SET
        status = 'BREACHED',
        completeness_status = 'INCOMPLETE',
        breach_code = 'DEADLINE_OR_INCOMPLETE'
      WHERE window_id = ${windowId}
    `;
    await sql`
      INSERT INTO ops.data_governance_cases (
        case_kind, contract_key, lane, obligation_id, slo_window_id,
        scope_key, error_class, error_code, fingerprint, evidence,
        repair_target, compensator, status
      )
      VALUES (
        'freshness-breach',
        'my-fpl',
        'my-fpl',
        ${ACCEPTED_BACKOFF_OBLIGATION_ID}::uuid,
        ${windowId}::bigint,
        ${ACCEPTED_BACKOFF_SCOPE_KEY},
        'DATA_INCOMPLETE',
        'FRESHNESS_DEADLINE_OR_INCOMPLETE',
        ${ACCEPTED_BACKOFF_CASE_FINGERPRINT},
        '{}'::jsonb,
        jsonb_build_object('windowId', ${windowId}::bigint),
        'integration test',
        'OPEN'
      )
    `;

    expect(
      await completeSchedulerObligation({
        obligationId: ACCEPTED_BACKOFF_OBLIGATION_ID,
        generation: 0,
        status: 'skipped',
        evidence: { reason: 'live-picks-probe-backoff-accepted' },
      }),
    ).toBe(true);

    const [obligation, window, governanceCase] = await Promise.all([
      sql<Array<{ status: string }>>`
        SELECT status
        FROM ops.scheduler_obligations
        WHERE obligation_id = ${ACCEPTED_BACKOFF_OBLIGATION_ID}::uuid
      `,
      sql<
        Array<{
          status: string;
          completeness_status: string;
          job_name: string;
          reason: string;
          not_applicable_reason: string;
        }>
      >`
        SELECT
          status,
          completeness_status,
          evidence->>'jobName' AS job_name,
          evidence->>'reason' AS reason,
          evidence->>'notApplicableReason' AS not_applicable_reason
        FROM ops.freshness_slo_windows
        WHERE window_id = ${windowId}
      `,
      sql<Array<{ status: string; reason: string; scheduler_obligation_id: string }>>`
        SELECT
          status,
          evidence->>'reason' AS reason,
          evidence->>'schedulerObligationId' AS scheduler_obligation_id
        FROM ops.data_governance_cases
        WHERE fingerprint = ${ACCEPTED_BACKOFF_CASE_FINGERPRINT}
      `,
    ]);
    expect(obligation[0]?.status).toBe('skipped');
    expect(window[0]).toEqual({
      status: 'NOT_APPLICABLE',
      completeness_status: 'NOT_APPLICABLE',
      job_name: 'live-picks-refresh',
      reason: 'LIVE_PICKS_BACKOFF_ACCEPTED',
      not_applicable_reason: 'LIVE_PICKS_BACKOFF_ACCEPTED',
    });
    expect(governanceCase[0]).toEqual({
      status: 'DISMISSED',
      reason: 'LIVE_PICKS_BACKOFF_ACCEPTED',
      scheduler_obligation_id: ACCEPTED_BACKOFF_OBLIGATION_ID,
    });
  });

  test('keeps immutable schedule time separate from mutable retry due time', async () => {
    const sql = await getDbClient();
    const scheduledDueAt = new Date('2026-08-23T00:01:00.000Z');
    await sql`
      INSERT INTO ops.scheduler_obligations (
        obligation_id, job_name, scope_key, period_key, cadence, timezone,
        status, source, due_at, generation, attempts, evidence
      )
      VALUES (
        ${IMMUTABLE_DEADLINE_OBLIGATION_ID}::uuid,
        'integration-immutable-deadline',
        'integration:event:immutable-deadline',
        'retry-after-scheduled-boundary',
        'integration',
        'UTC',
        'failed',
        'reconcile',
        clock_timestamp() - interval '1 minute',
        1,
        2,
        jsonb_build_object('scheduledDueAtMs', ${scheduledDueAt.getTime()}::bigint)
      )
    `;

    const candidate = (await findDueSchedulerObligationCandidates({})).find(
      (row) => row.jobName === 'integration-immutable-deadline',
    );
    expect(candidate?.earliestScheduledDueAt).toEqual(scheduledDueAt);
    expect(candidate?.earliestDueAt.getTime()).toBeGreaterThan(scheduledDueAt.getTime());
  });

  test('claims the obligation whose immutable deadline selected the job', async () => {
    const sql = await getDbClient();
    await sql`
      INSERT INTO ops.scheduler_obligations (
        obligation_id, job_name, scope_key, period_key, cadence, timezone,
        status, source, due_at, generation, attempts, evidence
      )
      VALUES
        (
          ${IMMUTABLE_CLAIM_OLDER_OBLIGATION_ID}::uuid,
          'integration-immutable-claim',
          'integration:event:immutable-claim',
          'scheduled-older-retried',
          'integration',
          'UTC',
          'failed',
          'reconcile',
          clock_timestamp() - interval '1 minute',
          1,
          2,
          jsonb_build_object('scheduledDueAtMs', ${Date.parse('2026-08-23T00:01:00Z')}::bigint)
        ),
        (
          ${IMMUTABLE_CLAIM_NEWER_OBLIGATION_ID}::uuid,
          'integration-immutable-claim',
          'integration:event:immutable-claim',
          'scheduled-newer',
          'integration',
          'UTC',
          'pending',
          'schedule',
          clock_timestamp() - interval '2 minutes',
          0,
          0,
          jsonb_build_object('scheduledDueAtMs', ${Date.parse('2026-08-23T00:02:00Z')}::bigint)
        )
    `;

    const [claimed] = await claimSchedulerObligations({
      limit: 1,
      includedJobNames: ['integration-immutable-claim'],
    });
    expect(claimed?.obligation.obligationId).toBe(IMMUTABLE_CLAIM_OLDER_OBLIGATION_ID);
  });

  test('claims the current My FPL event before historical events at the same deadline', async () => {
    const sql = await getDbClient();
    await sql`
      INSERT INTO ops.scheduler_obligations (
        obligation_id, job_name, scope_key, period_key, cadence, timezone,
        status, source, due_at, generation, attempts, evidence
      )
      VALUES
        (
          ${MY_FPL_PRIORITY_HISTORICAL_OBLIGATION_ID}::uuid,
          'my-fpl-finalization',
          'integration:event:my-fpl-priority',
          'event-1',
          '30 seconds',
          'UTC',
          'pending',
          'reconcile',
          clock_timestamp() - interval '1 minute',
          0,
          0,
          jsonb_build_object('eventPriority', 2, 'scheduledDueAtMs', 1000)
        ),
        (
          ${MY_FPL_PRIORITY_CURRENT_OBLIGATION_ID}::uuid,
          'my-fpl-finalization',
          'integration:event:my-fpl-priority',
          'event-2',
          '30 seconds',
          'UTC',
          'pending',
          'reconcile',
          clock_timestamp() - interval '1 minute',
          0,
          0,
          jsonb_build_object('eventPriority', 0, 'scheduledDueAtMs', 1000)
        )
    `;

    const [claimed] = await claimSchedulerObligations({
      limit: 1,
      includedJobNames: ['my-fpl-finalization'],
    });
    expect(claimed?.obligation.obligationId).toBe(MY_FPL_PRIORITY_CURRENT_OBLIGATION_ID);
  });

  test('refreshes an existing pending My FPL obligation priority without replacing its identity', async () => {
    const sql = await getDbClient();
    const dueAt = new Date('2026-08-23T00:01:00.000Z');
    await sql`
      INSERT INTO ops.scheduler_obligations (
        obligation_id, job_name, scope_key, period_key, cadence, timezone,
        status, source, due_at, generation, attempts, evidence
      )
      VALUES (
        ${MY_FPL_PRIORITY_REFRESH_OBLIGATION_ID}::uuid,
        'my-fpl-finalization',
        'integration:event:my-fpl-priority-refresh',
        'event-1',
        '30 seconds',
        'UTC',
        'pending',
        'reconcile',
        ${dueAt.toISOString()}::timestamptz,
        3,
        2,
        jsonb_build_object(
          'eventPriority', 2,
          'scheduledDueAtMs', ${dueAt.getTime()}::bigint,
          'preservedEvidence', 'yes'
        )
      )
    `;

    const refreshed = await reserveSchedulerObligation({
      definition: { name: 'my-fpl-finalization', cadence: '30 seconds', timezone: 'UTC' },
      plan: {
        scopeKey: 'integration:event:my-fpl-priority-refresh',
        periodKey: 'event-1',
        dueAt: new Date('2026-08-23T00:02:00.000Z'),
        source: 'reconcile',
        eventId: 1,
        evidence: { eventPriority: 0 },
      },
    });

    expect(refreshed).toMatchObject({
      obligationId: MY_FPL_PRIORITY_REFRESH_OBLIGATION_ID,
      status: 'pending',
      generation: 3,
      attempts: 2,
      evidence: {
        eventPriority: 0,
        scheduledDueAtMs: dueAt.getTime(),
        preservedEvidence: 'yes',
      },
    });
  });

  test('claims one atomic capacity lane and leaves a conflicting job pending', async () => {
    const sql = await getDbClient();
    await sql`
      INSERT INTO ops.scheduler_obligations (
        obligation_id, job_name, scope_key, period_key, cadence, timezone,
        status, source, due_at, generation, attempts, evidence
      )
      VALUES
        (
          ${OBLIGATION_ID}::uuid, 'entry-results', 'integration:event:1',
          'integration-result-source', 'integration', 'UTC', 'pending', 'reconcile',
          clock_timestamp() - interval '2 minutes', 0, 0, '{}'::jsonb
        ),
        (
          ${NEWER_OBLIGATION_ID}::uuid, 'league-event-results', 'integration:event:1',
          'integration-result-derived', 'integration', 'UTC', 'pending', 'reconcile',
          clock_timestamp() - interval '1 minute', 0, 0, '{}'::jsonb
        )
    `;

    expect(await findDueSchedulerJobNames({})).toEqual(
      expect.arrayContaining(['entry-results', 'league-event-results']),
    );
    const first = await claimSchedulerObligations({
      limit: 1,
      includedJobNames: ['entry-results'],
      inFlightConflictJobNames: ['entry-results', 'league-event-results'],
      laneKeys: ['post-match-results'],
    });
    expect(first[0]?.obligation.obligationId).toBe(OBLIGATION_ID);

    const blocked = await claimSchedulerObligations({
      limit: 1,
      includedJobNames: ['league-event-results'],
      inFlightConflictJobNames: ['entry-results', 'league-event-results'],
      laneKeys: ['post-match-results'],
    });
    expect(blocked).toHaveLength(0);

    expect(
      await completeSchedulerObligation({
        obligationId: OBLIGATION_ID,
        generation: 0,
        status: 'succeeded',
      }),
    ).toBe(true);
    const second = await claimSchedulerObligations({
      limit: 1,
      includedJobNames: ['league-event-results'],
      inFlightConflictJobNames: ['entry-results', 'league-event-results'],
      laneKeys: ['post-match-results'],
    });
    expect(second[0]?.obligation.obligationId).toBe(NEWER_OBLIGATION_ID);
  });

  test('keeps enqueue acknowledgement distinct from fenced worker start', async () => {
    const sql = await getDbClient();
    await sql`
      INSERT INTO ops.scheduler_obligations (
        obligation_id,
        job_name,
        scope_key,
        period_key,
        cadence,
        timezone,
        status,
        source,
        due_at,
        generation,
        attempts,
        evidence
      )
      VALUES (
        ${OBLIGATION_ID}::uuid,
        'core-snapshot',
        'integration:core',
        'integration-fenced-start',
        'integration',
        'UTC',
        'pending',
        'schedule',
        clock_timestamp() - interval '1 minute',
        0,
        0,
        '{}'::jsonb
      )
    `;

    const [claim] = await claimSchedulerObligations();
    expect(claim?.obligation.obligationId).toBe(OBLIGATION_ID);
    expect(
      await confirmSchedulerObligationEnqueued({
        obligationId: OBLIGATION_ID,
        owner: claim!.owner,
        bullJobId: 'integration-fenced-start-job',
      }),
    ).toBe(true);

    const enqueued = await sql<Array<{ status: string }>>`
      SELECT status
      FROM ops.scheduler_obligations
      WHERE obligation_id = ${OBLIGATION_ID}::uuid
    `;
    expect(enqueued[0]?.status).toBe('enqueued');
    expect(await startSchedulerObligation({ obligationId: OBLIGATION_ID, generation: 1 })).toBe(
      false,
    );
    expect(await startSchedulerObligation({ obligationId: OBLIGATION_ID, generation: 0 })).toBe(
      true,
    );

    const running = await sql<Array<{ status: string }>>`
      SELECT status
      FROM ops.scheduler_obligations
      WHERE obligation_id = ${OBLIGATION_ID}::uuid
    `;
    expect(running[0]?.status).toBe('running');
  });

  test('clears current errors when a terminal obligation succeeds', async () => {
    const sql = await getDbClient();
    await sql`
      INSERT INTO ops.scheduler_obligations (
        obligation_id, job_name, scope_key, period_key, cadence, timezone,
        status, source, due_at, generation, attempts, last_error, evidence
      )
      VALUES (
        ${OBLIGATION_ID}::uuid,
        'entry-results',
        'integration:terminal-error-state',
        'event-1-final-error-state',
        'integration',
        'UTC',
        'running',
        'reconcile',
        clock_timestamp(),
        0,
        1,
        NULL,
        '{}'::jsonb
      )
    `;

    expect(
      await completeSchedulerObligation({
        obligationId: OBLIGATION_ID,
        generation: 0,
        status: 'succeeded',
      }),
    ).toBe(true);

    const rows = await sql<Array<{ status: string; last_error: string | null }>>`
      SELECT status, last_error
      FROM ops.scheduler_obligations
      WHERE obligation_id = ${OBLIGATION_ID}::uuid
    `;
    expect(rows[0]).toEqual({ status: 'succeeded', last_error: null });

    let rejected = false;
    try {
      await sql`
        UPDATE ops.scheduler_obligations
        SET last_error = 'must be rejected'
        WHERE obligation_id = ${OBLIGATION_ID}::uuid
      `;
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  });

  test('clears a retry error before transitioning an obligation to running', async () => {
    const sql = await getDbClient();
    await sql`
      INSERT INTO ops.scheduler_obligations (
        obligation_id, job_name, scope_key, period_key, cadence, timezone,
        status, source, due_at, generation, attempts, last_error, next_attempt_at, evidence
      )
      VALUES (
        ${RETRYING_START_OBLIGATION_ID}::uuid,
        'my-fpl-snapshot',
        'integration:retrying-start',
        'event-2-retry',
        'integration',
        'UTC',
        'retrying',
        'reconcile',
        clock_timestamp(),
        0,
        1,
        'TRANSIENT_INFRA:statement timeout',
        clock_timestamp() + interval '1 minute',
        '{}'::jsonb
      )
    `;

    expect(
      await startSchedulerObligation({
        obligationId: RETRYING_START_OBLIGATION_ID,
        generation: 0,
      }),
    ).toBe(true);

    const rows = await sql<
      Array<{ status: string; last_error: string | null; next_attempt_at: Date | null }>
    >`
      SELECT status, last_error, next_attempt_at
      FROM ops.scheduler_obligations
      WHERE obligation_id = ${RETRYING_START_OBLIGATION_ID}::uuid
    `;
    expect(rows[0]?.status).toBe('running');
    expect(rows[0]?.last_error).toBeNull();
    expect(rows[0]?.next_attempt_at).toBeNull();
  });

  test('accepts enqueue acknowledgement after a fast worker crosses its fence', async () => {
    const sql = await getDbClient();
    await sql`
      INSERT INTO ops.scheduler_obligations (
        obligation_id,
        job_name,
        scope_key,
        period_key,
        cadence,
        timezone,
        status,
        source,
        due_at,
        generation,
        attempts,
        evidence
      )
      VALUES (
        ${OBLIGATION_ID}::uuid,
        'core-snapshot',
        'integration:core',
        'integration-fast-worker',
        'integration',
        'UTC',
        'pending',
        'schedule',
        clock_timestamp() - interval '1 minute',
        0,
        0,
        '{}'::jsonb
      )
    `;

    const [claim] = await claimSchedulerObligations();
    expect(claim?.obligation.obligationId).toBe(OBLIGATION_ID);
    expect(await startSchedulerObligation({ obligationId: OBLIGATION_ID, generation: 0 })).toBe(
      true,
    );
    expect(
      await confirmSchedulerObligationEnqueued({
        obligationId: OBLIGATION_ID,
        owner: claim!.owner,
        bullJobId: 'integration-fast-worker-job',
      }),
    ).toBe(true);

    const rows = await sql<Array<{ status: string; bull_job_id: string | null }>>`
      SELECT status, bull_job_id
      FROM ops.scheduler_obligations
      WHERE obligation_id = ${OBLIGATION_ID}::uuid
    `;
    expect(rows[0]).toEqual({
      status: 'running',
      bull_job_id: 'integration-fast-worker-job',
    });
  });

  test('rejects late failure/completion and duplicate completion from an older generation', async () => {
    const sql = await getDbClient();
    await sql`
      INSERT INTO ops.scheduler_obligations (
        obligation_id,
        job_name,
        scope_key,
        period_key,
        cadence,
        timezone,
        status,
        source,
        due_at,
        generation,
        attempts,
        lease_owner,
        lease_expires_at,
        evidence
      )
      VALUES (
        ${OBLIGATION_ID}::uuid,
        'tournament-event-results',
        'integration:event:12',
        'event-12-final',
        'integration',
        'UTC',
        'running',
        'reconcile',
        clock_timestamp(),
        2,
        3,
        'generation-2-owner',
        clock_timestamp() + interval '15 minutes',
        '{}'::jsonb
      )
    `;

    expect(
      await failSchedulerObligation({
        obligationId: OBLIGATION_ID,
        generation: 1,
        error: new Error('late generation failure'),
      }),
    ).toBe(false);
    expect(
      await failSchedulerObligation({
        obligationId: OBLIGATION_ID,
        generation: 2,
        expectedStatus: 'enqueued',
        error: new Error('stale status observation'),
      }),
    ).toBe(false);
    expect(
      await completeSchedulerObligation({
        obligationId: OBLIGATION_ID,
        generation: 1,
        status: 'succeeded',
      }),
    ).toBe(false);
    expect(
      await completeSchedulerObligation({
        obligationId: OBLIGATION_ID,
        generation: 2,
        status: 'succeeded',
        evidence: { completionStage: 'materialized-view-finalizer' },
      }),
    ).toBe(true);
    expect(
      await completeSchedulerObligation({
        obligationId: OBLIGATION_ID,
        generation: 2,
        status: 'succeeded',
      }),
    ).toBe(false);

    const rows = await sql<Array<{ status: string; generation: number; completion_stage: string }>>`
      SELECT
        status,
        generation,
        evidence->>'completionStage' AS completion_stage
      FROM ops.scheduler_obligations
      WHERE obligation_id = ${OBLIGATION_ID}::uuid
    `;
    expect(rows[0]).toEqual({
      status: 'succeeded',
      generation: 2,
      completion_stage: 'materialized-view-finalizer',
    });
  });

  test('terminalizes an expired current-day lease before reclaim can launch it', async () => {
    const sql = await getDbClient();
    await sql`
      INSERT INTO ops.scheduler_obligations (
        obligation_id,
        job_name,
        scope_key,
        period_key,
        cadence,
        timezone,
        status,
        source,
        due_at,
        generation,
        attempts,
        lease_owner,
        lease_expires_at,
        evidence
      )
      VALUES (
        ${OBLIGATION_ID}::uuid,
        'market-daily',
        'integration:market',
        '20260822',
        'daily',
        'Asia/Shanghai',
        'running',
        'catchup',
        clock_timestamp() - interval '1 day',
        1,
        1,
        'expired-market-owner',
        clock_timestamp() - interval '1 minute',
        '{}'::jsonb
      )
    `;

    expect(
      await markSchedulerObligationIrrecoverable({
        obligationId: OBLIGATION_ID,
        evidence: { reason: 'market-window-expired' },
        includeInFlight: true,
      }),
    ).toBe(true);
    expect(
      await completeSchedulerObligation({
        obligationId: OBLIGATION_ID,
        generation: 1,
        status: 'succeeded',
      }),
    ).toBe(false);

    const rows = await sql<Array<{ status: string; lease_owner: string | null }>>`
      SELECT status, lease_owner
      FROM ops.scheduler_obligations
      WHERE obligation_id = ${OBLIGATION_ID}::uuid
    `;
    expect(rows[0]).toEqual({ status: 'irrecoverable', lease_owner: null });
  });

  test('leaves disabled Understat obligations pending for a later enablement', async () => {
    const sql = await getDbClient();
    await sql`
      INSERT INTO ops.scheduler_obligations (
        obligation_id,
        job_name,
        scope_key,
        period_key,
        cadence,
        timezone,
        status,
        source,
        due_at,
        generation,
        attempts,
        evidence
      )
      VALUES (
        ${OBLIGATION_ID}::uuid,
        'understat-team-incremental',
        'integration:understat',
        '20260823',
        'daily UTC+8 incremental',
        'Asia/Shanghai',
        'pending',
        'catchup',
        clock_timestamp() - interval '1 minute',
        0,
        0,
        '{}'::jsonb
      )
    `;

    expect(
      await claimSchedulerObligations({
        excludedJobNames: ['understat-team-incremental'],
      }),
    ).toHaveLength(0);
    const pending = await sql<Array<{ status: string }>>`
      SELECT status
      FROM ops.scheduler_obligations
      WHERE obligation_id = ${OBLIGATION_ID}::uuid
    `;
    expect(pending[0]?.status).toBe('pending');

    const claimed = await claimSchedulerObligations({
      excludedJobNames: ['understat-player-incremental'],
    });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.obligation.jobName).toBe('understat-team-incremental');
  });

  test('coalesces an older pending Understat daily checkpoint', async () => {
    const sql = await getDbClient();
    await sql`
      INSERT INTO ops.scheduler_obligations (
        obligation_id,
        job_name,
        scope_key,
        period_key,
        cadence,
        timezone,
        status,
        source,
        due_at,
        generation,
        attempts,
        evidence
      )
      VALUES (
        ${OBLIGATION_ID}::uuid,
        'understat-team-incremental',
        'integration:understat',
        '20260822',
        'daily UTC+8 incremental',
        'Asia/Shanghai',
        'pending',
        'catchup',
        clock_timestamp() - interval '1 day',
        0,
        0,
        '{}'::jsonb
      )
    `;

    expect(
      await supersedeSchedulerObligations({
        jobName: 'understat-team-incremental',
        beforePeriodKey: '20260823',
        evidence: { supersededByPeriodKey: '20260823' },
      }),
    ).toBe(1);
    const rows = await sql<Array<{ status: string; reason: string }>>`
      SELECT status, evidence->>'reason' AS reason
      FROM ops.scheduler_obligations
      WHERE obligation_id = ${OBLIGATION_ID}::uuid
    `;
    expect(rows[0]).toEqual({
      status: 'skipped',
      reason: 'superseded-by-latest-authoritative',
    });
  });

  test('coalesces an older failed price-change bucket by due time', async () => {
    const sql = await getDbClient();
    await sql`
      INSERT INTO ops.scheduler_obligations (
        obligation_id,
        job_name,
        scope_key,
        period_key,
        cadence,
        timezone,
        status,
        source,
        due_at,
        generation,
        attempts,
        evidence
      )
      VALUES (
        ${OBLIGATION_ID}::uuid,
        'price-change-predictions',
        '2627',
        'price-change-1',
        'every five minutes at UTC minute 01/06/11...',
        'UTC',
        'failed',
        'catchup',
        '2026-08-23T00:01:00Z'::timestamptz,
        0,
        1,
        '{}'::jsonb
      )
    `;

    expect(
      await supersedeSchedulerObligationsByDueAt({
        jobName: 'price-change-predictions',
        scopeKey: '2627',
        beforeDueAt: new Date('2026-08-23T00:06:00Z'),
        evidence: { supersededByPeriodKey: 'price-change-2' },
      }),
    ).toBe(1);
    const rows = await sql<Array<{ status: string; reason: string; provider: string }>>`
      SELECT status, evidence->>'reason' AS reason, evidence->>'provider' AS provider
      FROM ops.scheduler_obligations
      WHERE obligation_id = ${OBLIGATION_ID}::uuid
    `;
    expect(rows[0]).toEqual({
      status: 'skipped',
      reason: 'superseded-by-latest-authoritative',
      provider: 'fpl',
    });
  });

  test('coalesces an older failed bucket after its retry due time crosses the boundary', async () => {
    const sql = await getDbClient();
    const scheduledDueAtMs = Date.parse('2026-08-23T00:01:00Z');
    await sql`
      INSERT INTO ops.scheduler_obligations (
        obligation_id,
        job_name,
        scope_key,
        period_key,
        cadence,
        timezone,
        status,
        source,
        due_at,
        generation,
        attempts,
        evidence
      )
      VALUES (
        ${OBLIGATION_ID}::uuid,
        'price-change-predictions',
        '2627',
        'price-change-3',
        'every five minutes at UTC minute 01/06/11...',
        'UTC',
        'failed',
        'catchup',
        '2026-08-23T00:07:00Z'::timestamptz,
        1,
        2,
        jsonb_build_object('scheduledDueAtMs', ${scheduledDueAtMs}::bigint)
      )
    `;

    expect(
      await supersedeSchedulerObligationsByDueAt({
        jobName: 'price-change-predictions',
        scopeKey: '2627',
        beforeDueAt: new Date('2026-08-23T00:06:00Z'),
        evidence: { supersededByPeriodKey: 'price-change-4' },
      }),
    ).toBe(1);
    const rows = await sql<Array<{ status: string; reason: string }>>`
      SELECT status, evidence->>'reason' AS reason
      FROM ops.scheduler_obligations
      WHERE obligation_id = ${OBLIGATION_ID}::uuid
    `;
    expect(rows[0]).toEqual({
      status: 'skipped',
      reason: 'superseded-by-latest-authoritative',
    });
  });

  test('batches post-match peers without superseding the current identity or in-flight work', async () => {
    const sql = await getDbClient();
    const currentMovedDueAtMs = Date.parse('2026-08-23T11:00:00Z');
    await sql`
      INSERT INTO ops.scheduler_obligations (
        obligation_id,
        job_name,
        scope_key,
        period_key,
        cadence,
        timezone,
        status,
        source,
        due_at,
        generation,
        attempts,
        lease_owner,
        lease_expires_at,
        evidence
      )
      VALUES
        (
          ${OBLIGATION_ID}::uuid,
          'entry-results',
          '2627:event:1',
          'event-1-provisional-15',
          'hourly post-match',
          'UTC',
          'pending',
          'reconcile',
          '2026-08-23T12:11:00Z'::timestamptz,
          0,
          0,
          NULL,
          NULL,
          jsonb_build_object('resultSlot', 'provisional-15')
        ),
        (
          ${NEWER_OBLIGATION_ID}::uuid,
          'entry-results',
          '2627:event:1',
          'event-1-final-15',
          'hourly post-match',
          'UTC',
          'pending',
          'reconcile',
          '2026-08-23T11:00:00Z'::timestamptz,
          0,
          0,
          NULL,
          NULL,
          jsonb_build_object(
            'scheduledDueAtMs', ${currentMovedDueAtMs}::bigint,
            'resultSlot', 'final-15'
          )
        ),
        (
          ${IN_FLIGHT_OBLIGATION_ID}::uuid,
          'entry-results',
          '2627:event:1',
          'event-1-provisional-14',
          'hourly post-match',
          'UTC',
          'running',
          'reconcile',
          '2026-08-23T11:00:00Z'::timestamptz,
          0,
          1,
          'integration-worker',
          clock_timestamp() + interval '15 minutes',
          jsonb_build_object('resultSlot', 'provisional-14')
        ),
        (
          ${SECOND_OLDER_OBLIGATION_ID}::uuid,
          'league-event-results',
          '2627:event:1',
          'event-1-provisional-14',
          'hourly post-match',
          'UTC',
          'failed',
          'reconcile',
          '2026-08-23T11:00:00Z'::timestamptz,
          1,
          1,
          NULL,
          NULL,
          jsonb_build_object('resultSlot', 'provisional-14')
        ),
        (
          ${SECOND_CURRENT_OBLIGATION_ID}::uuid,
          'league-event-results',
          '2627:event:1',
          'event-1-final-15',
          'hourly post-match',
          'UTC',
          'pending',
          'reconcile',
          '2026-08-23T12:00:00Z'::timestamptz,
          0,
          0,
          NULL,
          NULL,
          jsonb_build_object('resultSlot', 'final-15')
        )
    `;

    expect(
      await supersedeSchedulerObligationsByDueAtBatch({
        boundaries: [
          {
            jobName: 'entry-results',
            scopeKey: '2627:event:1',
            periodKey: 'event-1-final-15',
            resultSlot: 'final-15',
            beforeDueAt: new Date('2026-08-23T12:00:00Z'),
          },
          {
            jobName: 'league-event-results',
            scopeKey: '2627:event:1',
            periodKey: 'event-1-final-15',
            resultSlot: 'final-15',
            beforeDueAt: new Date('2026-08-23T12:00:00Z'),
          },
        ],
        evidence: { checkpoint: 'post-match-results' },
      }),
    ).toBe(2);

    const rows = await sql<
      Array<{ obligationId: string; status: string; supersededByPeriodKey: string | null }>
    >`
      SELECT obligation_id AS "obligationId",
             status,
             evidence->>'supersededByPeriodKey' AS "supersededByPeriodKey"
      FROM ops.scheduler_obligations
      WHERE obligation_id IN (
        ${OBLIGATION_ID}::uuid,
        ${NEWER_OBLIGATION_ID}::uuid,
        ${IN_FLIGHT_OBLIGATION_ID}::uuid,
        ${SECOND_OLDER_OBLIGATION_ID}::uuid,
        ${SECOND_CURRENT_OBLIGATION_ID}::uuid
      )
      ORDER BY obligation_id
    `;
    expect([...rows]).toEqual([
      {
        obligationId: OBLIGATION_ID,
        status: 'skipped',
        supersededByPeriodKey: 'event-1-final-15',
      },
      {
        obligationId: NEWER_OBLIGATION_ID,
        status: 'pending',
        supersededByPeriodKey: null,
      },
      {
        obligationId: IN_FLIGHT_OBLIGATION_ID,
        status: 'running',
        supersededByPeriodKey: null,
      },
      {
        obligationId: SECOND_OLDER_OBLIGATION_ID,
        status: 'skipped',
        supersededByPeriodKey: 'event-1-final-15',
      },
      {
        obligationId: SECOND_CURRENT_OBLIGATION_ID,
        status: 'pending',
        supersededByPeriodKey: null,
      },
    ]);
  });

  test('does not let a stale provisional boundary supersede same-slot final authority', async () => {
    const sql = await getDbClient();
    await sql`
      INSERT INTO ops.scheduler_obligations (
        obligation_id, job_name, scope_key, period_key, cadence, timezone,
        status, source, due_at, generation, attempts, evidence
      )
      VALUES (
        ${OBLIGATION_ID}::uuid,
        'entry-results',
        'integration:event:reverse-finality',
        'event-1-final-15',
        'hourly post-match',
        'UTC',
        'pending',
        'reconcile',
        '2026-08-23T12:00:00Z'::timestamptz,
        0,
        0,
        jsonb_build_object('resultSlot', 'final-15')
      )
    `;

    expect(
      await supersedeSchedulerObligationsByDueAtBatch({
        boundaries: [
          {
            jobName: 'entry-results',
            scopeKey: 'integration:event:reverse-finality',
            periodKey: 'event-1-provisional-15',
            resultSlot: 'provisional-15',
            beforeDueAt: new Date('2026-08-23T12:00:00Z'),
          },
        ],
      }),
    ).toBe(0);
    const [final] = await sql<Array<{ status: string }>>`
      SELECT status
      FROM ops.scheduler_obligations
      WHERE obligation_id = ${OBLIGATION_ID}::uuid
    `;
    expect(final?.status).toBe('pending');
  });

  test('ranks a rescheduled checkpoint by immutable time instead of its slot suffix', async () => {
    const sql = await getDbClient();
    await sql`
      INSERT INTO ops.scheduler_obligations (
        obligation_id, job_name, scope_key, period_key, cadence, timezone,
        status, source, due_at, generation, attempts, evidence
      )
      VALUES (
        ${OBLIGATION_ID}::uuid,
        'entry-results',
        'integration:event:atomic-reschedule',
        'event-1-final-16',
        'hourly post-match',
        'UTC',
        'pending',
        'reconcile',
        '2026-08-23T12:00:00Z'::timestamptz,
        0,
        0,
        jsonb_build_object('resultSlot', 'final-16')
      )
    `;

    const result = await reconcilePostMatchSchedulerObligations({
      reservations: [
        {
          definition: {
            name: 'entry-results',
            cadence: 'hourly post-match',
            timezone: 'UTC',
          },
          plan: {
            scopeKey: 'integration:event:atomic-reschedule',
            periodKey: 'event-1-final-14',
            dueAt: new Date('2026-08-23T13:00:00Z'),
            source: 'reconcile',
            eventId: 1,
            evidence: { resultSlot: 'final-14' },
          },
        },
      ],
      boundaries: [
        {
          jobName: 'entry-results',
          scopeKey: 'integration:event:atomic-reschedule',
          periodKey: 'event-1-final-14',
          resultSlot: 'final-14',
          beforeDueAt: new Date('2026-08-23T13:00:00Z'),
        },
      ],
      evidence: { checkpoint: 'post-match-results' },
    });
    expect(result.reservations).toHaveLength(1);
    expect(result.superseded).toBe(1);

    const rows = await sql<Array<{ periodKey: string; status: string }>>`
      SELECT period_key AS "periodKey", status
      FROM ops.scheduler_obligations
      WHERE scope_key = 'integration:event:atomic-reschedule'
      ORDER BY period_key
    `;
    expect([...rows]).toEqual([
      { periodKey: 'event-1-final-14', status: 'pending' },
      { periodKey: 'event-1-final-16', status: 'skipped' },
    ]);

    const [claimed] = await claimSchedulerObligations({
      limit: 1,
      includedJobNames: ['entry-results'],
      laneKeys: ['post-match-results'],
      enforceLatestAuthoritativeScope: true,
    });
    expect(claimed?.obligation.periodKey).toBe('event-1-final-14');
  });

  test('keeps fresh authority when a stale equal-boundary resolver acquires the lock last', async () => {
    const sql = await getDbClient();
    const staleAuthorityAtMs = Date.parse('2026-08-23T10:00:00Z');
    const freshAuthorityAtMs = Date.parse('2026-08-23T11:00:00Z');
    const staleScheduleAnchorMs = Date.parse('2026-08-22T18:00:00Z');
    const freshScheduleAnchorMs = Date.parse('2026-08-22T20:00:00Z');
    await sql`
      INSERT INTO ops.scheduler_obligations (
        obligation_id, job_name, scope_key, period_key, cadence, timezone,
        status, source, due_at, generation, attempts, evidence
      )
      VALUES (
        ${OBLIGATION_ID}::uuid,
        'entry-results',
        'integration:event:equal-boundary-reschedule',
        'event-1-final-16',
        'hourly post-match',
        'UTC',
        'pending',
        'reconcile',
        '2026-08-23T12:00:00Z'::timestamptz,
        0,
        0,
        jsonb_build_object(
          'resultSlot', 'final-16',
          'resultAuthorityAtMs', ${staleAuthorityAtMs}::bigint,
          'resultScheduleAnchorMs', ${staleScheduleAnchorMs}::bigint
        )
      )
    `;

    const result = await reconcilePostMatchSchedulerObligations({
      reservations: [
        {
          definition: {
            name: 'entry-results',
            cadence: 'hourly post-match',
            timezone: 'UTC',
          },
          plan: {
            scopeKey: 'integration:event:equal-boundary-reschedule',
            periodKey: 'event-1-final-14',
            dueAt: new Date('2026-08-23T12:00:00Z'),
            source: 'reconcile',
            eventId: 1,
            evidence: {
              resultSlot: 'final-14',
              resultAuthorityAtMs: freshAuthorityAtMs,
              resultScheduleAnchorMs: freshScheduleAnchorMs,
            },
          },
        },
      ],
      boundaries: [
        {
          jobName: 'entry-results',
          scopeKey: 'integration:event:equal-boundary-reschedule',
          periodKey: 'event-1-final-14',
          resultSlot: 'final-14',
          resultAuthorityAtMs: freshAuthorityAtMs,
          resultScheduleAnchorMs: freshScheduleAnchorMs,
          beforeDueAt: new Date('2026-08-23T12:00:00Z'),
        },
      ],
      evidence: { checkpoint: 'post-match-results' },
    });
    expect(result.reservations).toHaveLength(1);
    expect(result.superseded).toBe(1);

    const staleResult = await reconcilePostMatchSchedulerObligations({
      reservations: [
        {
          definition: {
            name: 'entry-results',
            cadence: 'hourly post-match',
            timezone: 'UTC',
          },
          plan: {
            scopeKey: 'integration:event:equal-boundary-reschedule',
            periodKey: 'event-1-final-16',
            dueAt: new Date('2026-08-23T12:00:00Z'),
            source: 'reconcile',
            eventId: 1,
            evidence: {
              resultSlot: 'final-16',
              resultAuthorityAtMs: staleAuthorityAtMs,
              resultScheduleAnchorMs: staleScheduleAnchorMs,
            },
          },
        },
      ],
      boundaries: [
        {
          jobName: 'entry-results',
          scopeKey: 'integration:event:equal-boundary-reschedule',
          periodKey: 'event-1-final-16',
          resultSlot: 'final-16',
          resultAuthorityAtMs: staleAuthorityAtMs,
          resultScheduleAnchorMs: staleScheduleAnchorMs,
          beforeDueAt: new Date('2026-08-23T12:00:00Z'),
        },
      ],
      evidence: { checkpoint: 'post-match-results' },
    });
    expect(staleResult.reservations).toHaveLength(1);
    expect(staleResult.superseded).toBe(0);

    const rows = await sql<Array<{ periodKey: string; status: string }>>`
      SELECT period_key AS "periodKey", status
      FROM ops.scheduler_obligations
      WHERE scope_key = 'integration:event:equal-boundary-reschedule'
      ORDER BY period_key
    `;
    expect([...rows]).toEqual([
      { periodKey: 'event-1-final-14', status: 'pending' },
      { periodKey: 'event-1-final-16', status: 'skipped' },
    ]);

    const [claimed] = await claimSchedulerObligations({
      limit: 1,
      includedJobNames: ['entry-results'],
      laneKeys: ['post-match-results'],
      enforceLatestAuthoritativeScope: true,
    });
    expect(claimed?.obligation.periodKey).toBe('event-1-final-14');
    expect(
      await completeSchedulerObligation({
        obligationId: claimed!.obligation.obligationId,
        generation: claimed!.obligation.generation,
        status: 'succeeded',
      }),
    ).toBe(true);

    const newestAuthorityAtMs = Date.parse('2026-08-23T13:00:00Z');
    const reappeared = await reconcilePostMatchSchedulerObligations({
      reservations: [
        {
          definition: {
            name: 'entry-results',
            cadence: 'hourly post-match',
            timezone: 'UTC',
          },
          plan: {
            scopeKey: 'integration:event:equal-boundary-reschedule',
            periodKey: 'event-1-final-16',
            dueAt: new Date('2026-08-23T12:00:00Z'),
            source: 'reconcile',
            eventId: 1,
            evidence: {
              resultSlot: 'final-16',
              resultAuthorityAtMs: newestAuthorityAtMs,
              resultScheduleAnchorMs: staleScheduleAnchorMs,
            },
          },
        },
      ],
      boundaries: [
        {
          jobName: 'entry-results',
          scopeKey: 'integration:event:equal-boundary-reschedule',
          periodKey: 'event-1-final-16',
          resultSlot: 'final-16',
          resultAuthorityAtMs: newestAuthorityAtMs,
          resultScheduleAnchorMs: staleScheduleAnchorMs,
          beforeDueAt: new Date('2026-08-23T12:00:00Z'),
        },
      ],
    });
    expect(reappeared.reservations[0]).toMatchObject({
      periodKey: 'event-1-final-16',
      status: 'pending',
      generation: 1,
    });

    const [reclaimed] = await claimSchedulerObligations({
      limit: 1,
      includedJobNames: ['entry-results'],
      laneKeys: ['post-match-results'],
      enforceLatestAuthoritativeScope: true,
    });
    expect(reclaimed?.obligation).toMatchObject({
      periodKey: 'event-1-final-16',
      generation: 1,
    });
  });

  test('reopens a succeeded slot only when its durable schedule anchor changes', async () => {
    const sql = await getDbClient();
    const originalAuthorityAtMs = Date.parse('2026-08-23T10:00:00Z');
    const ordinaryRefreshAuthorityAtMs = Date.parse('2026-08-23T10:30:00Z');
    const correctedAuthorityAtMs = Date.parse('2026-08-23T11:00:00Z');
    const originalScheduleAnchorMs = Date.parse('2026-08-22T18:00:00Z');
    const correctedScheduleAnchorMs = Date.parse('2026-08-22T18:15:00Z');
    await sql`
      INSERT INTO ops.scheduler_obligations (
        obligation_id, job_name, scope_key, period_key, cadence, timezone,
        status, source, due_at, generation, attempts, completed_at, evidence
      )
      VALUES (
        ${OBLIGATION_ID}::uuid,
        'entry-results',
        'integration:event:same-slot-correction',
        'event-1-final-14',
        'hourly post-match',
        'UTC',
        'succeeded',
        'reconcile',
        '2026-08-23T12:00:00Z'::timestamptz,
        0,
        1,
        '2026-08-23T12:05:00Z'::timestamptz,
        jsonb_build_object(
          'scheduledDueAtMs', ${Date.parse('2026-08-23T12:00:00Z')}::bigint,
          'resultSlot', 'final-14',
          'resultAuthorityAtMs', ${originalAuthorityAtMs}::bigint,
          'resultScheduleAnchorMs', ${originalScheduleAnchorMs}::bigint
        )
      )
    `;

    const unchanged = await reconcilePostMatchSchedulerObligations({
      reservations: [
        {
          definition: {
            name: 'entry-results',
            cadence: 'hourly post-match',
            timezone: 'UTC',
          },
          plan: {
            scopeKey: 'integration:event:same-slot-correction',
            periodKey: 'event-1-final-14',
            dueAt: new Date('2026-08-23T12:00:00Z'),
            source: 'reconcile',
            eventId: 1,
            evidence: {
              resultSlot: 'final-14',
              resultAuthorityAtMs: ordinaryRefreshAuthorityAtMs,
              resultScheduleAnchorMs: originalScheduleAnchorMs,
            },
          },
        },
      ],
      boundaries: [
        {
          jobName: 'entry-results',
          scopeKey: 'integration:event:same-slot-correction',
          periodKey: 'event-1-final-14',
          resultSlot: 'final-14',
          resultAuthorityAtMs: ordinaryRefreshAuthorityAtMs,
          resultScheduleAnchorMs: originalScheduleAnchorMs,
          beforeDueAt: new Date('2026-08-23T12:00:00Z'),
        },
      ],
    });
    expect(unchanged.reservations[0]).toMatchObject({
      status: 'succeeded',
      generation: 0,
      evidence: expect.objectContaining({
        resultAuthorityAtMs: ordinaryRefreshAuthorityAtMs,
        resultScheduleAnchorMs: originalScheduleAnchorMs,
      }),
    });

    const reopened = await reconcilePostMatchSchedulerObligations({
      reservations: [
        {
          definition: {
            name: 'entry-results',
            cadence: 'hourly post-match',
            timezone: 'UTC',
          },
          plan: {
            scopeKey: 'integration:event:same-slot-correction',
            periodKey: 'event-1-final-14',
            dueAt: new Date('2026-08-23T12:15:00Z'),
            source: 'reconcile',
            eventId: 1,
            evidence: {
              resultSlot: 'final-14',
              resultAuthorityAtMs: correctedAuthorityAtMs,
              resultScheduleAnchorMs: correctedScheduleAnchorMs,
            },
          },
        },
      ],
      boundaries: [
        {
          jobName: 'entry-results',
          scopeKey: 'integration:event:same-slot-correction',
          periodKey: 'event-1-final-14',
          resultSlot: 'final-14',
          resultAuthorityAtMs: correctedAuthorityAtMs,
          resultScheduleAnchorMs: correctedScheduleAnchorMs,
          beforeDueAt: new Date('2026-08-23T12:15:00Z'),
        },
      ],
    });
    expect(reopened.reservations[0]).toMatchObject({
      status: 'pending',
      generation: 1,
      dueAt: new Date('2026-08-23T12:15:00Z'),
      evidence: expect.objectContaining({
        resultAuthorityAtMs: correctedAuthorityAtMs,
        resultScheduleAnchorMs: correctedScheduleAnchorMs,
        reactivatedForScheduleAuthority: true,
      }),
    });

    const [claimed] = await claimSchedulerObligations({
      limit: 1,
      includedJobNames: ['entry-results'],
      laneKeys: ['post-match-results'],
      enforceLatestAuthoritativeScope: true,
    });
    expect(claimed?.obligation).toMatchObject({
      periodKey: 'event-1-final-14',
      generation: 1,
    });
  });

  test('reopens an old live-finalization success while league evidence is still missing', async () => {
    const sql = await getDbClient();
    const dueAt = new Date('2026-08-23T12:00:00Z');
    const authorityAtMs = Date.parse('2026-08-23T11:00:00Z');
    const scheduleAnchorMs = Date.parse('2026-08-22T18:00:00Z');
    await sql`
      INSERT INTO ops.scheduler_obligations (
        obligation_id, job_name, scope_key, period_key, cadence, timezone,
        status, source, due_at, generation, attempts, completed_at, evidence
      )
      VALUES (
        ${OBLIGATION_ID}::uuid,
        'live-finalization',
        'integration:event:live-finalization',
        'case-a',
        '30-second post-match finalization reconciliation',
        'UTC',
        'succeeded',
        'catchup',
        ${dueAt.toISOString()}::timestamptz,
        2,
        2,
        '2026-08-23T12:01:00Z'::timestamptz,
        jsonb_build_object(
          'resultSlot', 'final-checkpoint',
          'resultAuthorityAtMs', ${authorityAtMs}::bigint,
          'resultScheduleAnchorMs', ${scheduleAnchorMs}::bigint
        )
      )
    `;

    const result = await reconcilePostMatchSchedulerObligations({
      reservations: [
        {
          definition: {
            name: 'live-finalization',
            cadence: '30-second post-match finalization reconciliation',
            timezone: 'UTC',
          },
          plan: {
            scopeKey: 'integration:event:live-finalization',
            periodKey: 'case-a',
            dueAt,
            source: 'catchup',
            eventId: 1,
            evidence: {
              resultSlot: 'final-checkpoint',
              resultAuthorityAtMs: authorityAtMs,
              resultScheduleAnchorMs: scheduleAnchorMs,
            },
          },
        },
      ],
      boundaries: [],
    });

    expect(result.reservations[0]).toMatchObject({
      status: 'pending',
      generation: 3,
      evidence: expect.objectContaining({ reactivatedForFinalization: true }),
    });
  });

  test('defers a running worker generation without consuming a scheduler attempt', async () => {
    const sql = await getDbClient();
    await sql`
      INSERT INTO ops.scheduler_obligations (
        obligation_id, job_name, scope_key, period_key, cadence, timezone,
        status, source, due_at, generation, attempts, bull_job_id, run_id, evidence
      )
      VALUES (
        ${OBLIGATION_ID}::uuid,
        'live-finalization',
        'integration:event:worker-deferral',
        'case-b',
        '30-second post-match finalization reconciliation',
        'UTC',
        'running',
        'catchup',
        clock_timestamp(),
        4,
        1,
        'live-finalization-bull',
        '40000000-0000-4000-8000-000000000001'::uuid,
        jsonb_build_object('resultSlot', 'final-checkpoint')
      )
    `;

    expect(
      await deferSchedulerObligationForWorker({
        obligationId: OBLIGATION_ID,
        generation: 4,
        delayMs: 60_000,
        evidence: { finalization: 'waiting-for-league-evidence' },
      }),
    ).toBe(true);
    const [row] = await sql<Array<{ status: string; attempts: number; evidence: unknown }>>`
      SELECT status, attempts, evidence
      FROM ops.scheduler_obligations
      WHERE obligation_id = ${OBLIGATION_ID}::uuid
    `;
    expect(row).toMatchObject({
      status: 'pending',
      attempts: 1,
      evidence: expect.objectContaining({ finalization: 'waiting-for-league-evidence' }),
    });
  });

  test('retries a corrected same-slot authority after the in-flight generation drains', async () => {
    const sql = await getDbClient();
    const originalAuthorityAtMs = Date.parse('2026-08-23T10:00:00Z');
    const correctedAuthorityAtMs = Date.parse('2026-08-23T11:00:00Z');
    const originalScheduleAnchorMs = Date.parse('2026-08-22T18:00:00Z');
    const correctedScheduleAnchorMs = Date.parse('2026-08-22T18:15:00Z');
    await sql`
      INSERT INTO ops.scheduler_obligations (
        obligation_id, job_name, scope_key, period_key, cadence, timezone,
        status, source, due_at, generation, attempts, run_id,
        lease_owner, lease_expires_at, evidence
      )
      VALUES (
        ${OBLIGATION_ID}::uuid,
        'entry-results',
        'integration:event:in-flight-correction',
        'event-1-final-14',
        'hourly post-match',
        'UTC',
        'running',
        'reconcile',
        '2026-08-23T12:00:00Z'::timestamptz,
        0,
        1,
        '30000000-0000-4000-8000-000000000099'::uuid,
        'integration-worker',
        '2026-08-23T12:30:00Z'::timestamptz,
        jsonb_build_object(
          'scheduledDueAtMs', ${Date.parse('2026-08-23T12:00:00Z')}::bigint,
          'resultSlot', 'final-14',
          'resultAuthorityAtMs', ${originalAuthorityAtMs}::bigint,
          'resultScheduleAnchorMs', ${originalScheduleAnchorMs}::bigint
        )
      )
    `;
    const reservation = {
      definition: {
        name: 'entry-results',
        cadence: 'hourly post-match',
        timezone: 'UTC',
      },
      plan: {
        scopeKey: 'integration:event:in-flight-correction',
        periodKey: 'event-1-final-14',
        dueAt: new Date('2026-08-23T12:15:00Z'),
        source: 'reconcile' as const,
        eventId: 1,
        evidence: {
          resultSlot: 'final-14',
          resultAuthorityAtMs: correctedAuthorityAtMs,
          resultScheduleAnchorMs: correctedScheduleAnchorMs,
        },
      },
    };
    const boundary = {
      jobName: 'entry-results',
      scopeKey: 'integration:event:in-flight-correction',
      periodKey: 'event-1-final-14',
      resultSlot: 'final-14',
      resultAuthorityAtMs: correctedAuthorityAtMs,
      resultScheduleAnchorMs: correctedScheduleAnchorMs,
      beforeDueAt: new Date('2026-08-23T12:15:00Z'),
    };

    const inFlight = await reconcilePostMatchSchedulerObligations({
      reservations: [reservation],
      boundaries: [boundary],
    });
    expect(inFlight.reservations[0]).toMatchObject({
      status: 'running',
      generation: 0,
      evidence: expect.objectContaining({
        resultAuthorityAtMs: originalAuthorityAtMs,
        resultScheduleAnchorMs: originalScheduleAnchorMs,
      }),
    });

    await sql`
      UPDATE ops.scheduler_obligations
      SET status = 'succeeded',
          completed_at = clock_timestamp(),
          lease_owner = NULL,
          lease_expires_at = NULL
      WHERE obligation_id = ${OBLIGATION_ID}::uuid
    `;

    const retried = await reconcilePostMatchSchedulerObligations({
      reservations: [reservation],
      boundaries: [boundary],
    });
    expect(retried.reservations[0]).toMatchObject({
      status: 'pending',
      generation: 1,
      dueAt: new Date('2026-08-23T12:15:00Z'),
      runId: null,
      evidence: expect.objectContaining({
        resultAuthorityAtMs: correctedAuthorityAtMs,
        resultScheduleAnchorMs: correctedScheduleAnchorMs,
        reactivatedForScheduleAuthority: true,
      }),
    });
  });

  test('preserves failed backoff for authority-only refresh and resets it for a schedule change', async () => {
    const sql = await getDbClient();
    const originalAuthorityAtMs = Date.parse('2026-08-23T10:00:00Z');
    const ordinaryRefreshAuthorityAtMs = Date.parse('2026-08-23T10:30:00Z');
    const correctedAuthorityAtMs = Date.parse('2026-08-23T11:00:00Z');
    const originalScheduleAnchorMs = Date.parse('2026-08-22T18:00:00Z');
    const correctedScheduleAnchorMs = Date.parse('2026-08-22T18:15:00Z');
    const retryDueAt = new Date('2026-08-23T14:00:00Z');
    await sql`
      INSERT INTO ops.scheduler_obligations (
        obligation_id, job_name, scope_key, period_key, cadence, timezone,
        status, source, due_at, generation, attempts, last_error, evidence
      )
      VALUES (
        ${OBLIGATION_ID}::uuid,
        'entry-results',
        'integration:event:retry-delay',
        'event-1-final-14',
        'hourly post-match',
        'UTC',
        'failed',
        'reconcile',
        ${retryDueAt.toISOString()}::timestamptz,
        0,
        1,
        'retry later',
        jsonb_build_object(
          'scheduledDueAtMs', ${Date.parse('2026-08-23T12:00:00Z')}::bigint,
          'resultSlot', 'final-14',
          'resultAuthorityAtMs', ${originalAuthorityAtMs}::bigint,
          'resultScheduleAnchorMs', ${originalScheduleAnchorMs}::bigint
        )
      )
    `;
    const definition = {
      name: 'entry-results',
      cadence: 'hourly post-match',
      timezone: 'UTC',
    };
    const basePlan = {
      scopeKey: 'integration:event:retry-delay',
      periodKey: 'event-1-final-14',
      dueAt: new Date('2026-08-23T12:00:00Z'),
      source: 'reconcile' as const,
      eventId: 1,
      evidence: {
        resultSlot: 'final-14',
        resultAuthorityAtMs: ordinaryRefreshAuthorityAtMs,
        resultScheduleAnchorMs: originalScheduleAnchorMs,
      },
    };
    const authorityOnly = await reconcilePostMatchSchedulerObligations({
      reservations: [{ definition, plan: basePlan }],
      boundaries: [
        {
          jobName: 'entry-results',
          scopeKey: basePlan.scopeKey,
          periodKey: basePlan.periodKey,
          resultSlot: 'final-14',
          resultAuthorityAtMs: ordinaryRefreshAuthorityAtMs,
          resultScheduleAnchorMs: originalScheduleAnchorMs,
          beforeDueAt: basePlan.dueAt,
        },
      ],
    });
    expect(authorityOnly.reservations[0]).toMatchObject({
      status: 'failed',
      dueAt: retryDueAt,
      evidence: expect.objectContaining({
        resultAuthorityAtMs: ordinaryRefreshAuthorityAtMs,
        resultScheduleAnchorMs: originalScheduleAnchorMs,
      }),
    });

    const correctedDueAt = new Date('2026-08-23T12:15:00Z');
    const correctedPlan = {
      ...basePlan,
      dueAt: correctedDueAt,
      evidence: {
        ...basePlan.evidence,
        resultAuthorityAtMs: correctedAuthorityAtMs,
        resultScheduleAnchorMs: correctedScheduleAnchorMs,
      },
    };
    const corrected = await reconcilePostMatchSchedulerObligations({
      reservations: [{ definition, plan: correctedPlan }],
      boundaries: [
        {
          jobName: 'entry-results',
          scopeKey: correctedPlan.scopeKey,
          periodKey: correctedPlan.periodKey,
          resultSlot: 'final-14',
          resultAuthorityAtMs: correctedAuthorityAtMs,
          resultScheduleAnchorMs: correctedScheduleAnchorMs,
          beforeDueAt: correctedDueAt,
        },
      ],
    });
    expect(corrected.reservations[0]).toMatchObject({
      status: 'failed',
      dueAt: correctedDueAt,
      evidence: expect.objectContaining({
        resultAuthorityAtMs: correctedAuthorityAtMs,
        resultScheduleAnchorMs: correctedScheduleAnchorMs,
      }),
    });
  });

  test('never claims a late older post-match identity after a newer one exists', async () => {
    const sql = await getDbClient();
    await sql`
      INSERT INTO ops.scheduler_obligations (
        obligation_id,
        job_name,
        scope_key,
        period_key,
        cadence,
        timezone,
        status,
        source,
        due_at,
        generation,
        attempts,
        evidence
      )
      VALUES
        (
          ${LATE_OLDER_OBLIGATION_ID}::uuid,
          'entry-results',
          'integration:event:late-parent',
          'event-1-final-15',
          'hourly post-match',
          'UTC',
          'pending',
          'reconcile',
          clock_timestamp() - interval '2 minutes',
          0,
          0,
          jsonb_build_object('resultSlot', 'final-15')
        ),
        (
          ${LATEST_OBLIGATION_ID}::uuid,
          'entry-results',
          'integration:event:late-parent',
          'event-1-final-16',
          'hourly post-match',
          'UTC',
          'pending',
          'reconcile',
          clock_timestamp() - interval '1 minute',
          0,
          0,
          jsonb_build_object('resultSlot', 'final-16')
        )
    `;

    const [latest] = await claimSchedulerObligations({
      limit: 1,
      includedJobNames: ['entry-results'],
      enforceLatestAuthoritativeScope: true,
    });
    expect(latest?.obligation.obligationId).toBe(LATEST_OBLIGATION_ID);
    expect(
      await completeSchedulerObligation({
        obligationId: LATEST_OBLIGATION_ID,
        generation: 0,
        status: 'succeeded',
      }),
    ).toBe(true);

    expect(
      await claimSchedulerObligations({
        limit: 1,
        includedJobNames: ['entry-results'],
        enforceLatestAuthoritativeScope: true,
      }),
    ).toHaveLength(0);
    const [older] = await sql<Array<{ status: string }>>`
      SELECT status
      FROM ops.scheduler_obligations
      WHERE obligation_id = ${LATE_OLDER_OBLIGATION_ID}::uuid
    `;
    expect(older?.status).toBe('pending');
  });

  test('waits for an uncommitted post-match reservation before taking the claim snapshot', async () => {
    const sql = await getDbClient();
    await sql`
      INSERT INTO ops.scheduler_obligations (
        obligation_id, job_name, scope_key, period_key, cadence, timezone,
        status, source, due_at, generation, attempts, evidence
      )
      VALUES (
        ${LATE_OLDER_OBLIGATION_ID}::uuid,
        'entry-results',
        'integration:event:lane-race',
        'event-1-final-15',
        'hourly post-match',
        'UTC',
        'pending',
        'reconcile',
        clock_timestamp() - interval '2 minutes',
        0,
        0,
        jsonb_build_object('resultSlot', 'final-15')
      )
    `;

    let signalReservationReady = (): void => {};
    const reservationReady = new Promise<void>((resolve) => {
      signalReservationReady = resolve;
    });
    let releaseReservation = (): void => {};
    const reservationRelease = new Promise<void>((resolve) => {
      releaseReservation = resolve;
    });
    const reservation = sql.begin(async (tx) => {
      await tx`
        SELECT pg_advisory_xact_lock(
          hashtextextended('scheduler-lane:post-match-results', 0)
        )
      `;
      await tx`
        INSERT INTO ops.scheduler_obligations (
          obligation_id, job_name, scope_key, period_key, cadence, timezone,
          status, source, due_at, generation, attempts, evidence
        )
        VALUES (
          ${LATEST_OBLIGATION_ID}::uuid,
          'entry-results',
          'integration:event:lane-race',
          'event-1-final-16',
          'hourly post-match',
          'UTC',
          'pending',
          'reconcile',
          clock_timestamp() - interval '1 minute',
          0,
          0,
          jsonb_build_object('resultSlot', 'final-16')
        )
      `;
      signalReservationReady();
      await reservationRelease;
    });
    await reservationReady;

    const claim = claimSchedulerObligations({
      limit: 1,
      includedJobNames: ['entry-results'],
      laneKeys: ['post-match-results'],
      enforceLatestAuthoritativeScope: true,
    });
    const settledBeforeCommit = await Promise.race([
      claim.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 25)),
    ]);
    releaseReservation();
    await reservation;

    expect(settledBeforeCommit).toBe(false);
    const [claimed] = await claim;
    expect(claimed?.obligation.obligationId).toBe(LATEST_OBLIGATION_ID);
  });

  test('orders status by the immutable period and retains superseded failed cycles', async () => {
    const sql = await getDbClient();
    const olderScheduledDueAtMs = Date.parse('2026-08-23T00:01:00Z');
    const newerScheduledDueAtMs = Date.parse('2026-08-23T00:06:00Z');
    await sql`
      INSERT INTO ops.scheduler_obligations (
        obligation_id,
        job_name,
        scope_key,
        period_key,
        cadence,
        timezone,
        status,
        source,
        due_at,
        generation,
        attempts,
        evidence
      )
      VALUES
        (
          ${OBLIGATION_ID}::uuid,
          'price-change-predictions',
          '2627',
          'price-change-older',
          'every five minutes at UTC minute 01/06/11...',
          'UTC',
          'skipped',
          'catchup',
          '2026-08-23T00:08:00Z'::timestamptz,
          1,
          2,
          jsonb_build_object(
            'scheduledDueAtMs',
            ${olderScheduledDueAtMs}::bigint,
            'reason',
            'superseded-by-latest-authoritative'
          )
        ),
        (
          ${NEWER_OBLIGATION_ID}::uuid,
          'price-change-predictions',
          '2627',
          'price-change-newer',
          'every five minutes at UTC minute 01/06/11...',
          'UTC',
          'failed',
          'catchup',
          '2026-08-23T00:07:00Z'::timestamptz,
          1,
          1,
          jsonb_build_object('scheduledDueAtMs', ${newerScheduledDueAtMs}::bigint)
        )
    `;

    const failed = await schedulerObligationStatus({
      jobName: 'price-change-predictions',
      scopeKey: '2627',
    });
    expect(failed.latest).toMatchObject({
      periodKey: 'price-change-newer',
      status: 'failed',
      dueAt: new Date('2026-08-23T00:06:00Z'),
    });
    expect(failed.consecutiveUnsuccessfulCycles).toBe(2);

    await sql`
      UPDATE ops.scheduler_obligations
      SET evidence = evidence || '{"reason":"official_fields_not_open"}'::jsonb
      WHERE obligation_id = ${OBLIGATION_ID}::uuid
    `;
    const benignSkip = await schedulerObligationStatus({
      jobName: 'price-change-predictions',
      scopeKey: '2627',
    });
    expect(benignSkip.consecutiveUnsuccessfulCycles).toBe(1);
  });

  test('excludes in-flight periods from failure streaks and overdue alarms', async () => {
    const sql = await getDbClient();
    const previousScheduledDueAtMs = Date.parse('2026-08-23T00:06:00Z');
    const inFlightScheduledDueAtMs = Date.parse('2026-08-23T00:11:00Z');
    await sql`
      INSERT INTO ops.scheduler_obligations (
        obligation_id,
        job_name,
        scope_key,
        period_key,
        cadence,
        timezone,
        status,
        source,
        due_at,
        generation,
        attempts,
        lease_owner,
        lease_expires_at,
        evidence
      )
      VALUES
        (
          ${OBLIGATION_ID}::uuid,
          'price-change-predictions',
          '2627',
          'price-change-previous-failure',
          'every five minutes at UTC minute 01/06/11...',
          'UTC',
          'failed',
          'catchup',
          '2026-08-23T00:06:00Z'::timestamptz,
          1,
          1,
          NULL,
          NULL,
          jsonb_build_object('scheduledDueAtMs', ${previousScheduledDueAtMs}::bigint)
        ),
        (
          ${IN_FLIGHT_OBLIGATION_ID}::uuid,
          'price-change-predictions',
          '2627',
          'price-change-in-flight',
          'every five minutes at UTC minute 01/06/11...',
          'UTC',
          'running',
          'catchup',
          '2026-08-23T00:11:00Z'::timestamptz,
          1,
          1,
          'in-flight-worker',
          clock_timestamp() + interval '15 minutes',
          jsonb_build_object('scheduledDueAtMs', ${inFlightScheduledDueAtMs}::bigint)
        )
    `;

    const running = await schedulerObligationStatus({
      jobName: 'price-change-predictions',
      scopeKey: '2627',
    });
    expect(running.latest).toMatchObject({
      periodKey: 'price-change-in-flight',
      status: 'running',
      dueAt: new Date('2026-08-23T00:11:00Z'),
    });
    expect(running.consecutiveUnsuccessfulCycles).toBe(1);
    expect(running.overdue).toBe(false);

    await sql`
      UPDATE ops.scheduler_obligations
      SET status = 'failed',
          last_error = 'in-flight failure',
          lease_owner = NULL,
          lease_expires_at = NULL,
          evidence = evidence || '{"reason":"upstream"}'::jsonb
      WHERE obligation_id = ${IN_FLIGHT_OBLIGATION_ID}::uuid
    `;
    const failed = await schedulerObligationStatus({
      jobName: 'price-change-predictions',
      scopeKey: '2627',
    });
    expect(failed.latest?.status).toBe('failed');
    expect(failed.consecutiveUnsuccessfulCycles).toBe(2);
    expect(failed.overdue).toBe(true);
  });

  test('does not reclaim an expired in-flight lease into a duplicate generation', async () => {
    const sql = await getDbClient();
    await sql`
      INSERT INTO ops.scheduler_obligations (
        obligation_id,
        job_name,
        scope_key,
        period_key,
        cadence,
        timezone,
        status,
        source,
        due_at,
        generation,
        attempts,
        lease_owner,
        lease_expires_at,
        evidence
      )
      VALUES (
        ${OBLIGATION_ID}::uuid,
        'understat-player-incremental',
        'integration:understat',
        '20260823',
        'daily UTC+8 incremental',
        'Asia/Shanghai',
        'running',
        'catchup',
        clock_timestamp() - interval '1 minute',
        2,
        3,
        'expired-understat-owner',
        clock_timestamp() - interval '1 minute',
        '{}'::jsonb
      )
    `;

    expect(await claimSchedulerObligations()).toHaveLength(0);
    const rows = await sql<
      Array<{ status: string; generation: number; lease_owner: string | null }>
    >`
      SELECT status, generation, lease_owner
      FROM ops.scheduler_obligations
      WHERE obligation_id = ${OBLIGATION_ID}::uuid
    `;
    expect(rows[0]).toEqual({
      status: 'running',
      generation: 2,
      lease_owner: 'expired-understat-owner',
    });
  });

  test('clears prior Bull correlation when claiming a failed generation', async () => {
    const sql = await getDbClient();
    await sql`
      INSERT INTO ops.scheduler_obligations (
        obligation_id,
        job_name,
        scope_key,
        period_key,
        cadence,
        timezone,
        status,
        source,
        due_at,
        generation,
        attempts,
        bull_job_id,
        run_id,
        last_error,
        evidence
      )
      VALUES (
        ${OBLIGATION_ID}::uuid,
        'core-snapshot',
        'integration:core',
        'failed-generation-correlation',
        'integration',
        'UTC',
        'failed',
        'reconcile',
        clock_timestamp() - interval '1 minute',
        2,
        2,
        'old-generation-job',
        '30000000-0000-4000-8000-000000000099'::uuid,
        'TRANSIENT_INFRA:old generation failed',
        '{}'::jsonb
      )
    `;

    const [claim] = await claimSchedulerObligations();
    expect(claim?.obligation).toMatchObject({
      obligationId: OBLIGATION_ID,
      generation: 3,
      bullJobId: null,
      runId: null,
    });
    const rows = await sql<Array<{ last_error: string | null }>>`
      SELECT last_error
      FROM ops.scheduler_obligations
      WHERE obligation_id = ${OBLIGATION_ID}::uuid
    `;
    expect(rows[0]?.last_error).toBeNull();
  });

  test('selects every expired in-flight generation for Bull reconciliation', async () => {
    const sql = await getDbClient();
    await sql`
      INSERT INTO ops.scheduler_obligations (
        obligation_id,
        job_name,
        scope_key,
        period_key,
        cadence,
        timezone,
        status,
        source,
        due_at,
        generation,
        attempts,
        lease_owner,
        lease_expires_at,
        bull_job_id,
        evidence
      )
      VALUES
        (
          ${OBLIGATION_ID}::uuid,
          'core-snapshot',
          'integration:core',
          'expired-unconfirmed',
          'integration',
          'UTC',
          'enqueued',
          'reconcile',
          clock_timestamp() - interval '20 minutes',
          2,
          3,
          'expired-owner',
          clock_timestamp() - interval '1 minute',
          NULL,
          '{}'::jsonb
        ),
        (
          ${NEWER_OBLIGATION_ID}::uuid,
          'core-snapshot',
          'integration:core',
          'expired-confirmed',
          'integration',
          'UTC',
          'enqueued',
          'reconcile',
          clock_timestamp() - interval '20 minutes',
          2,
          3,
          'confirmed-owner',
          clock_timestamp() - interval '1 minute',
          'confirmed-bull-job',
          '{}'::jsonb
        ),
        (
          ${IN_FLIGHT_OBLIGATION_ID}::uuid,
          'core-snapshot',
          'integration:core',
          'expired-running',
          'integration',
          'UTC',
          'running',
          'reconcile',
          clock_timestamp() - interval '20 minutes',
          2,
          3,
          'running-owner',
          clock_timestamp() - interval '1 minute',
          NULL,
          '{}'::jsonb
        )
    `;

    const candidates = await listExpiredSchedulerObligations();
    expect(candidates.map((candidate) => candidate.obligationId)).toEqual([
      OBLIGATION_ID,
      NEWER_OBLIGATION_ID,
      IN_FLIGHT_OBLIGATION_ID,
    ]);
  });

  test('renewing an unresolved recovery window advances to later expired rows', async () => {
    const sql = await getDbClient();
    await sql`
      INSERT INTO ops.scheduler_obligations (
        obligation_id,
        job_name,
        scope_key,
        period_key,
        cadence,
        timezone,
        status,
        source,
        due_at,
        generation,
        attempts,
        lease_owner,
        lease_expires_at,
        evidence
      )
      VALUES
        (
          ${OBLIGATION_ID}::uuid,
          'entry-results',
          'integration:recovery-window',
          'oldest',
          'integration',
          'UTC',
          'running',
          'reconcile',
          clock_timestamp() - interval '20 minutes',
          2,
          3,
          'oldest-owner',
          clock_timestamp() - interval '3 minutes',
          '{}'::jsonb
        ),
        (
          ${NEWER_OBLIGATION_ID}::uuid,
          'entry-results',
          'integration:recovery-window',
          'middle',
          'integration',
          'UTC',
          'running',
          'reconcile',
          clock_timestamp() - interval '20 minutes',
          2,
          3,
          'middle-owner',
          clock_timestamp() - interval '2 minutes',
          '{}'::jsonb
        ),
        (
          ${IN_FLIGHT_OBLIGATION_ID}::uuid,
          'entry-results',
          'integration:recovery-window',
          'latest',
          'integration',
          'UTC',
          'running',
          'reconcile',
          clock_timestamp() - interval '20 minutes',
          2,
          3,
          'latest-owner',
          clock_timestamp() - interval '1 minute',
          '{}'::jsonb
        )
    `;

    const firstWindow = await listExpiredSchedulerObligations({ limit: 2 });
    expect(firstWindow.map((candidate) => candidate.obligationId)).toEqual([
      OBLIGATION_ID,
      NEWER_OBLIGATION_ID,
    ]);
    for (const candidate of firstWindow) {
      expect(
        await renewSchedulerObligation({
          obligationId: candidate.obligationId,
          generation: candidate.generation,
          additionalLeaseMs: 60_000,
        }),
      ).toBe(true);
    }

    const nextWindow = await listExpiredSchedulerObligations({ limit: 2 });
    expect(nextWindow.map((candidate) => candidate.obligationId)).toEqual([
      IN_FLIGHT_OBLIGATION_ID,
    ]);
  });
});
