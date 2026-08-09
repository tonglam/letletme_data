import { UnrecoverableError } from 'bullmq';
import { describe, expect, test } from 'bun:test';

import { isTerminalJobFailure } from '../../src/utils/worker-failure';

describe('worker failure terminality', () => {
  const job = { attemptsMade: 1, opts: { attempts: 3 } };

  test('treats unrecoverable BullMQ errors as terminal immediately', () => {
    expect(isTerminalJobFailure(job, new UnrecoverableError('invalid payload'))).toBe(true);
  });

  test('keeps retryable failures non-terminal before the final attempt', () => {
    expect(isTerminalJobFailure(job, new Error('temporary failure'))).toBe(false);
  });
});
