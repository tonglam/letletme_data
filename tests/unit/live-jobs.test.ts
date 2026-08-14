import { describe, expect, test } from 'bun:test';

import { LIVE_SNAPSHOT_SCHEDULES } from '../../src/jobs/live.jobs';

describe('live snapshot scheduler intent', () => {
  test('uses one configurable 30 second lifecycle scheduler', () => {
    expect(LIVE_SNAPSHOT_SCHEDULES).toEqual({
      lifecycle: { name: 'live-lifecycle', intervalMs: 30_000 },
    });
  });
});
