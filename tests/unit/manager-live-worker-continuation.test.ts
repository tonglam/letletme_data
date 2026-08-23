import { describe, expect, test } from 'bun:test';

import type { ManagerLiveJobData } from '../../src/queues/manager-live.queue';

process.env.DATABASE_URL ??= 'postgresql://unit:unit@127.0.0.1:5432/unit';

const { scheduleManagerLiveContinuation } = await import('../../src/workers/manager-live.worker');

const jobData: ManagerLiveJobData = {
  version: 1,
  seasonId: 1,
  seasonCode: '2025',
  eventId: 1,
  entryIds: [101, 102],
  tournamentId: 7,
  source: 'request',
  triggeredAt: '2026-08-23T00:00:00.000Z',
};

describe('manager live worker continuation', () => {
  test('passes the persisted logical cursor through retries unchanged', async () => {
    const calls: number[] = [];
    await scheduleManagerLiveContinuation(
      { ...jobData, generation: 'generation-a', summaryRotationCursor: 4 },
      {
        nextRefreshAt: '2026-08-23T00:00:30.000Z',
        classicStandingsNextPage: undefined,
        errorCode: 'UPSTREAM_UNAVAILABLE',
      },
      undefined,
      async (data) => {
        calls.push(data.summaryRotationCursor ?? -1);
        return null;
      },
    ).catch(() => undefined);
    expect(calls).toEqual([4]);
  });

  test('schedules the hot follow-up before surfacing a partial upstream failure', async () => {
    const calls: string[] = [];
    const promise = scheduleManagerLiveContinuation(
      jobData,
      {
        nextRefreshAt: '2026-08-23T00:00:30.000Z',
        classicStandingsNextPage: 3,
        errorCode: 'UPSTREAM_UNAVAILABLE',
      },
      5,
      async (_data, nextRefreshAt, classicStandingsNextPage, classicStandingsStartPage) => {
        calls.push(`${nextRefreshAt}:${classicStandingsNextPage}:${classicStandingsStartPage}`);
        return null;
      },
    );

    await expect(promise).rejects.toThrow('UPSTREAM_UNAVAILABLE');
    expect(calls).toEqual(['2026-08-23T00:00:30.000Z:3:5']);
  });

  test('completes after scheduling when the refresh has no upstream error', async () => {
    let scheduled = false;
    await scheduleManagerLiveContinuation(
      jobData,
      {
        nextRefreshAt: '2026-08-23T00:00:30.000Z',
        classicStandingsNextPage: null,
        errorCode: null,
      },
      1,
      async () => {
        scheduled = true;
        return null;
      },
    );
    expect(scheduled).toBe(true);
  });
});
