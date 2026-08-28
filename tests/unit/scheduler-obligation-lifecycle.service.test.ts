import { describe, expect, mock, test } from 'bun:test';

import type { SchedulerObligation } from '../../src/repositories/scheduler-obligations';
import { createSchedulerObligationLifecycle } from '../../src/services/scheduler-obligation-lifecycle.service';

const completedAt = new Date('2026-08-28T01:02:03.000Z');

function obligation(overrides: Partial<SchedulerObligation> = {}): SchedulerObligation {
  return {
    obligationId: '00000000-0000-4000-8000-000000000001',
    jobName: 'entry-picks',
    scopeKey: 'season:2627:event:1',
    periodKey: '2026-08-28T01:00:00.000Z',
    cadence: '*/5 * * * *',
    timezone: 'UTC',
    status: 'succeeded',
    source: 'schedule',
    dueAt: new Date('2026-08-28T01:00:00.000Z'),
    generation: 2,
    attempts: 1,
    bullJobId: 'bull-1',
    runId: 'run-1',
    completedAt,
    leaseOwner: null,
    leaseExpiresAt: null,
    evidence: {},
    ...overrides,
  };
}

function fakes(row: SchedulerObligation | null = obligation()) {
  return {
    complete: mock(async (_input: unknown) => true),
    completeByBullJobId: mock(async (_input: unknown) => true),
    fail: mock(async (_input: unknown) => true),
    failByBullJobId: mock(async (_input: unknown) => true),
    getById: mock(async (_input: unknown) => row),
    getByBullJobId: mock(async (_input: unknown) => row),
    recordFreshness: mock(async (_input: Record<string, unknown>) => 1),
    openCase: mock(async (_input: Record<string, unknown>) => row?.obligationId ?? 'case-1'),
    now: () => completedAt,
    reportError: mock(() => undefined),
  };
}

describe('scheduler obligation lifecycle service', () => {
  test('records deduplicated checkpoint evidence with deterministic completeness', async () => {
    const row = obligation({
      evidence: {
        freshnessWindowIds: [7, 7, -1, 'bad'],
        freshnessWindowId: 8,
        checkpointRevision: 42,
        expectedUnits: 10,
        succeededUnits: 9,
        failedUnits: 1,
      },
    });
    const dependencies = fakes(row);
    const lifecycle = createSchedulerObligationLifecycle(dependencies as never);

    expect(
      await lifecycle.completeSchedulerObligation({
        obligationId: row.obligationId,
        status: 'succeeded',
      }),
    ).toBe(true);
    expect(dependencies.getById).toHaveBeenCalledTimes(1);
    expect(dependencies.recordFreshness).toHaveBeenCalledTimes(2);
    expect(dependencies.recordFreshness.mock.calls.map((call) => call[0].windowId)).toEqual([7, 8]);
    expect(dependencies.recordFreshness.mock.calls[0]?.[0]).toMatchObject({
      producerRevision: '42',
      expectedCount: 10,
      observedCount: 9,
      completenessStatus: 'INCOMPLETE',
      sourceCheckedAt: completedAt,
    });
  });

  test('skips side effects when persistence did not change or evidence is irrelevant', async () => {
    const dependencies = fakes(obligation({ jobName: 'market-daily' }));
    dependencies.complete.mockImplementationOnce(async () => false);
    const lifecycle = createSchedulerObligationLifecycle(dependencies as never);

    expect(
      await lifecycle.completeSchedulerObligation({
        obligationId: 'unchanged',
        status: 'succeeded',
      }),
    ).toBe(false);
    expect(dependencies.getById).not.toHaveBeenCalled();

    expect(await lifecycle.completeSchedulerObligationByBullJobId({ bullJobId: 'bull-1' })).toBe(
      true,
    );
    expect(dependencies.recordFreshness).not.toHaveBeenCalled();
  });

  test('keeps freshness telemetry failures best effort', async () => {
    const dependencies = fakes(obligation({ evidence: { freshnessWindowId: 7, complete: true } }));
    dependencies.recordFreshness.mockImplementation(async () => {
      throw new Error('freshness store unavailable');
    });
    const lifecycle = createSchedulerObligationLifecycle(dependencies as never);

    await lifecycle.recordCheckpointFreshnessEvidence(
      obligation({ evidence: { freshnessWindowId: 7, complete: true } }),
    );
    expect(dependencies.reportError).toHaveBeenCalledTimes(1);
  });

  test('opens governance cases for durable terminal failures by id and Bull job id', async () => {
    const row = obligation({ status: 'irrecoverable' });
    const dependencies = fakes(row);
    const lifecycle = createSchedulerObligationLifecycle(dependencies as never);

    expect(
      await lifecycle.failSchedulerObligation({
        obligationId: row.obligationId,
        error: new Error('terminal provider failure'),
      }),
    ).toBe(true);
    expect(dependencies.openCase).toHaveBeenCalledTimes(1);
    expect(dependencies.openCase.mock.calls[0]?.[0]).toMatchObject({
      caseKind: 'scheduler-failure',
      obligationId: row.obligationId,
      scopeKey: row.scopeKey,
    });

    expect(
      await lifecycle.failSchedulerObligationByBullJobId({
        bullJobId: 'bull-1',
        error: new Error('second terminal failure'),
      }),
    ).toBe(true);
    expect(dependencies.openCase).toHaveBeenCalledTimes(2);
  });

  test('does not read or open cases when a failure fence rejects the write', async () => {
    const dependencies = fakes();
    dependencies.fail.mockImplementationOnce(async () => false);
    dependencies.failByBullJobId.mockImplementationOnce(async () => false);
    const lifecycle = createSchedulerObligationLifecycle(dependencies as never);

    expect(
      await lifecycle.failSchedulerObligation({
        obligationId: 'stale',
        error: new Error('stale generation'),
      }),
    ).toBe(false);
    expect(
      await lifecycle.failSchedulerObligationByBullJobId({
        bullJobId: 'stale-bull',
        error: new Error('stale generation'),
      }),
    ).toBe(false);
    expect(dependencies.getById).not.toHaveBeenCalled();
    expect(dependencies.getByBullJobId).not.toHaveBeenCalled();
    expect(dependencies.openCase).not.toHaveBeenCalled();
  });

  test('reports governance persistence errors without changing the durable failure', async () => {
    const dependencies = fakes(obligation({ status: 'irrecoverable' }));
    dependencies.openCase.mockImplementation(async () => {
      throw new Error('governance unavailable');
    });
    const lifecycle = createSchedulerObligationLifecycle(dependencies as never);

    expect(
      await lifecycle.failSchedulerObligation({
        obligationId: 'terminal',
        error: new Error('terminal'),
      }),
    ).toBe(true);
    expect(dependencies.reportError).toHaveBeenCalledTimes(1);
  });
});
