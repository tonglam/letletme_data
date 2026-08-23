import { describe, expect, test } from 'bun:test';

import { UnderstatClientError } from '../../src/clients/understat';
import {
  UNDERSTAT_MAX_SCHEDULER_GENERATIONS,
  isUnderstatNonRetryableError,
  understatObligationFailureDisposition,
} from '../../src/services/understat-recovery.service';

describe('Understat scheduler recovery policy', () => {
  test('allows at most three scheduler generations for retryable failures', () => {
    expect(understatObligationFailureDisposition(0, false)).toBe('retry');
    expect(understatObligationFailureDisposition(1, false)).toBe('retry');
    expect(
      understatObligationFailureDisposition(UNDERSTAT_MAX_SCHEDULER_GENERATIONS - 1, false),
    ).toBe('terminal');
  });

  test('ends the current obligation immediately for non-retryable provider errors', () => {
    expect(understatObligationFailureDisposition(0, true)).toBe('terminal');
    expect(understatObligationFailureDisposition(undefined, true)).toBe('terminal');
    const serializedUnrecoverable = new Error('serialized failure');
    serializedUnrecoverable.name = 'UnrecoverableError';
    expect(isUnderstatNonRetryableError(serializedUnrecoverable)).toBe(true);
    expect(
      isUnderstatNonRetryableError(new UnderstatClientError('bad schema', 'VALIDATION_ERROR')),
    ).toBe(true);
    expect(
      isUnderstatNonRetryableError(
        new UnderstatClientError('temporary outage', 'HTTP_ERROR', 503, undefined, true),
      ),
    ).toBe(false);
  });
});
