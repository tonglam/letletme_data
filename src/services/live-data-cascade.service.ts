import type { Event } from '../domain/events';
import type { Fixture } from '../types';
import { logError, logInfo } from '../utils/logger';

export type LiveCascadeEnqueueFn = (
  eventId: number,
  source?: 'cron' | 'manual' | 'cascade',
) => Promise<unknown>;

export type CascadeEnqueueDeps = {
  isLiveMatchWindowForEvent: (eventId: number) => Promise<boolean>;
  enqueueEventLiveSummary: LiveCascadeEnqueueFn;
  enqueueEventLiveExplain: LiveCascadeEnqueueFn;
  enqueueLiveFixtureCache: LiveCascadeEnqueueFn;
  enqueueLiveBonusCache: LiveCascadeEnqueueFn;
  enqueueEventOverallResult: LiveCascadeEnqueueFn;
};

export type MatchWindowDeps = {
  getCurrentEvent: () => Promise<Event | null>;
  findFixturesByEvent: (eventId: number) => Promise<Fixture[]>;
  isMatchDayTime: (currentEvent: Event, fixtures: Fixture[], now: Date) => boolean;
};

/**
 * Enqueue cascade jobs after event-lives DB sync completes.
 * These jobs depend on fresh event_lives data.
 *
 * Defaults are loaded lazily so unit tests can inject deps without importing
 * BullMQ queue modules (which require DATABASE_URL at module load).
 */
export async function enqueueCascadeJobs(
  eventId: number,
  deps?: CascadeEnqueueDeps,
): Promise<{
  eventId: number;
  matchWindowOpen: boolean;
  total: number;
  successful: number;
  failed: number;
  jobNames: readonly string[];
}> {
  const resolved = deps ?? (await loadDefaultCascadeDeps());

  logInfo('Enqueueing cascade jobs after DB sync', { eventId });

  try {
    const matchWindowOpen = await resolved.isLiveMatchWindowForEvent(eventId);
    const enqueueTasks = [
      resolved.enqueueEventLiveSummary(eventId, 'cascade'),
      resolved.enqueueEventLiveExplain(eventId, 'cascade'),
      ...(matchWindowOpen
        ? [
            resolved.enqueueLiveFixtureCache(eventId, 'cascade'),
            resolved.enqueueLiveBonusCache(eventId, 'cascade'),
          ]
        : []),
      resolved.enqueueEventOverallResult(eventId, 'cascade'),
    ];

    if (!matchWindowOpen) {
      logInfo('Skipping live fixture/bonus cascade enqueue - not match time', { eventId });
    }

    const results = await Promise.allSettled(enqueueTasks);

    const successful = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.filter((r) => r.status === 'rejected').length;

    logInfo('Cascade jobs enqueued', {
      eventId,
      total: results.length,
      successful,
      failed,
    });

    const jobNames = matchWindowOpen
      ? (['summary', 'explain', 'live-fixture', 'live-bonus', 'overall'] as const)
      : (['summary', 'explain', 'overall'] as const);

    if (failed > 0) {
      const failures = results
        .map((result, index) => ({ result, jobName: jobNames[index] }))
        .filter(({ result }) => result.status === 'rejected')
        .map(({ result, jobName }) => ({
          jobName,
          reason: result.status === 'rejected' ? result.reason : null,
        }));
      failures.forEach(({ jobName, reason }) => {
        logError('Failed to enqueue cascade job', reason, {
          eventId,
          jobName,
        });
      });
      throw new Error(`Live-data cascade enqueue failed for ${failed} job(s) (eventId=${eventId})`);
    }

    return {
      eventId,
      matchWindowOpen,
      total: results.length,
      successful,
      failed,
      jobNames: matchWindowOpen
        ? ([
            'event-live-summary',
            'event-live-explain',
            'live-fixture-cache',
            'live-bonus-cache',
            'event-overall-result',
          ] as const)
        : (['event-live-summary', 'event-live-explain', 'event-overall-result'] as const),
    };
  } catch (error) {
    logError('Failed to enqueue cascade jobs', error, { eventId });
    throw error;
  }
}

export async function isLiveMatchWindowForEvent(
  eventId: number,
  deps?: MatchWindowDeps,
): Promise<boolean> {
  const resolved = deps ?? (await loadDefaultMatchWindowDeps());
  const currentEvent = await resolved.getCurrentEvent();
  if (!currentEvent) {
    return false;
  }
  if (currentEvent.id !== eventId) {
    return false;
  }
  const fixtures = await resolved.findFixturesByEvent(eventId);
  return resolved.isMatchDayTime(currentEvent, fixtures, new Date());
}

async function loadDefaultMatchWindowDeps() {
  const [{ getCurrentEvent }, { isMatchDayTime }, { fixtureRepository }] = await Promise.all([
    import('./events.service'),
    import('../utils/conditions'),
    import('../repositories/fixtures'),
  ]);

  return {
    getCurrentEvent,
    findFixturesByEvent: (id: number) => fixtureRepository.findByEvent(id),
    isMatchDayTime,
  };
}

async function loadDefaultCascadeDeps(): Promise<CascadeEnqueueDeps> {
  const jobs = await import('../jobs/live-data.jobs');
  return {
    isLiveMatchWindowForEvent,
    enqueueEventLiveSummary: jobs.enqueueEventLiveSummary,
    enqueueEventLiveExplain: jobs.enqueueEventLiveExplain,
    enqueueLiveFixtureCache: jobs.enqueueLiveFixtureCache,
    enqueueLiveBonusCache: jobs.enqueueLiveBonusCache,
    enqueueEventOverallResult: jobs.enqueueEventOverallResult,
  };
}
