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
  reconcilePostMatchSchedulerObligations,
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
const LATE_OLDER_OBLIGATION_ID = '30000000-0000-4000-8000-000000000006';
const LATEST_OBLIGATION_ID = '30000000-0000-4000-8000-000000000007';

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
      ${LATEST_OBLIGATION_ID}::uuid
    )
       OR scope_key IN (
         'integration:event:atomic-reschedule',
         'integration:event:equal-boundary-reschedule',
         'integration:event:lane-race'
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
          'resultAuthorityAtMs', ${staleAuthorityAtMs}::bigint
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
