import type { Event } from '../domain/events';
import type { FplSeasonRef } from '../domain/fpl-season';
import type { Fixture } from '../types';
import { hasCompletePostMatchFinalization } from '../domain/post-match-results';
import { logInfo } from '../utils/logger';

export type MatchWindowDeps = {
  getCurrentEvent: (season: FplSeasonRef) => Promise<Event | null>;
  findFixturesByEvent: (season: FplSeasonRef, eventId: number) => Promise<Fixture[]>;
  isMatchDayTime: (currentEvent: Event, fixtures: Fixture[], now: Date) => boolean;
};

export type FinalLeagueResultsDeps = {
  getCurrentEvent: (season: FplSeasonRef) => Promise<Event | null>;
  findFixturesByEvent: (season: FplSeasonRef, eventId: number) => Promise<Fixture[]>;
  getPostMatchResultsSlot: (
    event: Pick<Event, 'dataChecked'>,
    fixtures: readonly Fixture[],
    date: Date,
  ) => string | null;
  enqueueLeagueEventResults: (
    season: FplSeasonRef,
    eventId: number,
    source: 'cascade',
    options: { jobId: string },
  ) => Promise<unknown>;
};

export async function isLiveMatchWindowForEvent(
  season: FplSeasonRef,
  eventId: number,
  deps?: MatchWindowDeps,
): Promise<boolean> {
  const resolved = deps ?? (await loadDefaultMatchWindowDeps());
  const currentEvent = await resolved.getCurrentEvent(season);
  if (!currentEvent || currentEvent.id !== eventId) return false;
  const fixtures = await resolved.findFixturesByEvent(season, eventId);
  return resolved.isMatchDayTime(currentEvent, fixtures, new Date());
}

export async function enqueueFinalLeagueResultsAfterLiveSync(
  season: FplSeasonRef,
  eventId: number,
  deps?: FinalLeagueResultsDeps,
): Promise<unknown | null> {
  const resolved = deps ?? (await loadDefaultFinalLeagueResultsDeps());
  const currentEvent = await resolved.getCurrentEvent(season);
  if (
    !currentEvent ||
    currentEvent.id !== eventId ||
    !hasCompletePostMatchFinalization(currentEvent)
  ) {
    return null;
  }

  const fixtures = await resolved.findFixturesByEvent(season, eventId);
  const resultSlot = resolved.getPostMatchResultsSlot(currentEvent, fixtures, new Date());
  if (!resultSlot?.startsWith('final-')) return null;

  const job = await resolved.enqueueLeagueEventResults(season, eventId, 'cascade', {
    jobId: `league-event-results-e${eventId}-coordinator-live-${resultSlot}`,
  });
  logInfo('Final league event results enqueued after durable live consolidation', {
    season: season.seasonCode,
    eventId,
    resultSlot,
  });
  return job;
}

async function loadDefaultMatchWindowDeps(): Promise<MatchWindowDeps> {
  const [{ getCurrentEvent }, { isMatchDayTime }, { fixtureRepository }] = await Promise.all([
    import('./events.service'),
    import('../utils/conditions'),
    import('../repositories/fixtures'),
  ]);
  return {
    getCurrentEvent,
    findFixturesByEvent: (season, eventId) => fixtureRepository.findByEvent(season, eventId),
    isMatchDayTime,
  };
}

async function loadDefaultFinalLeagueResultsDeps(): Promise<FinalLeagueResultsDeps> {
  const [eventsService, fixturesRepository, postMatchResults, leagueJobs] = await Promise.all([
    import('./events.service'),
    import('../repositories/fixtures'),
    import('../domain/post-match-results'),
    import('../jobs/league-sync.jobs'),
  ]);
  return {
    getCurrentEvent: eventsService.getCurrentEvent,
    findFixturesByEvent: (season, eventId) =>
      fixturesRepository.fixtureRepository.findByEvent(season, eventId),
    getPostMatchResultsSlot: postMatchResults.getPostMatchResultsSlot,
    enqueueLeagueEventResults: leagueJobs.enqueueLeagueEventResults,
  };
}
