import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';

import { logError, logger, serializeError } from '../../src/utils/logger';

afterEach(() => {
  mock.restore();
});

describe('structured logger', () => {
  test('bounds error messages and stack traces while keeping metadata', () => {
    const error = new Error('m'.repeat(3_000)) as Error & { code: string; status: number };
    error.code = 'UPSTREAM_FAILURE';
    error.status = 503;
    error.stack = `Error: failure\n${'s'.repeat(10_000)}`;

    const serialized = serializeError(error) as Record<string, unknown>;

    expect(String(serialized.message).length).toBeLessThanOrEqual(2_020);
    expect(String(serialized.stack).length).toBeLessThanOrEqual(8_020);
    expect(serialized.code).toBe('UPSTREAM_FAILURE');
    expect(serialized.status).toBe(503);
  });

  test('writes an error once to the stdout logger', () => {
    const errorSpy = spyOn(logger, 'error').mockImplementation(() => undefined as never);

    logError('Worker failed', new Error('boom'), { jobId: 'job-1' });

    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  test('keeps bounded scalar metadata from non-Error objects', () => {
    expect(serializeError({ errorCount: 3, totalCount: 10, detail: 'd'.repeat(3_000) })).toEqual({
      message: 'Non-Error object thrown',
      errorCount: 3,
      totalCount: 10,
      detail: `${'d'.repeat(2_000)}...[truncated]`,
    });
  });
});
