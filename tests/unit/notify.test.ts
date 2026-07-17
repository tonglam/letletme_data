import { describe, expect, mock, test } from 'bun:test';

import { alertOnFinalFailure } from '../../src/utils/notify';

describe('alertOnFinalFailure', () => {
  test('does not alert for intermediate (retryable) failures', async () => {
    const send = mock(async (_message: string) => {});

    await alertOnFinalFailure(
      {
        queueName: 'data-sync-p1',
        jobName: 'fixtures',
        jobId: 'j1',
        attemptsMade: 1,
        attempts: 3,
        error: new Error('boom'),
      },
      send,
    );

    expect(send).not.toHaveBeenCalled();
  });

  test('alerts when attempts are exhausted, with job context in the message', async () => {
    const send = mock(async (_message: string) => {});

    await alertOnFinalFailure(
      {
        queueName: 'live-data-p0',
        jobName: 'event-lives-db',
        jobId: 'job-42',
        attemptsMade: 3,
        attempts: 3,
        tier: 'p0',
        error: new Error('FPL API timeout'),
      },
      send,
    );

    expect(send).toHaveBeenCalledTimes(1);
    const message = send.mock.calls[0][0];
    expect(message).toContain('live-data-p0/event-lives-db');
    expect(message).toContain('job-42');
    expect(message).toContain('3/3 attempts');
    expect(message).toContain('FPL API timeout');
    expect(message).toContain('[p0]');
  });

  test('treats jobs without configured attempts as final on first failure', async () => {
    const send = mock(async (_message: string) => {});

    await alertOnFinalFailure(
      {
        queueName: 'tournament-setup-p0',
        jobName: 'tournament-setup',
        jobId: 'j9',
        attemptsMade: 1,
        attempts: undefined,
        error: 'db gone',
      },
      send,
    );

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toContain('1/1 attempts');
    expect(send.mock.calls[0]?.[0]).toContain('db gone');
  });

  test('never throws when the sender fails', async () => {
    const send = mock(async () => {
      throw new Error('telegram down');
    });

    await expect(
      alertOnFinalFailure(
        {
          queueName: 'entry-sync-p2',
          jobName: 'entry-picks',
          jobId: 'j3',
          attemptsMade: 3,
          attempts: 3,
          error: new Error('x'),
        },
        send,
      ),
    ).resolves.toBeUndefined();
  });

  test('truncates very long error messages', async () => {
    const send = mock(async (_message: string) => {});

    await alertOnFinalFailure(
      {
        queueName: 'q',
        jobName: 'j',
        jobId: 'i',
        attemptsMade: 2,
        attempts: 2,
        error: new Error('y'.repeat(5000)),
      },
      send,
    );

    expect(send.mock.calls[0]?.[0].length).toBeLessThanOrEqual(900);
  });
});
