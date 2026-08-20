import { describe, expect, test } from 'bun:test';

import {
  ACQUIRE_SCRIPT,
  acquireFplRequest,
  getFplAdmissionStats,
  resetFplAdmissionForTests,
} from '../../src/utils/fpl-admission';

describe('FPL admission reservations', () => {
  test('clamps a persisted bulk limit to the current configured ceiling', () => {
    expect(ACQUIRE_SCRIPT).toContain('if bulkLimit > configuredBulkLimit then');
    expect(ACQUIRE_SCRIPT).toContain('bulkLimit');
  });

  test('reserves capacity before rate-gate waits', async () => {
    resetFplAdmissionForTests();
    const capacity = getFplAdmissionStats().bulkMaxInflight;
    const requests = Array.from({ length: capacity + 2 }, () => acquireFplRequest('bulk'));

    const queuedStats = getFplAdmissionStats();
    expect(queuedStats.inflight).toBeLessThanOrEqual(capacity);
    expect(queuedStats.bulkInflight).toBeLessThanOrEqual(capacity);
    expect(queuedStats.queued).toBeGreaterThan(0);

    const activeReleases = await Promise.all(requests.slice(0, capacity));
    activeReleases.forEach((release) => release());
    const queuedReleases = await Promise.all(requests.slice(capacity));
    queuedReleases.forEach((release) => release());

    expect(getFplAdmissionStats().inflight).toBe(0);
  });
});
