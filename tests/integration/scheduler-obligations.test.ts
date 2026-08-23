import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import { getDbClient } from '../../src/db/singleton';
import {
  completeSchedulerObligation,
  failSchedulerObligation,
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
});
