import { UnrecoverableError } from 'bullmq';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';

import * as schedulerObligationsRepository from '../../src/repositories/scheduler-obligations';
import {
  inspectSchedulerObligationFence,
  startCurrentSchedulerJob,
} from '../../src/utils/scheduler-obligation-fence';

let restoreRepositorySpy: (() => void) | undefined;
afterEach(() => {
  restoreRepositorySpy?.();
  restoreRepositorySpy = undefined;
});

describe('scheduler obligation worker fence', () => {
  test('distinguishes manual, complete, and malformed job metadata', () => {
    expect(inspectSchedulerObligationFence({})).toEqual({ kind: 'none' });
    expect(
      inspectSchedulerObligationFence({
        obligationId: 'scheduled-obligation',
        obligationGeneration: 3,
      }),
    ).toEqual({
      kind: 'complete',
      obligationId: 'scheduled-obligation',
      generation: 3,
    });
    expect(inspectSchedulerObligationFence({ obligationId: 'scheduled-obligation' })).toEqual({
      kind: 'malformed',
      reason: 'obligationGeneration must be a non-negative safe integer',
    });
    expect(inspectSchedulerObligationFence({ obligationGeneration: 3 })).toEqual({
      kind: 'malformed',
      reason: 'obligationId must be a non-empty string',
    });
    expect(
      inspectSchedulerObligationFence({
        obligationId: 'scheduled-obligation',
        obligationGeneration: -1,
      }),
    ).toEqual({
      kind: 'malformed',
      reason: 'obligationGeneration must be a non-negative safe integer',
    });
  });

  test('fails an incomplete scheduled fence closed without touching the repository', async () => {
    const rejection = startCurrentSchedulerJob(
      { obligationId: 'scheduled-obligation' },
      { queueName: 'test-queue', jobName: 'test-job', jobId: 'test-id' },
    );

    await expect(rejection).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(rejection).rejects.toThrow('Incomplete scheduler generation fence');
  });

  test('starts the exact current generation and returns the repository decision', async () => {
    const start = spyOn(
      schedulerObligationsRepository,
      'startSchedulerObligation',
    ).mockResolvedValue(true);
    restoreRepositorySpy = () => start.mockRestore();

    await expect(
      startCurrentSchedulerJob(
        { obligationId: 'scheduled-obligation', obligationGeneration: 4 },
        { queueName: 'test-queue', jobName: 'test-job', jobId: 'test-id' },
      ),
    ).resolves.toBe(true);
    expect(start).toHaveBeenCalledWith({ obligationId: 'scheduled-obligation', generation: 4 });
  });

  test('skips a stale generation before execution', async () => {
    const start = spyOn(
      schedulerObligationsRepository,
      'startSchedulerObligation',
    ).mockResolvedValue(false);
    restoreRepositorySpy = () => start.mockRestore();

    await expect(
      startCurrentSchedulerJob(
        { obligationId: 'scheduled-obligation', obligationGeneration: 5 },
        { queueName: 'test-queue', jobName: 'test-job', jobId: 'test-id' },
      ),
    ).resolves.toBe(false);
  });

  test('allows manual jobs without a scheduler fence', async () => {
    const start = spyOn(schedulerObligationsRepository, 'startSchedulerObligation');
    restoreRepositorySpy = () => start.mockRestore();

    await expect(
      startCurrentSchedulerJob({}, { queueName: 'test-queue', jobName: 'test-job' }),
    ).resolves.toBe(true);
    expect(start).not.toHaveBeenCalled();
  });
});
