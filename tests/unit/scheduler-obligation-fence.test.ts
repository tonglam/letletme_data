import { UnrecoverableError } from 'bullmq';
import { describe, expect, test } from 'bun:test';

import {
  inspectSchedulerObligationFence,
  startCurrentSchedulerJob,
} from '../../src/utils/scheduler-obligation-fence';

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
});
