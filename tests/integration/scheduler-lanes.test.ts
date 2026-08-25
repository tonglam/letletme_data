import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import { getDbClient } from '../../src/db/singleton';
import {
  advanceSchedulerLane,
  claimSchedulerLaneDispatch,
  completeSchedulerLane,
  confirmSchedulerLaneEnqueued,
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
        bullState: 'missing',
      }),
    ).toBe(true);
    const recovered = await claimSchedulerLaneDispatch({ laneId: initial.lane.laneId });
    expect(recovered?.lane.dispatchGeneration).toBe(2);
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
