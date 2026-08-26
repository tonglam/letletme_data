import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import { getDbClient } from '../../src/db/singleton';
import {
  advanceSchedulerLane,
  claimSchedulerLaneDispatch,
  completeSchedulerLane,
  confirmSchedulerLaneEnqueued,
  failSchedulerLane,
  fenceSchedulerLaneTarget,
  getSchedulerLaneTargets,
  recoverSchedulerLaneAfterBullLoss,
  startSchedulerLane,
} from '../../src/repositories/scheduler-lanes';
import { reserveSchedulerObligation } from '../../src/repositories/scheduler-obligations';

const LANE_KEY = 'integration:fpl-price-changes:latest-wins';
const SCOPE_KEY = 'integration:price-lane';
const DEFINITION = {
  name: 'price-change-predictions',
  cadence: 'integration five-minute',
  timezone: 'UTC',
};

async function cleanup(): Promise<void> {
  const sql = await getDbClient();
  await sql`DELETE FROM ops.scheduler_lanes WHERE lane_key = ${LANE_KEY}`;
  await sql`
    DELETE FROM ops.scheduler_obligations
    WHERE job_name = ${DEFINITION.name} AND scope_key = ${SCOPE_KEY}
  `;
}

async function reserve(dueAt: string, periodKey: string) {
  return reserveSchedulerObligation({
    definition: DEFINITION,
    plan: {
      scopeKey: SCOPE_KEY,
      periodKey,
      dueAt: new Date(dueAt),
      source: 'catchup',
      evidence: { scheduledDueAtMs: new Date(dueAt).getTime() },
    },
  });
}

beforeEach(cleanup);
afterAll(cleanup);

