import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';

import { logError, logInfo, logger, serializeError } from '../../src/utils/logger';

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
    expect(String(serialized.stack).length).toBeLessThanOrEqual(520);
    expect(String(serialized.stack)).not.toContain('\n');
    expect(serialized.code).toBe('UPSTREAM_FAILURE');
    expect(serialized.status).toBe(503);
  });

  test('writes an error once to the stdout logger', () => {
    const errorSpy = spyOn(logger, 'error').mockImplementation(() => undefined as never);

    logError('Worker failed', new Error('boom'), { jobId: 'job-1' });

    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  test('redacts entry identifiers and sensitive payloads from structured logs', () => {
    const infoSpy = spyOn(logger, 'info').mockImplementation(() => undefined as never);

    logInfo('Entry sync progress', {
      entryId: 123456,
      entryIds: [123456, 123457],
      url: 'https://fantasy.premierleague.com/api/entry/123456/event/1/picks/',
      jobId: 'entry-results-entry-123456',
      scopeKey: 'entry-core:2026:123456',
      safeCount: 2,
    });

    const [payload] = infoSpy.mock.calls[0] ?? [];
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('123456');
    expect(serialized).not.toContain('123457');
    expect((payload as unknown as Record<string, unknown>).safeCount).toBe(2);
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
