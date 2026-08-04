import { describe, expect, test } from 'bun:test';

import { LIVE_SNAPSHOT_SCHEDULES } from '../../src/jobs/live.jobs';

describe('live snapshot scheduler intent', () => {
  test('keeps cache polling and durable checkpoints on independent schedules', () => {
    expect(LIVE_SNAPSHOT_SCHEDULES).toEqual({
      cache: {
        name: 'live-snapshot-trigger',
        pattern: '* * * * *',
        persistEventLives: false,
      },
      persistence: {
        name: 'live-snapshot-persistence-trigger',
        pattern: '*/10 * * * *',
        persistEventLives: true,
      },
    });
  });
});