describe('scheduler latest-wins lanes', () => {
  test('serializes concurrent first observations of a lane', async () => {
    const first = await reserve('2026-08-25T03:00:00.000Z', 'price-concurrent-1');
    const second = await reserve('2026-08-25T03:05:00.000Z', 'price-concurrent-2');
    const [left, right] = await Promise.all([
      advanceSchedulerLane({
        laneKey: LANE_KEY,
        jobName: DEFINITION.name,
        scopeKey: SCOPE_KEY,
        queueName: 'fpl-critical-sync',
        desiredObligation: first,
      }),
      advanceSchedulerLane({
        laneKey: LANE_KEY,
        jobName: DEFINITION.name,
        scopeKey: SCOPE_KEY,
        queueName: 'fpl-critical-sync',
        desiredObligation: second,
      }),
    ]);
    expect(left.lane.laneId).toBe(right.lane.laneId);
    const targets = await getSchedulerLaneTargets({ laneId: left.lane.laneId });
    expect(targets?.lane.desiredObligationId).toBe(second.obligationId);
  });

  test('coalesces newer obligations without creating a second Bull dispatch', async () => {
    const first = await reserve('2026-08-25T04:00:00.000Z', 'price-1');
    const initial = await advanceSchedulerLane({
      laneKey: LANE_KEY,
      jobName: DEFINITION.name,
      scopeKey: SCOPE_KEY,
      queueName: 'fpl-critical-sync',
      desiredObligation: first,
    });
    expect(initial.shouldDispatch).toBe(true);
    const dispatch = await claimSchedulerLaneDispatch({ laneId: initial.lane.laneId });
    expect(dispatch).not.toBeNull();
    expect(
      await confirmSchedulerLaneEnqueued({
        laneId: initial.lane.laneId,
        owner: dispatch!.owner,
        bullJobId: 'integration-price-job-1',
      }),
    ).toBe(true);

    const second = await reserve('2026-08-25T04:05:00.000Z', 'price-2');
    const advanced = await advanceSchedulerLane({
      laneKey: LANE_KEY,
      jobName: DEFINITION.name,
      scopeKey: SCOPE_KEY,
      queueName: 'fpl-critical-sync',
      desiredObligation: second,
    });
    expect(advanced.lane.state).toBe('enqueued');
    expect(advanced.lane.desiredObligationId).toBe(second.obligationId);
    expect(await claimSchedulerLaneDispatch({ laneId: initial.lane.laneId })).toBeNull();

    const targets = await getSchedulerLaneTargets({ laneId: initial.lane.laneId });
    expect(targets?.desired?.obligationId).toBe(second.obligationId);
    expect(targets?.desired?.status).toBe('pending');
    expect(targets?.active).toBeNull();
  });

  test('accepts a late enqueue confirmation after the Bull job already succeeded', async () => {
    const first = await reserve('2026-08-25T04:10:00.000Z', 'price-confirm-after-success');
    const initial = await advanceSchedulerLane({
      laneKey: LANE_KEY,
      jobName: DEFINITION.name,
      scopeKey: SCOPE_KEY,
      queueName: 'fpl-critical-sync',
      desiredObligation: first,
    });
    const dispatch = await claimSchedulerLaneDispatch({ laneId: initial.lane.laneId });
    expect(dispatch).not.toBeNull();

    // A fast Bull job may start and settle before the scheduler receives the
    // enqueue response. Confirmation must remain an idempotent success.
    const started = await startSchedulerLane({
      laneId: initial.lane.laneId,
      dispatchGeneration: dispatch!.lane.dispatchGeneration,
      bullJobId: 'integration-price-job-fast-success',
    });
    expect(started).not.toBeNull();
    const completed = await completeSchedulerLane({
      laneId: initial.lane.laneId,
      dispatchGeneration: dispatch!.lane.dispatchGeneration,
      activeObligationId: first.obligationId,
      status: 'succeeded',
    });
    expect(completed.ok).toBe(true);
    expect(
      await confirmSchedulerLaneEnqueued({
        laneId: initial.lane.laneId,
        owner: dispatch!.owner,
        bullJobId: 'integration-price-job-fast-success',
        obligationId: first.obligationId,
      }),
    ).toBe(true);

    const targets = await getSchedulerLaneTargets({ laneId: initial.lane.laneId });
    expect(targets?.lane.state).toBe('idle');
    expect(targets?.desired?.status).toBe('succeeded');
    expect(targets?.desired?.bullJobId).toBe('integration-price-job-fast-success');
  });

  test('accepts a late enqueue confirmation after a pre-start Bull failure', async () => {
    const first = await reserve('2026-08-25T04:15:00.000Z', 'price-confirm-after-failure');
    const initial = await advanceSchedulerLane({
      laneKey: LANE_KEY,
      jobName: DEFINITION.name,
      scopeKey: SCOPE_KEY,
      queueName: 'fpl-critical-sync',
      desiredObligation: first,
    });
    const dispatch = await claimSchedulerLaneDispatch({ laneId: initial.lane.laneId });
    expect(dispatch).not.toBeNull();

    // The worker failure callback can run while the lane is still
    // dispatching, before the enqueue confirmation transaction commits.
    expect(
      await recoverSchedulerLaneAfterBullLoss({
        laneId: initial.lane.laneId,
        dispatchGeneration: dispatch!.lane.dispatchGeneration,
        bullJobId: 'integration-price-job-fast-failure',
        bullState: 'failed',
        obligationId: first.obligationId,
      }),
    ).toBe(true);
    expect(
      await confirmSchedulerLaneEnqueued({
        laneId: initial.lane.laneId,
        owner: dispatch!.owner,
        bullJobId: 'integration-price-job-fast-failure',
        obligationId: first.obligationId,
      }),
    ).toBe(true);

    const targets = await getSchedulerLaneTargets({ laneId: initial.lane.laneId });
    expect(targets?.lane.state).toBe('idle');
    expect(targets?.desired?.status).toBe('failed');
    expect(targets?.desired?.bullJobId).toBe('integration-price-job-fast-failure');
  });

  test('does not create a new generation merely because the Bull job waited', async () => {
    const first = await reserve('2026-08-25T04:00:00.000Z', 'price-waiting');
    const initial = await advanceSchedulerLane({
      laneKey: LANE_KEY,
      jobName: DEFINITION.name,
      scopeKey: SCOPE_KEY,
      queueName: 'fpl-critical-sync',
      desiredObligation: first,
    });
    const dispatch = await claimSchedulerLaneDispatch({ laneId: initial.lane.laneId });
    expect(dispatch).not.toBeNull();
    expect(
      await confirmSchedulerLaneEnqueued({
        laneId: initial.lane.laneId,
        owner: dispatch!.owner,
        bullJobId: 'integration-price-job-waiting',
      }),
    ).toBe(true);
    const sql = await getDbClient();
    await sql`
      UPDATE ops.scheduler_lanes
      SET updated_at = clock_timestamp() - interval '16 minutes',
          last_progress_at = clock_timestamp() - interval '16 minutes'
      WHERE lane_id = ${initial.lane.laneId}
    `;
    expect(await claimSchedulerLaneDispatch({ laneId: initial.lane.laneId })).toBeNull();
    const targets = await getSchedulerLaneTargets({ laneId: initial.lane.laneId });
    expect(targets?.lane.dispatchGeneration).toBe(1);
    expect(targets?.lane.state).toBe('enqueued');
  });

  test('recovers one new generation only when Bull reports a lost job', async () => {
    const first = await reserve('2026-08-25T05:00:00.000Z', 'price-recovery');
    const initial = await advanceSchedulerLane({
      laneKey: LANE_KEY,
      jobName: DEFINITION.name,
      scopeKey: SCOPE_KEY,
      queueName: 'fpl-critical-sync',
      desiredObligation: first,
    });
    const dispatch = await claimSchedulerLaneDispatch({ laneId: initial.lane.laneId });
    expect(dispatch).not.toBeNull();
    await confirmSchedulerLaneEnqueued({
      laneId: initial.lane.laneId,
      owner: dispatch!.owner,
      bullJobId: 'integration-price-job-lost',
    });
    expect(
      await recoverSchedulerLaneAfterBullLoss({
        laneId: initial.lane.laneId,
        dispatchGeneration: dispatch!.lane.dispatchGeneration,
        bullJobId: 'integration-price-job-lost',
        bullState: 'missing',
      }),
    ).toBe(true);
    const recovered = await claimSchedulerLaneDispatch({ laneId: initial.lane.laneId });
    expect(recovered?.lane.dispatchGeneration).toBe(2);
  });

  test('recovers an enqueued obligation when Bull fails before lane start', async () => {
    const first = await reserve('2026-08-25T05:15:00.000Z', 'price-pre-start-failure');
    const initial = await advanceSchedulerLane({
      laneKey: LANE_KEY,
      jobName: DEFINITION.name,
      scopeKey: SCOPE_KEY,
      queueName: 'fpl-critical-sync',
      desiredObligation: first,
    });
    const dispatch = await claimSchedulerLaneDispatch({ laneId: initial.lane.laneId });
    expect(dispatch).not.toBeNull();
    await confirmSchedulerLaneEnqueued({
      laneId: initial.lane.laneId,
      owner: dispatch!.owner,
      bullJobId: 'integration-price-job-pre-start-failure',
      obligationId: first.obligationId,
    });
    expect(
      await recoverSchedulerLaneAfterBullLoss({
        laneId: initial.lane.laneId,
        dispatchGeneration: dispatch!.lane.dispatchGeneration,
        bullJobId: 'integration-price-job-pre-start-failure',
        bullState: 'failed',
        obligationId: first.obligationId,
      }),
    ).toBe(true);
    const targets = await getSchedulerLaneTargets({ laneId: initial.lane.laneId });
    expect(targets?.lane.state).toBe('idle');
    expect(targets?.desired?.status).toBe('failed');
  });

  test('does not recover when Bull loss was observed for a stale generation', async () => {
    const first = await reserve('2026-08-25T05:30:00.000Z', 'price-stale-recovery');
    const initial = await advanceSchedulerLane({
      laneKey: LANE_KEY,
      jobName: DEFINITION.name,
      scopeKey: SCOPE_KEY,
      queueName: 'fpl-critical-sync',
      desiredObligation: first,
    });
    const dispatch = await claimSchedulerLaneDispatch({ laneId: initial.lane.laneId });
    expect(dispatch).not.toBeNull();
    await confirmSchedulerLaneEnqueued({
      laneId: initial.lane.laneId,
      owner: dispatch!.owner,
      bullJobId: 'integration-price-job-current',
    });
    expect(
      await recoverSchedulerLaneAfterBullLoss({
        laneId: initial.lane.laneId,
        dispatchGeneration: dispatch!.lane.dispatchGeneration - 1,
        bullJobId: 'integration-price-job-old',
        bullState: 'missing',
      }),
    ).toBe(false);
    const targets = await getSchedulerLaneTargets({ laneId: initial.lane.laneId });
    expect(targets?.lane.dispatchGeneration).toBe(dispatch!.lane.dispatchGeneration);
    expect(targets?.lane.state).toBe('enqueued');
  });

  test('retires the active obligation when the desired target advances mid-job', async () => {
    const first = await reserve('2026-08-25T06:30:00.000Z', 'price-active');
    const initial = await advanceSchedulerLane({
      laneKey: LANE_KEY,
      jobName: DEFINITION.name,
      scopeKey: SCOPE_KEY,
      queueName: 'fpl-critical-sync',
      desiredObligation: first,
    });
    const dispatch = await claimSchedulerLaneDispatch({ laneId: initial.lane.laneId });
    expect(dispatch).not.toBeNull();
    await confirmSchedulerLaneEnqueued({
      laneId: initial.lane.laneId,
      owner: dispatch!.owner,
      bullJobId: 'integration-price-job-active',
    });
    const started = await startSchedulerLane({
      laneId: initial.lane.laneId,
      dispatchGeneration: dispatch!.lane.dispatchGeneration,
      bullJobId: 'integration-price-job-active',
    });
    expect(started).not.toBeNull();

    const second = await reserve('2026-08-25T06:35:00.000Z', 'price-active-newer');
    await advanceSchedulerLane({
      laneKey: LANE_KEY,
      jobName: DEFINITION.name,
      scopeKey: SCOPE_KEY,
      queueName: 'fpl-critical-sync',
      desiredObligation: second,
    });
    const target = await fenceSchedulerLaneTarget({
      laneId: initial.lane.laneId,
      dispatchGeneration: dispatch!.lane.dispatchGeneration,
      activeObligationId: first.obligationId,
      bullJobId: 'integration-price-job-active',
    });
    expect(target?.obligation.obligationId).toBe(second.obligationId);
    const targets = await getSchedulerLaneTargets({ laneId: initial.lane.laneId });
    expect(targets?.lane.activeObligationId).toBe(second.obligationId);
    const sql = await getDbClient();
    const retired = await sql<Array<{ status: string }>>`
      SELECT status FROM ops.scheduler_obligations WHERE obligation_id = ${first.obligationId}::uuid
    `;
    expect(retired[0]?.status).toBe('skipped');
  });

  test('does not fail an obligation from a stale lane generation', async () => {
    const first = await reserve('2026-08-25T07:00:00.000Z', 'price-stale-failure');
    const initial = await advanceSchedulerLane({
      laneKey: LANE_KEY,
      jobName: DEFINITION.name,
      scopeKey: SCOPE_KEY,
      queueName: 'fpl-critical-sync',
      desiredObligation: first,
    });
    const dispatch = await claimSchedulerLaneDispatch({ laneId: initial.lane.laneId });
    expect(dispatch).not.toBeNull();
    await confirmSchedulerLaneEnqueued({
      laneId: initial.lane.laneId,
      owner: dispatch!.owner,
      bullJobId: 'integration-price-job-stale-failure',
    });
    const started = await startSchedulerLane({
      laneId: initial.lane.laneId,
      dispatchGeneration: dispatch!.lane.dispatchGeneration,
      bullJobId: 'integration-price-job-stale-failure',
    });
    expect(started).not.toBeNull();
    const second = await reserve('2026-08-25T07:05:00.000Z', 'price-stale-failure-newer');
    await advanceSchedulerLane({
      laneKey: LANE_KEY,
      jobName: DEFINITION.name,
      scopeKey: SCOPE_KEY,
      queueName: 'fpl-critical-sync',
      desiredObligation: second,
    });
    const target = await fenceSchedulerLaneTarget({
      laneId: initial.lane.laneId,
      dispatchGeneration: dispatch!.lane.dispatchGeneration,
      activeObligationId: first.obligationId,
      bullJobId: 'integration-price-job-stale-failure',
    });
    expect(target?.obligation.obligationId).toBe(second.obligationId);
    expect(
      await failSchedulerLane({
        laneId: initial.lane.laneId,
        dispatchGeneration: dispatch!.lane.dispatchGeneration,
        activeObligationId: first.obligationId,
        error: new Error('stale terminal callback'),
      }),
    ).toBe(false);
    const targets = await getSchedulerLaneTargets({ laneId: initial.lane.laneId });
    expect(targets?.desired?.status).toBe('running');
    expect(targets?.active?.obligationId).toBe(second.obligationId);
  });

  test('rejects completion CAS for a stale generation', async () => {
    const first = await reserve('2026-08-25T06:00:00.000Z', 'price-cas');
    const initial = await advanceSchedulerLane({
      laneKey: LANE_KEY,
      jobName: DEFINITION.name,
      scopeKey: SCOPE_KEY,
      queueName: 'fpl-critical-sync',
      desiredObligation: first,
    });
    const dispatch = await claimSchedulerLaneDispatch({ laneId: initial.lane.laneId });
    expect(dispatch).not.toBeNull();
    await confirmSchedulerLaneEnqueued({
      laneId: initial.lane.laneId,
      owner: dispatch!.owner,
      bullJobId: 'integration-price-job-cas',
    });
    const started = await startSchedulerLane({
      laneId: initial.lane.laneId,
      dispatchGeneration: dispatch!.lane.dispatchGeneration,
      bullJobId: 'integration-price-job-cas',
    });
    expect(started).not.toBeNull();
    const stale = await completeSchedulerLane({
      laneId: initial.lane.laneId,
      dispatchGeneration: dispatch!.lane.dispatchGeneration - 1,
      activeObligationId: first.obligationId,
      status: 'succeeded',
    });
    expect(stale.ok).toBe(false);
  });
});
