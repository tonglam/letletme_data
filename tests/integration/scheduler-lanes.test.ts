import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import { getDbClient } from '../../src/db/singleton';
import {
  advanceSchedulerLane,
  acknowledgeSupersededSchedulerLane,
  blockSchedulerLane,
  claimSchedulerLaneDispatch,
  completeSchedulerLane,
  confirmSchedulerLaneEnqueued,
  failSchedulerLane,
  fenceSchedulerLaneTarget,
  getSchedulerLaneTargets,
  listLiveSnapshotRecoveryLanes,
  recoverSchedulerLaneAfterBullLoss,
  replaceBlockedSchedulerLaneAfterCoreSourceStale,
  startSchedulerLane,
} from '../../src/repositories/scheduler-lanes';
import {
  deferSchedulerObligationForWorker,
  reserveSchedulerObligation,
} from '../../src/repositories/scheduler-obligations';

const LANE_KEY = 'integration:fpl-price-changes:latest-wins';
const SCOPE_KEY = 'integration:price-lane';
const DEFINITION = {
  name: 'price-change-predictions',
  cadence: 'integration five-minute',
  timezone: 'UTC',
};
const LIVE_LANE_KEY = 'integration:live-snapshot:2627:event:3';
const LIVE_SCOPE_KEY = '2627:event:3';
const LIVE_DEFINITION = {
  name: 'live-snapshot',
  cadence: 'integration lifecycle polling',
  timezone: 'UTC',
  queueName: 'live-data',
};

