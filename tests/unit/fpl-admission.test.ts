import { describe, expect, test } from 'bun:test';

import {
  ACQUIRE_SCRIPT,
  acquireFplRequest,
  closeFplCriticalWindow,
  getFplAdmissionStats,
  openFplCriticalWindow,
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

    const activeLeases = await Promise.all(requests.slice(0, capacity));
    await Promise.all(activeLeases.map((lease) => lease.release()));
    const queuedLeases = await Promise.all(requests.slice(capacity));
    await Promise.all(queuedLeases.map((lease) => lease.release()));

    expect(getFplAdmissionStats().inflight).toBe(0);
  });

  test('removes a queued request when its admission deadline expires', async () => {
    resetFplAdmissionForTests();
    const capacity = getFplAdmissionStats().bulkMaxInflight;
    const activeLeases = await Promise.all(
      Array.from({ length: capacity }, () => acquireFplRequest('bulk')),
    );

    await expect(acquireFplRequest('bulk', { deadlineAt: Date.now() + 20 })).rejects.toMatchObject({
      code: 'FPL_ADMISSION_DEADLINE_EXCEEDED',
    });
    expect(getFplAdmissionStats().queued).toBe(0);

    await Promise.all(activeLeases.map((lease) => lease.release()));
    expect(getFplAdmissionStats().inflight).toBe(0);
  });

  test('cancels a queued request without waiting for the deadline', async () => {
    resetFplAdmissionForTests();
    const activeLeases = await Promise.all(
      Array.from({ length: getFplAdmissionStats().bulkMaxInflight }, () =>
        acquireFplRequest('bulk'),
      ),
    );
    const controller = new AbortController();
    const blocked = acquireFplRequest('bulk', {
      deadlineAt: Date.now() + 1_000,
      signal: controller.signal,
    });
    expect(getFplAdmissionStats().queued).toBe(1);
    controller.abort();
    await expect(blocked).rejects.toMatchObject({ name: 'AbortError' });
    expect(getFplAdmissionStats().queued).toBe(0);
    await Promise.all(activeLeases.map((lease) => lease.release()));
  });

  test('critical window reserves one token and one slot for the watcher', async () => {
    resetFplAdmissionForTests();
    const owner = 'price-watch-test';
    await openFplCriticalWindow({ owner, untilMs: Date.now() + 2_000 });

    const liveLeases = await Promise.all(
      Array.from({ length: 3 }, () => acquireFplRequest('live')),
    );
    const reserved = getFplAdmissionStats();
    expect(reserved.inflight).toBe(3);
    // A few milliseconds of bucket refill can make this slightly greater than
    // one; the reservation is enforced by requiring two tokens for regular
    // traffic while the critical window is active.
    expect(reserved.tokens).toBeLessThan(2);

    await expect(acquireFplRequest('live', { deadlineAt: Date.now() + 20 })).rejects.toMatchObject({
      code: 'FPL_ADMISSION_DEADLINE_EXCEEDED',
    });

    const critical = await acquireFplRequest('deadline-critical', {
      deadlineAt: Date.now() + 200,
    });
    expect(getFplAdmissionStats()).toMatchObject({
      inflight: 4,
      criticalInflight: 1,
    });
    await critical.release();
    await Promise.all(liveLeases.map((lease) => lease.release()));
    await closeFplCriticalWindow(owner);
    expect(getFplAdmissionStats().inflight).toBe(0);
  });

  test('critical traffic can consume the reserved slot when regular traffic has four leases', async () => {
    resetFplAdmissionForTests();
    const owner = 'critical-slot-test';
    const liveLeases = await Promise.all(
      Array.from({ length: 4 }, () => acquireFplRequest('live')),
    );
    await openFplCriticalWindow({ owner, untilMs: Date.now() + 2_000 });
    await new Promise((resolve) => setTimeout(resolve, 260));

    const critical = await acquireFplRequest('deadline-critical', {
      deadlineAt: Date.now() + 200,
    });
    expect(getFplAdmissionStats()).toMatchObject({ inflight: 5, criticalInflight: 1 });
    await critical.release();
    await Promise.all(liveLeases.map((lease) => lease.release()));
    await closeFplCriticalWindow(owner);
  });

  test('release is idempotent and critical priority is visible in the policy', async () => {
    resetFplAdmissionForTests();
    const lease = await acquireFplRequest('deadline-critical');
    await lease.release();
    await lease.release();
    expect(getFplAdmissionStats().inflight).toBe(0);
    expect(ACQUIRE_SCRIPT).toContain('critical-priority');
    expect(ACQUIRE_SCRIPT).toContain('liveBurst');
  });
});
