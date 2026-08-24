import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import { getDbClient } from '../../src/db/singleton';
import {
  claimSchedulerObligations,
  completeSchedulerObligation,
  failSchedulerObligation,
  markSchedulerObligationIrrecoverable,
  supersedeSchedulerObligations,
  supersedeSchedulerObligationsByDueAt,
} from '../../src/repositories/scheduler-obligations';

const OBLIGATION_ID = '30000000-0000-4000-8000-000000000001';

async function cleanup(): Promise<void> {
  const sql = await getDbClient();
  await sql`
    DELETE FROM ops.scheduler_obligations
    WHERE obligation_id = ${OBLIGATION_ID}::uuid
  `;
}

beforeEach(cleanup);
afterAll(cleanup);

describe('scheduler obligation generation fencing', () => {
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

  test('terminalizes an expired Understat lease at the generation cap', async () => {
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

    expect(
      await claimSchedulerObligations({
        generationCaps: { 'understat-player-incremental': 3 },
      }),
    ).toHaveLength(0);
    const rows = await sql<Array<{ status: string; reason: string; lease_owner: string | null }>>`
      SELECT status, evidence->>'reason' AS reason, lease_owner
      FROM ops.scheduler_obligations
      WHERE obligation_id = ${OBLIGATION_ID}::uuid
    `;
    expect(rows[0]).toEqual({
      status: 'skipped',
      reason: 'generation-limit',
      lease_owner: null,
    });
  });
});