async function cleanup(): Promise<void> {
  const sql = await getDbClient();
  await sql`DELETE FROM ops.data_governance_cases WHERE scope_key = ${SCOPE_KEY}`;
  await sql`DELETE FROM ops.freshness_slo_windows WHERE scope_key = ${SCOPE_KEY}`;
  await sql`DELETE FROM ops.scheduler_lanes WHERE lane_key = ${LANE_KEY}`;
  await sql`
    DELETE FROM ops.scheduler_obligations
    WHERE job_name = ${DEFINITION.name} AND scope_key = ${SCOPE_KEY}
  `;
  await sql`DELETE FROM ops.data_governance_cases WHERE scope_key = ${LIVE_SCOPE_KEY}`;
  await sql`DELETE FROM ops.freshness_slo_windows WHERE scope_key = ${LIVE_SCOPE_KEY}`;
  await sql`DELETE FROM ops.scheduler_lanes WHERE lane_key = ${LIVE_LANE_KEY}`;
  await sql`
    DELETE FROM ops.scheduler_obligations
    WHERE job_name = ${LIVE_DEFINITION.name} AND scope_key = ${LIVE_SCOPE_KEY}
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

async function reserveLive(
  observedAtMs: number,
  periodKey: string,
  dueAt = new Date(observedAtMs - 60_000),
) {
  return reserveSchedulerObligation({
    definition: LIVE_DEFINITION,
    plan: {
      scopeKey: LIVE_SCOPE_KEY,
      periodKey,
      dueAt,
      source: 'reconcile',
      eventId: 3,
      evidence: {
        scheduledDueAtMs: dueAt.getTime(),
        decisionObservedAt: new Date(observedAtMs).toISOString(),
        decisionObservedAtMs: observedAtMs,
        lifecycleState: 'LIVE_ACTIVE',
      },
    },
  });
}

beforeEach(cleanup);
afterAll(cleanup);

describe('scheduler latest-wins lanes', () => {
  test('supersedes a 500-target live backlog in bounded passes', async () => {
    const sql = await getDbClient();
    await sql`
      INSERT INTO ops.scheduler_obligations
        (obligation_id, job_name, scope_key, period_key, cadence, timezone, status, source, due_at, evidence)
      SELECT gen_random_uuid(),
             ${LIVE_DEFINITION.name},
             ${LIVE_SCOPE_KEY},
             'live-old-' || series.i,
             ${LIVE_DEFINITION.cadence},
             ${LIVE_DEFINITION.timezone},
             'pending',
             'reconcile',
             TIMESTAMPTZ '2026-08-25 00:00:00+00' + series.i * interval '1 second',
             jsonb_build_object(
               'scheduledDueAtMs', (extract(epoch FROM (TIMESTAMPTZ '2026-08-25 00:00:00+00' + series.i * interval '1 second')) * 1000)::bigint,
               'decisionObservedAtMs', (extract(epoch FROM (TIMESTAMPTZ '2026-08-25 00:00:00+00' + series.i * interval '1 second')) * 1000)::bigint,
               'decisionObservedAt', to_char(TIMESTAMPTZ '2026-08-25 00:00:00+00' + series.i * interval '1 second', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
             )
      FROM generate_series(1, 500) AS series(i)
    `;
    const newer = await reserveLive(
      Date.parse('2026-08-25T01:00:00.000Z'),
      'live-newest',
      new Date('2026-08-25T00:59:00.000Z'),
    );
    const input = {
      laneKey: LIVE_LANE_KEY,
      jobName: LIVE_DEFINITION.name,
      scopeKey: LIVE_SCOPE_KEY,
      queueName: LIVE_DEFINITION.queueName,
      desiredObligation: newer,
      preserveFreshnessHistory: true,
      supersedeBatchSize: 250,
    };
    const first = await advanceSchedulerLane(input);
    expect(first.shouldDispatch).toBe(true);
    const [firstCounts] = await sql<Array<{ skipped: number; pending: number }>>`
      SELECT count(*) FILTER (WHERE status = 'skipped')::int AS skipped,
             count(*) FILTER (WHERE status = 'pending')::int AS pending
      FROM ops.scheduler_obligations
      WHERE job_name = ${LIVE_DEFINITION.name} AND scope_key = ${LIVE_SCOPE_KEY}
    `;
    expect(firstCounts).toEqual({ skipped: 250, pending: 251 });

    await advanceSchedulerLane(input);
    const [secondCounts] = await sql<Array<{ skipped: number; pending: number }>>`
      SELECT count(*) FILTER (WHERE status = 'skipped')::int AS skipped,
             count(*) FILTER (WHERE status = 'pending')::int AS pending
      FROM ops.scheduler_obligations
      WHERE job_name = ${LIVE_DEFINITION.name} AND scope_key = ${LIVE_SCOPE_KEY}
    `;
    expect(secondCounts).toEqual({ skipped: 500, pending: 1 });

    const recoveryCandidates = await listLiveSnapshotRecoveryLanes({ limit: 1 });
    expect(recoveryCandidates.map((lane) => lane.laneId)).toEqual([first.lane.laneId]);
    await sql`
      UPDATE ops.scheduler_obligations
      SET status = 'succeeded', completed_at = clock_timestamp()
      WHERE obligation_id = ${newer.obligationId}::uuid
    `;
    expect(await listLiveSnapshotRecoveryLanes({ limit: 1 })).toHaveLength(0);
  });

  test('does not let a late same-period live decision overwrite the newer observation', async () => {
    const newest = await reserveLive(
      Date.parse('2026-08-25T01:10:00.000Z'),
      'live-same-period',
      new Date('2026-08-25T01:09:00.000Z'),
    );
    const late = await reserveLive(
      Date.parse('2026-08-25T01:05:00.000Z'),
      'live-same-period',
      new Date('2026-08-25T01:04:00.000Z'),
    );
    expect(late.obligationId).toBe(newest.obligationId);
    expect(late.evidence.decisionObservedAtMs).toBe(Date.parse('2026-08-25T01:10:00.000Z'));
    const sql = await getDbClient();
    const [row] = await sql<Array<{ observed: string }>>`
      SELECT evidence->>'decisionObservedAtMs' AS observed
      FROM ops.scheduler_obligations
      WHERE obligation_id = ${newest.obligationId}::uuid
    `;
    expect(Number(row?.observed)).toBe(Date.parse('2026-08-25T01:10:00.000Z'));
  });

  test('keeps a superseded live freshness breach as historical evidence', async () => {
    const older = await reserveLive(
      Date.parse('2026-08-25T02:00:00.000Z'),
      'live-history-older',
      new Date('2026-08-25T01:59:00.000Z'),
    );
    const newer = await reserveLive(
      Date.parse('2026-08-25T02:05:00.000Z'),
      'live-history-newer',
      new Date('2026-08-25T02:04:00.000Z'),
    );
    const sql = await getDbClient();
    await sql`
      INSERT INTO ops.freshness_slo_windows
        (slo_key, contract_key, scope_key, period_key, eligible_at, due_at, obligation_due_at, status)
      VALUES ('live-snapshot', 'live-snapshot', ${LIVE_SCOPE_KEY}, ${older.periodKey}, now(), now(), ${older.dueAt.toISOString()}::timestamptz, 'BREACHED')
    `;
    await advanceSchedulerLane({
      laneKey: LIVE_LANE_KEY,
      jobName: LIVE_DEFINITION.name,
      scopeKey: LIVE_SCOPE_KEY,
      queueName: LIVE_DEFINITION.queueName,
      desiredObligation: newer,
      preserveFreshnessHistory: true,
      supersedeBatchSize: 250,
    });
    const [window] = await sql<Array<{ status: string }>>`
      SELECT status FROM ops.freshness_slo_windows
      WHERE slo_key = 'live-snapshot' AND scope_key = ${LIVE_SCOPE_KEY} AND period_key = ${older.periodKey}
    `;
    expect(window?.status).toBe('BREACHED');
  });

  test('terminates a late live task when the desired target is already terminal', async () => {
    const older = await reserveLive(
      Date.parse('2026-08-25T03:00:00.000Z'),
      'live-terminal-older',
      new Date('2026-08-25T02:59:00.000Z'),
    );
    const initial = await advanceSchedulerLane({
      laneKey: LIVE_LANE_KEY,
      jobName: LIVE_DEFINITION.name,
      scopeKey: LIVE_SCOPE_KEY,
      queueName: LIVE_DEFINITION.queueName,
      desiredObligation: older,
      preserveFreshnessHistory: true,
    });
    const dispatch = await claimSchedulerLaneDispatch({ laneId: initial.lane.laneId });
    expect(dispatch).not.toBeNull();
    await confirmSchedulerLaneEnqueued({
      laneId: initial.lane.laneId,
      owner: dispatch!.owner,
      bullJobId: 'integration-live-terminal-job',
      obligationId: older.obligationId,
    });
    const started = await startSchedulerLane({
      laneId: initial.lane.laneId,
      dispatchGeneration: dispatch!.lane.dispatchGeneration,
      bullJobId: 'integration-live-terminal-job',
    });
    expect(started).not.toBeNull();
    const newer = await reserveLive(
      Date.parse('2026-08-25T03:05:00.000Z'),
      'live-terminal-newer',
      new Date('2026-08-25T03:04:00.000Z'),
    );
    await advanceSchedulerLane({
      laneKey: LIVE_LANE_KEY,
      jobName: LIVE_DEFINITION.name,
      scopeKey: LIVE_SCOPE_KEY,
      queueName: LIVE_DEFINITION.queueName,
      desiredObligation: newer,
      preserveFreshnessHistory: true,
    });
    const sql = await getDbClient();
    await sql`UPDATE ops.scheduler_obligations SET status = 'succeeded' WHERE obligation_id = ${newer.obligationId}::uuid`;
    const fenced = await fenceSchedulerLaneTarget({
      laneId: initial.lane.laneId,
      dispatchGeneration: dispatch!.lane.dispatchGeneration,
      activeObligationId: older.obligationId,
      bullJobId: 'integration-live-terminal-job',
    });
    expect(fenced).toBeNull();
    const targets = await getSchedulerLaneTargets({ laneId: initial.lane.laneId });
    expect(targets?.lane.state).toBe('idle');
    expect(targets?.lane.activeObligationId).toBeNull();
    expect(targets?.active).toBeNull();
  });

  test('does not let a queued live task borrow a newer target before provider execution', async () => {
    const older = await reserveLive(
      Date.parse('2026-08-25T03:30:00.000Z'),
      'live-queued-older',
      new Date('2026-08-25T03:29:00.000Z'),
    );
    const initial = await advanceSchedulerLane({
      laneKey: LIVE_LANE_KEY,
      jobName: LIVE_DEFINITION.name,
      scopeKey: LIVE_SCOPE_KEY,
      queueName: LIVE_DEFINITION.queueName,
      desiredObligation: older,
      preserveFreshnessHistory: true,
    });
    const dispatch = await claimSchedulerLaneDispatch({ laneId: initial.lane.laneId });
    expect(dispatch).not.toBeNull();
    await confirmSchedulerLaneEnqueued({
      laneId: initial.lane.laneId,
      owner: dispatch!.owner,
      bullJobId: 'integration-live-queued-job',
      obligationId: older.obligationId,
    });
    const newer = await reserveLive(
      Date.parse('2026-08-25T03:35:00.000Z'),
      'live-queued-newer',
      new Date('2026-08-25T03:34:00.000Z'),
    );
    await advanceSchedulerLane({
      laneKey: LIVE_LANE_KEY,
      jobName: LIVE_DEFINITION.name,
      scopeKey: LIVE_SCOPE_KEY,
      queueName: LIVE_DEFINITION.queueName,
      desiredObligation: newer,
      preserveFreshnessHistory: true,
    });
    const started = await startSchedulerLane({
      laneId: initial.lane.laneId,
      dispatchGeneration: dispatch!.lane.dispatchGeneration,
      bullJobId: 'integration-live-queued-job',
      obligationId: older.obligationId,
    });
    expect(started).toBeNull();
    const targets = await getSchedulerLaneTargets({ laneId: initial.lane.laneId });
    expect(targets?.lane.state).toBe('idle');
    expect(targets?.lane.activeObligationId).toBeNull();
    expect(targets?.desired?.obligationId).toBe(newer.obligationId);
    expect(targets?.active).toBeNull();
    const sql = await getDbClient();
    const [row] = await sql<Array<{ status: string }>>`
      SELECT status FROM ops.scheduler_obligations
      WHERE obligation_id = ${older.obligationId}::uuid
    `;
    expect(row?.status).toBe('skipped');
  });

  test('rejects a worker payload whose obligation belongs to another lane', async () => {
    const live = await reserveLive(
      Date.parse('2026-08-25T03:40:00.000Z'),
      'live-lane-identity',
      new Date('2026-08-25T03:39:00.000Z'),
    );
    const initial = await advanceSchedulerLane({
      laneKey: LIVE_LANE_KEY,
      jobName: LIVE_DEFINITION.name,
      scopeKey: LIVE_SCOPE_KEY,
      queueName: LIVE_DEFINITION.queueName,
      desiredObligation: live,
      preserveFreshnessHistory: true,
    });
    const dispatch = await claimSchedulerLaneDispatch({ laneId: initial.lane.laneId });
    expect(dispatch).not.toBeNull();
    await confirmSchedulerLaneEnqueued({
      laneId: initial.lane.laneId,
      owner: dispatch!.owner,
      bullJobId: 'integration-live-wrong-lane-job',
      obligationId: live.obligationId,
    });
    const foreign = await reserve('2026-08-25T03:41:00.000Z', 'foreign-lane-obligation');

    const started = await startSchedulerLane({
      laneId: initial.lane.laneId,
      dispatchGeneration: dispatch!.lane.dispatchGeneration,
      bullJobId: 'integration-live-wrong-lane-job',
      obligationId: foreign.obligationId,
    });
    expect(started).toBeNull();

    const targets = await getSchedulerLaneTargets({ laneId: initial.lane.laneId });
    expect(targets?.lane.state).toBe('enqueued');
    expect(targets?.lane.activeObligationId).toBeNull();
    expect(targets?.active).toBeNull();
    expect(targets?.desired?.obligationId).toBe(live.obligationId);
  });

  test('does not revive a superseded live target during Bull loss recovery', async () => {
    const older = await reserveLive(
      Date.parse('2026-08-25T03:45:00.000Z'),
      'live-recovery-older',
      new Date('2026-08-25T03:44:00.000Z'),
    );
    const initial = await advanceSchedulerLane({
      laneKey: LIVE_LANE_KEY,
      jobName: LIVE_DEFINITION.name,
      scopeKey: LIVE_SCOPE_KEY,
      queueName: LIVE_DEFINITION.queueName,
      desiredObligation: older,
      preserveFreshnessHistory: true,
    });
    const dispatch = await claimSchedulerLaneDispatch({ laneId: initial.lane.laneId });
    expect(dispatch).not.toBeNull();
    await confirmSchedulerLaneEnqueued({
      laneId: initial.lane.laneId,
      owner: dispatch!.owner,
      bullJobId: 'integration-live-recovery-job',
      obligationId: older.obligationId,
    });
    const newer = await reserveLive(
      Date.parse('2026-08-25T03:50:00.000Z'),
      'live-recovery-newer',
      new Date('2026-08-25T03:49:00.000Z'),
    );
    await advanceSchedulerLane({
      laneKey: LIVE_LANE_KEY,
      jobName: LIVE_DEFINITION.name,
      scopeKey: LIVE_SCOPE_KEY,
      queueName: LIVE_DEFINITION.queueName,
      desiredObligation: newer,
      preserveFreshnessHistory: true,
    });
    expect(
      await recoverSchedulerLaneAfterBullLoss({
        laneId: initial.lane.laneId,
        dispatchGeneration: dispatch!.lane.dispatchGeneration,
        bullJobId: 'integration-live-recovery-job',
        bullState: 'failed',
        obligationId: older.obligationId,
      }),
    ).toBe(true);
    const targets = await getSchedulerLaneTargets({ laneId: initial.lane.laneId });
    expect(targets?.lane.state).toBe('idle');
    expect(targets?.lane.lastError).toBeNull();
    expect(targets?.desired?.obligationId).toBe(newer.obligationId);
    const sql = await getDbClient();
    const [row] = await sql<Array<{ status: string }>>`
      SELECT status FROM ops.scheduler_obligations
      WHERE obligation_id = ${older.obligationId}::uuid
    `;
    expect(row?.status).toBe('skipped');
  });

  test('releases an enqueued lane when a superseded Bull job settles', async () => {
    const older = await reserveLive(
      Date.parse('2026-08-25T04:00:00.000Z'),
      'live-settle-older',
      new Date('2026-08-25T03:59:00.000Z'),
    );
    const initial = await advanceSchedulerLane({
      laneKey: LIVE_LANE_KEY,
      jobName: LIVE_DEFINITION.name,
      scopeKey: LIVE_SCOPE_KEY,
      queueName: LIVE_DEFINITION.queueName,
      desiredObligation: older,
      preserveFreshnessHistory: true,
    });
    const dispatch = await claimSchedulerLaneDispatch({ laneId: initial.lane.laneId });
    expect(dispatch).not.toBeNull();
    await confirmSchedulerLaneEnqueued({
      laneId: initial.lane.laneId,
      owner: dispatch!.owner,
      bullJobId: 'integration-live-settle-job',
      obligationId: older.obligationId,
    });
    const newer = await reserveLive(
      Date.parse('2026-08-25T04:05:00.000Z'),
      'live-settle-newer',
      new Date('2026-08-25T04:04:00.000Z'),
    );
    await advanceSchedulerLane({
      laneKey: LIVE_LANE_KEY,
      jobName: LIVE_DEFINITION.name,
      scopeKey: LIVE_SCOPE_KEY,
      queueName: LIVE_DEFINITION.queueName,
      desiredObligation: newer,
      preserveFreshnessHistory: true,
    });
    expect(
      await acknowledgeSupersededSchedulerLane({
        laneId: initial.lane.laneId,
        dispatchGeneration: dispatch!.lane.dispatchGeneration,
        bullJobId: 'integration-live-settle-job',
        activeObligationId: older.obligationId,
      }),
    ).toBe(true);
    const targets = await getSchedulerLaneTargets({ laneId: initial.lane.laneId });
    expect(targets?.lane.state).toBe('idle');
    expect(targets?.lane.desiredObligationId).toBe(newer.obligationId);
  });

  test('releases a live lane after dependency deferral without marking it succeeded', async () => {
    const older = await reserveLive(
      Date.parse('2026-08-25T04:20:00.000Z'),
      'live-deferred-older',
      new Date('2026-08-25T04:19:00.000Z'),
    );
    const initial = await advanceSchedulerLane({
      laneKey: LIVE_LANE_KEY,
      jobName: LIVE_DEFINITION.name,
      scopeKey: LIVE_SCOPE_KEY,
      queueName: LIVE_DEFINITION.queueName,
      desiredObligation: older,
      preserveFreshnessHistory: true,
    });
    const dispatch = await claimSchedulerLaneDispatch({ laneId: initial.lane.laneId });
    expect(dispatch).not.toBeNull();
    await confirmSchedulerLaneEnqueued({
      laneId: initial.lane.laneId,
      owner: dispatch!.owner,
      bullJobId: 'integration-live-deferred-job',
      obligationId: older.obligationId,
    });
    const started = await startSchedulerLane({
      laneId: initial.lane.laneId,
      dispatchGeneration: dispatch!.lane.dispatchGeneration,
      bullJobId: 'integration-live-deferred-job',
      obligationId: older.obligationId,
    });
    expect(started?.obligation.generation).toBe(0);
    expect(
      await deferSchedulerObligationForWorker({
        obligationId: older.obligationId,
        generation: 0,
        dependencyWait: { reasonCodes: ['LEAGUE_FINAL_NOT_READY'] },
      }),
    ).toBe(true);
    const completed = await completeSchedulerLane({
      laneId: initial.lane.laneId,
      dispatchGeneration: dispatch!.lane.dispatchGeneration,
      activeObligationId: older.obligationId,
      obligationGeneration: 0,
      status: 'succeeded',
    });
    expect(completed.ok).toBe(false);
    expect(completed.needsDispatch).toBe(true);
    const targets = await getSchedulerLaneTargets({ laneId: initial.lane.laneId });
    expect(targets?.lane.state).toBe('idle');
    expect(targets?.desired?.status).toBe('pending');
    expect(targets?.desired?.generation).toBe(1);
  });

  test.each(['PENDING', 'BREACHED'])(
    'retires a late %s window and its open case after supersession',
    async (status) => {
      const older = await reserve('2026-08-25T01:00:00.000Z', 'late-window-older');
      const newer = await reserve('2026-08-25T01:05:00.000Z', 'late-window-newer');
      const input = {
        laneKey: LANE_KEY,
        jobName: DEFINITION.name,
        scopeKey: SCOPE_KEY,
        queueName: 'fpl-critical-sync',
      };
      await advanceSchedulerLane({ ...input, desiredObligation: newer });
      const sql = await getDbClient();
      await sql`INSERT INTO ops.freshness_slo_windows
      (slo_key, contract_key, scope_key, period_key, eligible_at, due_at, obligation_due_at, status)
      VALUES ('market-price', 'market-price', ${SCOPE_KEY}, ${older.periodKey}, now(), now(), ${older.dueAt.toISOString()}::timestamptz, ${status})`;
      await sql`INSERT INTO ops.data_governance_cases
      (case_kind, contract_key, lane, slo_window_id, scope_key, error_class, error_code, fingerprint, compensator)
      SELECT 'freshness', 'market-price', 'test', window_id, scope_key, 'test', 'test', 'test', 'test'
      FROM ops.freshness_slo_windows WHERE scope_key=${SCOPE_KEY} AND period_key=${older.periodKey}`;
      await advanceSchedulerLane({ ...input, desiredObligation: older });
      const [window] = await sql`SELECT status FROM ops.freshness_slo_windows
      WHERE slo_key='market-price' AND scope_key=${SCOPE_KEY} AND period_key=${older.periodKey}`;
      expect(window?.status).toBe('NOT_APPLICABLE');
      const [repairCase] =
        await sql`SELECT status FROM ops.data_governance_cases WHERE scope_key=${SCOPE_KEY}`;
      expect(repairCase?.status).toBe('DISMISSED');
    },
  );

  test('retires only newly superseded windows, keeping the running target and other SLOs intact', async () => {
    const active = await reserve('2026-08-25T02:00:00.000Z', 'window-active');
    const older = await reserve('2026-08-25T02:05:00.000Z', 'window-older');
    const latest = await reserve('2026-08-25T02:10:00.000Z', 'window-latest');
    const sql = await getDbClient();
    await sql`UPDATE ops.scheduler_obligations SET status = 'running' WHERE obligation_id = ${active.obligationId}::uuid`;
    for (const [sloKey, periodKey] of [
      ['market-price', active.periodKey],
      ['market-price', older.periodKey],
      ['market-price', latest.periodKey],
      ['another-slo', older.periodKey],
    ]) {
      await sql`INSERT INTO ops.freshness_slo_windows
        (slo_key, contract_key, scope_key, period_key, eligible_at, due_at, obligation_due_at)
        VALUES (${sloKey!}, 'market-price', ${SCOPE_KEY}, ${periodKey!}, now(), now(), '2026-08-25T01:00:00Z')`;
    }
    const input = {
      laneKey: LANE_KEY,
      jobName: DEFINITION.name,
      scopeKey: SCOPE_KEY,
      queueName: 'fpl-critical-sync',
      desiredObligation: latest,
    };
    await advanceSchedulerLane(input);
    const windows = await sql`SELECT slo_key, period_key, status FROM ops.freshness_slo_windows
      WHERE scope_key = ${SCOPE_KEY} ORDER BY slo_key, period_key`;
    expect(Array.from(windows)).toEqual([
      { slo_key: 'another-slo', period_key: older.periodKey, status: 'PENDING' },
      { slo_key: 'market-price', period_key: active.periodKey, status: 'PENDING' },
      { slo_key: 'market-price', period_key: latest.periodKey, status: 'PENDING' },
      { slo_key: 'market-price', period_key: older.periodKey, status: 'NOT_APPLICABLE' },
    ]);
    // A later observation with no superseded obligations must not rescan or
    // retire an unrelated historical window based solely on its due time.
    await advanceSchedulerLane(input);
    expect(
      Array.from(
        await sql`SELECT slo_key, period_key, status FROM ops.freshness_slo_windows
      WHERE scope_key = ${SCOPE_KEY} ORDER BY slo_key, period_key`,
      ),
    ).toEqual(Array.from(windows));
  });

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

  test('rearms a waiting legacy price job during latest-wins cutover', async () => {
    const legacy = await reserve('2026-08-25T03:10:00.000Z', 'price-legacy-cutover');
    const sql = await getDbClient();
    const legacyBullJobId = `2627-scheduler-${legacy.obligationId}-g${legacy.generation}`;
    await sql`
      UPDATE ops.scheduler_obligations
      SET status = 'enqueued', bull_job_id = ${legacyBullJobId}
      WHERE obligation_id = ${legacy.obligationId}::uuid
    `;

    const advanced = await advanceSchedulerLane({
      laneKey: LANE_KEY,
      jobName: DEFINITION.name,
      scopeKey: SCOPE_KEY,
      queueName: 'fpl-critical-sync',
      desiredObligation: legacy,
    });

    expect(advanced.shouldDispatch).toBe(true);
    expect(advanced.lane.desiredObligationId).not.toBe(legacy.obligationId);
    const targets = await getSchedulerLaneTargets({ laneId: advanced.lane.laneId });
    expect(targets?.desired?.status).toBe('pending');
    expect(targets?.desired?.evidence.cutoverRearmedFromObligationId).toBe(legacy.obligationId);
    const retired = await sql<Array<{ status: string; reason: string }>>`
      SELECT status, evidence->>'reason' AS reason
      FROM ops.scheduler_obligations
      WHERE obligation_id = ${legacy.obligationId}::uuid
    `;
    expect(retired[0]).toEqual({ status: 'skipped', reason: 'cutover-superseded' });
  });

  test('deterministically supersedes equal-time obligations by period key', async () => {
    const first = await reserve('2026-08-25T03:20:00.000Z', 'price-equal-a');
    const second = await reserve('2026-08-25T03:20:00.000Z', 'price-equal-b');
    const initial = await advanceSchedulerLane({
      laneKey: LANE_KEY,
      jobName: DEFINITION.name,
      scopeKey: SCOPE_KEY,
      queueName: 'fpl-critical-sync',
      desiredObligation: first,
    });
    const advanced = await advanceSchedulerLane({
      laneKey: LANE_KEY,
      jobName: DEFINITION.name,
      scopeKey: SCOPE_KEY,
      queueName: 'fpl-critical-sync',
      desiredObligation: second,
    });

    expect(initial.lane.laneId).toBe(advanced.lane.laneId);
    expect(advanced.lane.desiredObligationId).toBe(second.obligationId);
    const sql = await getDbClient();
    const statuses = await sql<Array<{ periodKey: string; status: string; reason: string | null }>>`
      SELECT period_key AS "periodKey", status, evidence->>'reason' AS reason
      FROM ops.scheduler_obligations
      WHERE job_name = ${DEFINITION.name} AND scope_key = ${SCOPE_KEY}
      ORDER BY period_key
    `;
    expect(Array.from(statuses)).toEqual([
      {
        periodKey: 'price-equal-a',
        status: 'skipped',
        reason: 'superseded-by-latest-authoritative',
      },
      { periodKey: 'price-equal-b', status: 'pending', reason: null },
    ]);
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

  test('replaces a stale Core-source target instead of replaying it forever', async () => {
    const first = await reserve('2026-08-25T04:07:00.000Z', 'price-core-source-stale');
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
      bullJobId: 'integration-price-job-core-source-stale',
      obligationId: first.obligationId,
    });
    const started = await startSchedulerLane({
      laneId: initial.lane.laneId,
      dispatchGeneration: dispatch!.lane.dispatchGeneration,
      bullJobId: 'integration-price-job-core-source-stale',
    });
    expect(started).not.toBeNull();
    expect(
      await blockSchedulerLane({
        laneId: initial.lane.laneId,
        dispatchGeneration: dispatch!.lane.dispatchGeneration,
        activeObligationId: first.obligationId,
        blockerJobId: 'integration-core-repair-stale',
        error: new Error('Core source is older than active publication'),
        blockerEvidence: {
          sourceHash: 'a'.repeat(64),
          sourceArtifactId: '00000000-0000-4000-8000-000000000001',
          priceChangeBoardRevision: '0123456789abcdef',
          sourceDetectedAt: '2026-08-25T04:07:01.000Z',
          sourceFetchedAt: '2026-08-25T04:07:02.000Z',
        },
      }),
    ).toBe(true);

    const sql = await getDbClient();
    const blockedObligation = await sql<
      Array<{
        status: string;
        last_error: string | null;
        blocker_job_id: string | null;
        blocker_error: string | null;
      }>
    >`
      SELECT status,
             last_error,
             evidence->>'blockerJobId' AS blocker_job_id,
             evidence->>'blockerError' AS blocker_error
      FROM ops.scheduler_obligations
      WHERE obligation_id = ${first.obligationId}::uuid
    `;
    expect(blockedObligation[0]).toEqual({
      status: 'pending',
      last_error: null,
      blocker_job_id: 'integration-core-repair-stale',
      blocker_error: 'Core source is older than active publication',
    });

    const replaced = await replaceBlockedSchedulerLaneAfterCoreSourceStale({
      laneId: initial.lane.laneId,
      dispatchGeneration: dispatch!.lane.dispatchGeneration,
      activeObligationId: first.obligationId,
      blockerJobId: 'integration-core-repair-stale',
    });
    expect(replaced.ok).toBe(true);
    expect(replaced.replaced).toBe(true);
    expect(replaced.obligation?.obligationId).not.toBe(first.obligationId);
    expect(replaced.obligation?.status).toBe('pending');
    expect(replaced.obligation?.evidence.sourceHash).toBeUndefined();
    expect(replaced.obligation?.evidence.sourceArtifactId).toBeUndefined();
    expect(replaced.obligation?.evidence.priceChangeBoardRevision).toBeUndefined();
    expect(replaced.lane).toMatchObject({
      state: 'idle',
      activeObligationId: null,
      blockerJobId: null,
      desiredObligationId: replaced.obligation?.obligationId,
    });

    const old = await sql<Array<{ status: string; reason: string | null }>>`
      SELECT status, evidence->>'reason' AS reason
      FROM ops.scheduler_obligations
      WHERE obligation_id = ${first.obligationId}::uuid
    `;
    expect(old[0]).toEqual({ status: 'skipped', reason: 'core-source-superseded' });

    const replay = await replaceBlockedSchedulerLaneAfterCoreSourceStale({
      laneId: initial.lane.laneId,
      dispatchGeneration: dispatch!.lane.dispatchGeneration,
      activeObligationId: first.obligationId,
      blockerJobId: 'integration-core-repair-stale',
    });
    expect(replay).toMatchObject({ ok: true, replaced: false });
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

  test('clears a previous lane error when a retry succeeds or is observed terminal', async () => {
    const first = await reserve('2026-08-25T04:12:00.000Z', 'price-clears-lane-error');
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
      bullJobId: 'integration-price-job-clears-lane-error',
    });

    const sql = await getDbClient();
    // Model a prior Bull-loss error surviving until the next attempt starts.
    await sql`
      UPDATE ops.scheduler_lanes
      SET last_error = 'Bull job failed before durable completion'
      WHERE lane_id = ${initial.lane.laneId}
    `;
    const started = await startSchedulerLane({
      laneId: initial.lane.laneId,
      dispatchGeneration: dispatch!.lane.dispatchGeneration,
      bullJobId: 'integration-price-job-clears-lane-error',
    });
    expect(started?.lane.lastError).toBeNull();

    const completed = await completeSchedulerLane({
      laneId: initial.lane.laneId,
      dispatchGeneration: dispatch!.lane.dispatchGeneration,
      activeObligationId: first.obligationId,
      status: 'succeeded',
    });
    expect(completed.lane?.lastError).toBeNull();

    // A legacy runtime may have already persisted a terminal obligation while
    // leaving a lane error behind. The next scheduler observation must repair
    // that stale diagnostic without redispatching the completed target.
    await sql`
      UPDATE ops.scheduler_lanes
      SET last_error = 'stale terminal lane error'
      WHERE lane_id = ${initial.lane.laneId}
    `;
    const observed = await advanceSchedulerLane({
      laneKey: LANE_KEY,
      jobName: DEFINITION.name,
      scopeKey: SCOPE_KEY,
      queueName: 'fpl-critical-sync',
      desiredObligation: first,
    });
    expect(observed.lane.lastError).toBeNull();
    expect(observed.shouldDispatch).toBe(false);
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

  test('does not recover a missing dispatch while its lease is active', async () => {
    const first = await reserve('2026-08-25T05:05:00.000Z', 'price-dispatch-lease-active');
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
      await recoverSchedulerLaneAfterBullLoss({
        laneId: initial.lane.laneId,
        dispatchGeneration: dispatch!.lane.dispatchGeneration,
        bullJobId: 'integration-price-job-missing-while-lease-active',
        bullState: 'missing',
        obligationId: first.obligationId,
      }),
    ).toBe(false);
    const stillDispatching = await getSchedulerLaneTargets({ laneId: initial.lane.laneId });
    expect(stillDispatching?.lane.state).toBe('dispatching');
    expect(stillDispatching?.lane.dispatchGeneration).toBe(1);

    const sql = await getDbClient();
    await sql`
      UPDATE ops.scheduler_lanes
      SET dispatch_lease_expires_at = clock_timestamp() - interval '1 second'
      WHERE lane_id = ${initial.lane.laneId}
    `;
    expect(
      await recoverSchedulerLaneAfterBullLoss({
        laneId: initial.lane.laneId,
        dispatchGeneration: dispatch!.lane.dispatchGeneration,
        bullJobId: 'integration-price-job-missing-after-lease-expiry',
        bullState: 'missing',
        obligationId: first.obligationId,
      }),
    ).toBe(true);
    const recovered = await getSchedulerLaneTargets({ laneId: initial.lane.laneId });
    expect(recovered?.lane.state).toBe('idle');
    expect(recovered?.desired?.status).toBe('failed');
  });

  test('recovers a dispatching lane when Bull is missing before confirmation', async () => {
    const first = await reserve('2026-08-25T05:07:00.000Z', 'price-dispatch-missing');
    const initial = await advanceSchedulerLane({
      laneKey: LANE_KEY,
      jobName: DEFINITION.name,
      scopeKey: SCOPE_KEY,
      queueName: 'fpl-critical-sync',
      desiredObligation: first,
    });
    const dispatch = await claimSchedulerLaneDispatch({ laneId: initial.lane.laneId });
    expect(dispatch).not.toBeNull();
    const sql = await getDbClient();
    await sql`
      UPDATE ops.scheduler_lanes
      SET dispatch_lease_expires_at = clock_timestamp() - interval '1 second'
      WHERE lane_id = ${initial.lane.laneId}
    `;
    expect(
      await recoverSchedulerLaneAfterBullLoss({
        laneId: initial.lane.laneId,
        dispatchGeneration: dispatch!.lane.dispatchGeneration,
        bullJobId: 'integration-price-job-missing-before-confirmation',
        bullState: 'missing',
        obligationId: first.obligationId,
      }),
    ).toBe(true);
    const targets = await getSchedulerLaneTargets({ laneId: initial.lane.laneId });
    expect(targets?.lane.state).toBe('idle');
    expect(targets?.desired?.status).toBe('failed');
    expect(targets?.desired?.bullJobId).toBe('integration-price-job-missing-before-confirmation');
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
    const sql = await getDbClient();
    // Model the scheduler having already confirmed the newer Bull payload.
    // A stale retry of the first payload must not overwrite this source-run
    // identity when it fences onto the newer desired target.
    await sql`
      UPDATE ops.scheduler_obligations
      SET run_id = ${second.obligationId}::uuid
      WHERE obligation_id = ${second.obligationId}::uuid
    `;
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
    expect(target?.obligation.runId).toBe(second.obligationId);
    const targets = await getSchedulerLaneTargets({ laneId: initial.lane.laneId });
    expect(targets?.lane.activeObligationId).toBe(second.obligationId);
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
