import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import { getDbClient } from '../../src/db/singleton';
import {
  claimSchedulerObligations,
  completeSchedulerObligation,
  confirmSchedulerObligationEnqueued,
  failSchedulerObligation,
  findDueSchedulerJobNames,
  listExpiredSchedulerObligations,
  markSchedulerObligationIrrecoverable,
  renewSchedulerObligation,
  schedulerObligationStatus,
  startSchedulerObligation,
  supersedeSchedulerObligations,
  supersedeSchedulerObligationsByDueAt,
  supersedeSchedulerObligationsByDueAtBatch,
} from '../../src/repositories/scheduler-obligations';

const OBLIGATION_ID = '30000000-0000-4000-8000-000000000001';
const NEWER_OBLIGATION_ID = '30000000-0000-4000-8000-000000000002';
const IN_FLIGHT_OBLIGATION_ID = '30000000-0000-4000-8000-000000000003';
const SECOND_OLDER_OBLIGATION_ID = '30000000-0000-4000-8000-000000000004';
const SECOND_CURRENT_OBLIGATION_ID = '30000000-0000-4000-8000-000000000005';

async function cleanup(): Promise<void> {
  const sql = await getDbClient();
  await sql`
    DELETE FROM ops.scheduler_obligations
    WHERE obligation_id IN (
      ${OBLIGATION_ID}::uuid,
      ${NEWER_OBLIGATION_ID}::uuid,
      ${IN_FLIGHT_OBLIGATION_ID}::uuid,
      ${SECOND_OLDER_OBLIGATION_ID}::uuid,
      ${SECOND_CURRENT_OBLIGATION_ID}::uuid
    )
  `;
}

beforeEach(cleanup);
afterAll(cleanup);

describe('scheduler obligation generation fencing', () => {
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
          '2026-08-23T12:00:00Z'::timestamptz,
          0,
          0,
          NULL,
          NULL,
          '{}'::jsonb
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
          jsonb_build_object('scheduledDueAtMs', ${currentMovedDueAtMs}::bigint)
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
          '{}'::jsonb
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
          '{}'::jsonb
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
          '{}'::jsonb
        )
    `;

    expect(
      await supersedeSchedulerObligationsByDueAtBatch({
        boundaries: [
          {
            jobName: 'entry-results',
            scopeKey: '2627:event:1',
            periodKey: 'event-1-final-15',
            beforeDueAt: new Date('2026-08-23T12:00:00Z'),
          },
          {
            jobName: 'league-event-results',
            scopeKey: '2627:event:1',
            periodKey: 'event-1-final-15',
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
