import { UnrecoverableError } from 'bullmq';
import { describe, expect, test } from 'bun:test';

import { isTerminalJobAttemptFailure, isTerminalJobFailure } from '../../src/utils/worker-failure';

describe('worker failure terminality', () => {
  const job = { attemptsMade: 1, opts: { attempts: 3 } };

  test('treats unrecoverable BullMQ errors as terminal immediately', () => {
    expect(isTerminalJobFailure(job, new UnrecoverableError('invalid payload'))).toBe(true);
  });

  test('keeps retryable failures non-terminal before the final attempt', () => {
    expect(isTerminalJobFailure(job, new Error('temporary failure'))).toBe(false);
  });

  test('classifies the current worker attempt before BullMQ increments attemptsMade', () => {
    expect(
      isTerminalJobAttemptFailure(
        { attemptsMade: 0, opts: { attempts: 3 } },
        new Error('retry'),
        1,
      ),
    ).toBe(false);
    expect(
      isTerminalJobAttemptFailure(
        { attemptsMade: 1, opts: { attempts: 3 } },
        new Error('retry'),
        2,
      ),
    ).toBe(false);
    expect(
      isTerminalJobAttemptFailure(
        { attemptsMade: 2, opts: { attempts: 3 } },
        new Error('retry'),
        3,
      ),
    ).toBe(true);
  });

  test('classifies an unrecoverable error as terminal on the first attempt', () => {
    expect(
      isTerminalJobAttemptFailure(
        { attemptsMade: 0, opts: { attempts: 3 } },
        new UnrecoverableError('invalid payload'),
        1,
      ),
    ).toBe(true);
  });
});
