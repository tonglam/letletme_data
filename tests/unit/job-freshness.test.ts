import { describe, expect, mock, test } from 'bun:test';

import { resolveJobFreshAfter } from '../../src/utils/job-freshness';

describe('BullMQ freshness cutoff', () => {
  test('persists the first database cutoff and reuses it on later attempts', async () => {
    const updateData = mock(async () => undefined);
    const readOrderingTimestamp = mock(async () => ({
      date: new Date('2026-08-08T08:00:00.123Z'),
      exact: '2026-08-08T08:00:00.123456Z',
    }));
    const job = {
      data: {} as { freshAfter?: string },
      updateData,
    };

    expect(await resolveJobFreshAfter(job, readOrderingTimestamp)).toBe(
      '2026-08-08T08:00:00.123456Z',
    );
    expect(await resolveJobFreshAfter(job, readOrderingTimestamp)).toBe(
      '2026-08-08T08:00:00.123456Z',
    );
    expect(readOrderingTimestamp).toHaveBeenCalledTimes(1);
    expect(updateData).toHaveBeenCalledTimes(1);
  });
});
