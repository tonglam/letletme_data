import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';

import { runTrackedJob } from '../../src/utils/job-run-logger';
import { logger } from '../../src/utils/logger';
import { PlayerValuesWindowPendingError } from '../../src/domain/player-values-window';

afterEach(() => {
  mock.restore();
});

describe('job lifecycle logging', () => {
  test('logs routine start and success lifecycle events at debug', async () => {
    const debugSpy = spyOn(logger, 'debug').mockImplementation(() => undefined as never);

    await runTrackedJob({ jobType: 'cron', jobName: 'test-job' }, async () => 'ok');

    expect(debugSpy).toHaveBeenCalledTimes(2);
  });

  test('keeps failed lifecycle events at error', async () => {
    const debugSpy = spyOn(logger, 'debug').mockImplementation(() => undefined as never);
    const errorSpy = spyOn(logger, 'error').mockImplementation(() => undefined as never);

    await expect(
      runTrackedJob({ jobType: 'queue', jobName: 'test-job' }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  test('keeps expected market-window waits at debug instead of error', async () => {
    const debugSpy = spyOn(logger, 'debug').mockImplementation(() => undefined as never);
    const errorSpy = spyOn(logger, 'error').mockImplementation(() => undefined as never);

    await expect(
      runTrackedJob({ jobType: 'queue', jobName: 'player-values' }, async () => {
        throw new PlayerValuesWindowPendingError('20260829');
      }),
    ).rejects.toBeInstanceOf(PlayerValuesWindowPendingError);

    expect(debugSpy).toHaveBeenCalledTimes(2);
    expect(debugSpy.mock.calls[1]?.[0]).toMatchObject({
      status: 'pending',
      changeDate: '20260829',
    });
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
