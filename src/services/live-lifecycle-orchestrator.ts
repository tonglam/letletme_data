import type { Elysia } from 'elysia';

import { fplClient } from '../clients/fpl';
import type { Event } from '../domain/events';
import type { FplSeasonRef } from '../domain/fpl-season';
import { isCompleteEntryPicks } from '../domain/entry-picks';
import type { Fixture, RawFPLEntryEventPicksResponse } from '../types';
import { entryEventPicksRepository } from '../repositories/entry-event-picks';
import { eventRepository } from '../repositories/events';
import { fixtureRepository } from '../repositories/fixtures';
import { seasonRepository } from '../repositories/seasons';
import { tournamentEntryRepository } from '../repositories/tournament-entries';
import { tournamentInfoRepository } from '../repositories/tournament-infos';
import { mapWithConcurrency, uniqueNumbers } from '../utils/async';
import { isMatchDayTime } from '../utils/conditions';
import { logError, logInfo } from '../utils/logger';
import { persistEntryEventPicksResponse } from './entries.service';
import { enqueueEntryPicksSyncJob } from '../jobs/entry-sync-enqueue';
import { enqueueLiveActiveSnapshot, enqueueLiveSnapshot } from '../jobs/live-data.jobs';
import { enqueueTournamentOfficialH2H } from '../jobs/tournament-sync.jobs';
import { entryInfoRepository } from '../repositories/entry-infos';
import { readLiveSnapshotCache } from '../cache/live-snapshot-cache';
import {
  isCompatibilitySchedulerEnabled,
  isStandaloneSchedulerEnabled,
} from '../utils/scheduler-mode';
import { liveLifecycleStatusRepository } from '../repositories/live-window';

/** The live producer cadence is a data contract: one fresh poll every 30s. */
export const LIVE_POLL_MS = 30_000;
export const PICKS_FIRST_PROBE_OFFSET_MS = Number(
  process.env.PICKS_FIRST_PROBE_OFFSET_MS ?? 60 * 60_000,
);
export const PICKS_RETRY_SCHEDULE_MS = (
  process.env.PICKS_RETRY_SCHEDULE_MS ?? '120000,180000,300000,600000'
)
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0);
export const FPL_BULK_MAX_INFLIGHT_DURING_LIVE = Number(
  process.env.FPL_BULK_MAX_INFLIGHT_DURING_LIVE ?? 3,
);
const BETWEEN_FIXTURES_POLL_MS = Number(process.env.BETWEEN_FIXTURES_POLL_MS ?? 5 * 60_000);
const DAY_SETTLING_INITIAL_POLL_MS = Number(process.env.DAY_SETTLING_INITIAL_POLL_MS ?? 60_000);
const DAY_SETTLING_STABLE_POLL_MS = Number(process.env.DAY_SETTLING_STABLE_POLL_MS ?? 5 * 60_000);
const DAY_SETTLING_STABLE_AFTER_MS = Number(
  process.env.DAY_SETTLING_STABLE_AFTER_MS ?? 10 * 60_000,
);
const PICKS_PROBE_POLL_MS = Number(process.env.PICKS_PROBE_POLL_MS ?? 120_000);
const PRE_DEADLINE_POLL_MS = Number(process.env.PRE_DEADLINE_POLL_MS ?? 5 * 60_000);
const GW_REVIEW_POLL_MS = Number(process.env.GW_REVIEW_POLL_MS ?? 10 * 60_000);
const GW_REVIEW_FINALIZATION_POLL_MS = Number(
  process.env.GW_REVIEW_FINALIZATION_POLL_MS ?? 2 * 60_000,
);
const FINALIZED_POLL_MS = Number(process.env.FINALIZED_POLL_MS ?? 5 * 60_000);

export type LiveLifecycleState =
  | 'PRE_DEADLINE'
  | 'PICKS_WAIT'
  | 'PICKS_PROBE'
  | 'PICKS_SYNC'
  | 'LIVE_ACTIVE'
  | 'BETWEEN_FIXTURES'
  | 'DAY_SETTLING'
  | 'GW_REVIEW'
  | 'FINALIZED';

export type LiveLifecycleDecision = {
  state: LiveLifecycleState;
  shouldFetchLive: boolean;
  shouldProbePicks: boolean;
  shouldSyncPicks: boolean;
  recoverStaleFixtures: boolean;
  finalizeEvent: boolean;
  nextRetryAt: Date | null;
};

export type LiveLifecycleObservation = {
  /** The last content revision observed for this event, if any. */
  lastRevision?: number | null;
  /** When the current revision first became quiet. */
  unchangedSince?: number | null;
  /** Whether the current time is still inside an authoritative fixture window. */
  matchDayTime?: boolean;
  /** A valid live publication can lead core fixture lifecycle flags briefly. */
  publicationActive?: boolean;
  publicationStarted?: boolean;
};

type PicksProbeState = {
  attempts: number;
  nextProbeAt: number;
  canarySucceeded: boolean;
  failedCanaryEntryIds: Set<number>;
};

const picksProbeStates = new Map<string, PicksProbeState>();
const daySettlingStates = new Map<string, { revision: number | null; unchangedSince: number }>();
const picksFanoutClaims = new Map<string, Map<number, number>>();

const firstKickoff = (fixtures: readonly Fixture[]): number | null => {
  const values = fixtures
    .map((fixture) => fixture.kickoffTime?.getTime() ?? Number.NaN)
    .filter(Number.isFinite);
  return values.length > 0 ? Math.min(...values) : null;
};

const lastKickoff = (fixtures: readonly Fixture[]): number | null => {
  const values = fixtures
    .map((fixture) => fixture.kickoffTime?.getTime() ?? Number.NaN)
    .filter(Number.isFinite);
  return values.length > 0 ? Math.max(...values) : null;
};

export function decideLiveLifecycle(
  event: Pick<Event, 'deadlineTime' | 'finished' | 'dataChecked'>,
  fixtures: readonly Pick<
    Fixture,
    'started' | 'finished' | 'finishedProvisional' | 'kickoffTime'
  >[],
  now = new Date(),
  observation: LiveLifecycleObservation = {},
): LiveLifecycleDecision {
  const nowMs = now.getTime();
  const deadlineMs = event.deadlineTime ? new Date(event.deadlineTime).getTime() : Number.NaN;
  const firstKickoffMs = firstKickoff(fixtures as Fixture[]);
  const lastKickoffMs = lastKickoff(fixtures as Fixture[]);
  const allFinished =
    fixtures.length > 0 &&
    fixtures.every((fixture) => fixture.finished || fixture.finishedProvisional);
  const coreActive = fixtures.some(
    (fixture) => fixture.started && !fixture.finished && !fixture.finishedProvisional,
  );
  const activeEvidence = coreActive || observation.publicationActive === true;
  // FPL's finished flag can lag for hours.  It is useful as a short grace
  // period, but must not keep an old publication in LIVE_ACTIVE forever. The
  // orchestrator passes the same bounded match-window decision used by the
  // producer, while unit callers that do not provide it retain the historical
  // evidence-only behaviour.
  const active = activeEvidence && observation.matchDayTime !== false;
  const anyStarted =
    fixtures.some((fixture) => fixture.started) || observation.publicationStarted === true;
  const futureFixtures = fixtures.some(
    (fixture) =>
      !fixture.finished &&
      !fixture.finishedProvisional &&
      fixture.started !== true &&
      (fixture.kickoffTime?.getTime() ?? Number.POSITIVE_INFINITY) > nowMs,
  );

  if (event.finished && event.dataChecked && allFinished) {
    return {
      state: 'FINALIZED',
      shouldFetchLive: true,
      shouldProbePicks: false,
      shouldSyncPicks: false,
      recoverStaleFixtures: false,
      finalizeEvent: true,
      nextRetryAt: null,
    };
  }
  if (allFinished && lastKickoffMs !== null) {
    const afterLast = nowMs - lastKickoffMs;
    return {
      // Time since the last kickoff controls polling cadence only.  It must
      // not manufacture FINALIZED before the event is explicitly marked
      // finished and data-checked.
      state: 'GW_REVIEW',
      shouldFetchLive: afterLast < 24 * 60 * 60_000,
      shouldProbePicks: false,
      shouldSyncPicks: false,
      recoverStaleFixtures: false,
      finalizeEvent: false,
      nextRetryAt: null,
    };
  }
  if (active) {
    return {
      state: 'LIVE_ACTIVE',
      shouldFetchLive: true,
      shouldProbePicks: false,
      shouldSyncPicks: true,
      recoverStaleFixtures: false,
      finalizeEvent: false,
      nextRetryAt: null,
    };
  }
  if (anyStarted) {
    const quietFor = observation.unchangedSince ? nowMs - observation.unchangedSince : 0;
    if (futureFixtures && quietFor >= DAY_SETTLING_STABLE_AFTER_MS) {
      return {
        state: 'BETWEEN_FIXTURES',
        // Keep polling at the low cadence so a new official revision can be
        // observed, but do not sync picks or manufacture a publication for a
        // lifecycle-only transition.
        shouldFetchLive: true,
        shouldProbePicks: false,
        shouldSyncPicks: false,
        recoverStaleFixtures: false,
        finalizeEvent: false,
        nextRetryAt: null,
      };
    }
    return {
      state: 'DAY_SETTLING',
      shouldFetchLive: true,
      shouldProbePicks: false,
      shouldSyncPicks: true,
      recoverStaleFixtures: false,
      finalizeEvent: false,
      nextRetryAt: null,
    };
  }
  if (Number.isFinite(deadlineMs) && nowMs < deadlineMs) {
    return {
      state: 'PRE_DEADLINE',
      shouldFetchLive: false,
      shouldProbePicks: false,
      shouldSyncPicks: false,
      recoverStaleFixtures: false,
      finalizeEvent: false,
      nextRetryAt: null,
    };
  }
  if (Number.isFinite(deadlineMs) && nowMs < deadlineMs + PICKS_FIRST_PROBE_OFFSET_MS) {
    return {
      state: 'PICKS_WAIT',
      shouldFetchLive: false,
      shouldProbePicks: false,
      shouldSyncPicks: false,
      recoverStaleFixtures: false,
      finalizeEvent: false,
      nextRetryAt: new Date(deadlineMs + PICKS_FIRST_PROBE_OFFSET_MS),
    };
  }
  if (firstKickoffMs !== null && nowMs < firstKickoffMs) {
    return {
      state: 'PICKS_PROBE',
      shouldFetchLive: false,
      shouldProbePicks: true,
      shouldSyncPicks: false,
      recoverStaleFixtures: false,
      finalizeEvent: false,
      nextRetryAt: null,
    };
  }
  if (firstKickoffMs !== null && nowMs >= firstKickoffMs) {
    return {
      // A scheduled kickoff is not proof that the fixture has started. Keep
      // the lifecycle state in its picks/sync lane until the core fixture
      // says started=true (or an authoritative publication proves it). Keep
      // a bounded live probe running so this worker can discover that change;
      // the fetch itself must not be treated as start evidence.
      state: 'PICKS_SYNC',
      shouldFetchLive: true,
      shouldProbePicks: true,
      shouldSyncPicks: true,
      recoverStaleFixtures: false,
      finalizeEvent: false,
      nextRetryAt: null,
    };
  }
  return {
    state: 'PICKS_SYNC',
    shouldFetchLive: false,
    shouldProbePicks: true,
    shouldSyncPicks: true,
    recoverStaleFixtures: false,
    finalizeEvent: false,
    nextRetryAt: null,
  };
}

export async function resolveUniqueActiveTournamentEntryIds(
  season: FplSeasonRef,
  eventId: number,
): Promise<number[]> {
  const [tournaments, knownEntries] = await Promise.all([
    tournamentInfoRepository.findActive(season),
    entryInfoRepository.findAll(season),
  ]);
  const entryLists = await mapWithConcurrency(tournaments, 10, (tournament) =>
    tournamentEntryRepository.findEntryIdsByTournamentId(season, tournament.id),
  );
  return uniqueNumbers([
    ...entryLists.flat(),
    ...knownEntries
      .filter((entry) => entry.startedEvent === null || entry.startedEvent <= eventId)
      .map((entry) => entry.id),
  ]).filter((entryId) => entryId > 0);
}

function isStablePicksResponse(payload: RawFPLEntryEventPicksResponse, eventId: number): boolean {
  return payload.entry_history.event === eventId && isCompleteEntryPicks(payload.picks);
}

export async function runPicksProbeAndSync(
  season: FplSeasonRef,
  eventId: number,
  now = new Date(),
): Promise<{ canaryCount: number; synced: number; pending: number }> {
  const key = `${season.seasonCode}:${eventId}`;
  const state = picksProbeStates.get(key) ?? {
    attempts: 0,
    nextProbeAt: 0,
    canarySucceeded: false,
    failedCanaryEntryIds: new Set<number>(),
  };
  if (now.getTime() < state.nextProbeAt) return { canaryCount: 0, synced: 0, pending: 0 };
  const entryIds = await resolveUniqueActiveTournamentEntryIds(season, eventId);
  if (entryIds.length === 0) return { canaryCount: 0, synced: 0, pending: 0 };
  const persisted = new Set(
    await entryEventPicksRepository.findEntryIdsByEvent(season, eventId, entryIds),
  );
  const fanoutClaims = picksFanoutClaims.get(key) ?? new Map<number, number>();
  const nowMs = now.getTime();
  for (const entryId of persisted) fanoutClaims.delete(entryId);
  const pending = entryIds.filter(
    (entryId) =>
      !persisted.has(entryId) &&
      (!fanoutClaims.has(entryId) || nowMs - (fanoutClaims.get(entryId) ?? 0) >= 10 * 60_000),
  );
  if (pending.length === 0) return { canaryCount: 0, synced: 0, pending: 0 };

  let canaries = state.canarySucceeded
    ? []
    : pending.filter((entryId) => !state.failedCanaryEntryIds.has(entryId)).slice(0, 2);
  if (!state.canarySucceeded && canaries.length === 0) {
    state.failedCanaryEntryIds.clear();
    canaries = pending.slice(0, 2);
  }
  const canaryResults = await Promise.allSettled(
    canaries.map(async (entryId) => {
      const payload = await fplClient.getEntryEventPicks(entryId, eventId);
      if (!isStablePicksResponse(payload, eventId)) {
        throw new Error(`Entry ${entryId} picks are not a complete event ${eventId} payload`);
      }
      await persistEntryEventPicksResponse(season, entryId, eventId, payload);
      return entryId;
    }),
  );
  const canaryCount = canaryResults.filter((result) => result.status === 'fulfilled').length;
  canaryResults.forEach((result, index) => {
    const entryId = canaries[index];
    if (entryId === undefined) return;
    if (result.status === 'fulfilled') state.failedCanaryEntryIds.delete(entryId);
    else state.failedCanaryEntryIds.add(entryId);
  });
  if (!state.canarySucceeded && canaryCount === 0) {
    state.attempts += 1;
    const delay =
      PICKS_RETRY_SCHEDULE_MS[Math.min(state.attempts - 1, PICKS_RETRY_SCHEDULE_MS.length - 1)] ??
      600_000;
    state.nextProbeAt = now.getTime() + delay;
    picksProbeStates.set(key, state);
    logInfo('Live picks canary is not ready; fan-out remains paused', {
      eventId,
      canaries: canaries.length,
    });
    return { canaryCount, synced: 0, pending: pending.length };
  }

  state.canarySucceeded = true;
  const remaining = pending.filter((entryId) => !canaries.includes(entryId));
  if (remaining.length > 0) {
    await enqueueEntryPicksSyncJob(season, 'cron', {
      eventId,
      entryIds: remaining,
      concurrency: Math.max(1, Math.min(FPL_BULK_MAX_INFLIGHT_DURING_LIVE, 3)),
      throttleMs: 0,
      queueKey: `live-picks-${eventId}`,
    });
    for (const entryId of remaining) fanoutClaims.set(entryId, nowMs);
  }
  picksFanoutClaims.set(key, fanoutClaims);
  state.attempts += 1;
  state.nextProbeAt = now.getTime() + (PICKS_RETRY_SCHEDULE_MS[0] ?? 120_000);
  picksProbeStates.set(key, state);
  logInfo('Live picks sync accepted after canary', {
    eventId,
    canaryCount,
    totalUniqueEntries: entryIds.length,
    queued: remaining.length,
  });
  return { canaryCount, synced: canaryCount, pending: remaining.length };
}

export async function runLiveLifecycle(now = new Date()): Promise<LiveLifecycleDecision | null> {
  const season = await seasonRepository.findCurrent();
  const currentEvent = await (await import('./events.service')).getCurrentEvent(season);
  if (!currentEvent) return null;
  const fixtures = await fixtureRepository.findByEvent(season, currentEvent.id);
  const key = `${season.seasonCode}:${currentEvent.id}`;
  const cache = await readLiveSnapshotCache(season.seasonCode, currentEvent.id).catch(() => null);
  const revision = cache?.manifest.revision ?? null;
  const persisted = await liveLifecycleStatusRepository
    .findByEventId(season, currentEvent.id)
    .catch(() => null);
  const publishedAtMs = cache?.manifest.publishedAt
    ? new Date(cache.manifest.publishedAt).getTime()
    : Number.NaN;
  const persistedSourceCheckedAtMs = persisted?.sourceCheckedAt?.getTime() ?? Number.NaN;
  const initialUnchangedSince = Number.isFinite(publishedAtMs)
    ? Math.min(now.getTime(), publishedAtMs)
    : Number.isFinite(persistedSourceCheckedAtMs)
      ? Math.min(now.getTime(), persistedSourceCheckedAtMs)
      : now.getTime();
  const previous = daySettlingStates.get(key);
  if (!previous || previous.revision !== revision) {
    daySettlingStates.set(key, { revision, unchangedSince: initialUnchangedSince });
  }
  const observation = daySettlingStates.get(key);
  const decision = decideLiveLifecycle(currentEvent, fixtures, now, {
    lastRevision: revision,
    unchangedSince: observation?.unchangedSince ?? null,
    matchDayTime: isMatchDayTime(currentEvent, fixtures, now),
    publicationStarted: cache?.fixtures.some((fixture) => fixture.started === true),
    publicationActive: cache?.fixtures.some(
      (fixture) => fixture.started === true && !fixture.finished && !fixture.finishedProvisional,
    ),
  });

  // DAY_SETTLING and BETWEEN_FIXTURES share the same quiet-revision clock.
  // Other states do not need it and can start a fresh clock on the next match
  // day.
  if (decision.state !== 'DAY_SETTLING' && decision.state !== 'BETWEEN_FIXTURES') {
    daySettlingStates.delete(`${season.seasonCode}:${currentEvent.id}`);
  }

  const nextRefreshDelay = lifecycleDelay(decision, season, currentEvent.id, now);
  await liveLifecycleStatusRepository
    .upsert(season, {
      eventId: currentEvent.id,
      state: decision.state,
      observedAt: now,
      lastChangedAt: persisted?.state === decision.state ? persisted.lastChangedAt : now,
      nextRefreshAt: nextRefreshDelay === null ? null : new Date(now.getTime() + nextRefreshDelay),
      liveRevision: revision === null ? null : String(revision),
      publicationId: cache?.manifest.publicationId ?? null,
      sourceCheckedAt: cache?.manifest.sourceCheckedAt
        ? new Date(cache.manifest.sourceCheckedAt)
        : null,
    })
    .catch((error) => {
      logError('Failed to persist live lifecycle status', error, {
        eventId: currentEvent.id,
        state: decision.state,
      });
    });

  if (decision.shouldProbePicks || decision.shouldSyncPicks) {
    await runPicksProbeAndSync(season, currentEvent.id, now).catch((error) => {
      logError('Live picks probe/sync failed', error, {
        eventId: currentEvent.id,
        state: decision.state,
      });
    });
  }
  if (decision.shouldFetchLive) {
    const shouldEnqueueFinalization = decision.finalizeEvent
      ? (await eventRepository.findLiveSnapshotFinalizedAt(season, currentEvent.id)) === null
      : false;
    if (!decision.finalizeEvent || shouldEnqueueFinalization) {
      const persistContinuously =
        decision.state === 'DAY_SETTLING' ||
        decision.state === 'GW_REVIEW' ||
        decision.recoverStaleFixtures ||
        decision.finalizeEvent;
      if (decision.state === 'LIVE_ACTIVE' && !persistContinuously) {
        await enqueueLiveActiveSnapshot(season, currentEvent.id, now);
      } else {
        await enqueueLiveSnapshot(season, currentEvent.id, 'cron', {
          persistEventLives: persistContinuously,
          finalizeEvent: decision.finalizeEvent,
          now,
        });
      }
    }
    if (isMatchDayTime(currentEvent, fixtures, now)) {
      await enqueueTournamentOfficialH2H(season, currentEvent.id, 'cron', {
        jobId: `official-h2h-e${currentEvent.id}-${now.toISOString().slice(0, 16).replace(/\D/g, '')}`,
      }).catch((error) => {
        logError('Failed to enqueue live official H2H sync', error, {
          eventId: currentEvent.id,
        });
      });
    }
  }
  logInfo('Live lifecycle tick completed', {
    eventId: currentEvent.id,
    state: decision.state,
    shouldFetchLive: decision.shouldFetchLive,
  });
  return decision;
}

function isUkFinalizationWindow(now: Date): boolean {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? 0);
  const totalMinutes = hour * 60 + minute;
  return totalMinutes >= 8 * 60 + 50 && totalMinutes <= 9 * 60 + 15;
}

function lifecycleDelay(
  decision: LiveLifecycleDecision,
  season: FplSeasonRef,
  eventId: number,
  now: Date,
): number | null {
  if (decision.state === 'FINALIZED') return FINALIZED_POLL_MS;
  if (decision.nextRetryAt && decision.nextRetryAt.getTime() > now.getTime()) {
    return Math.max(1_000, decision.nextRetryAt.getTime() - now.getTime());
  }
  switch (decision.state) {
    case 'LIVE_ACTIVE':
      return LIVE_POLL_MS;
    case 'BETWEEN_FIXTURES':
      return BETWEEN_FIXTURES_POLL_MS;
    case 'DAY_SETTLING': {
      const stable = daySettlingStates.get(`${season.seasonCode}:${eventId}`);
      return stable && now.getTime() - stable.unchangedSince >= DAY_SETTLING_STABLE_AFTER_MS
        ? DAY_SETTLING_STABLE_POLL_MS
        : DAY_SETTLING_INITIAL_POLL_MS;
    }
    case 'GW_REVIEW':
      return isUkFinalizationWindow(now) ? GW_REVIEW_FINALIZATION_POLL_MS : GW_REVIEW_POLL_MS;
    case 'PICKS_PROBE':
    case 'PICKS_SYNC':
      return PICKS_PROBE_POLL_MS;
    case 'PRE_DEADLINE':
      return PRE_DEADLINE_POLL_MS;
    case 'PICKS_WAIT':
      return PICKS_PROBE_POLL_MS;
    default:
      return LIVE_POLL_MS;
  }
}

async function runLifecycleTick(now: Date): Promise<LiveLifecycleDecision | null> {
  if (isCompatibilitySchedulerEnabled()) {
    const { runCompatibilitySchedulerPass } = await import('../scheduler/scheduler.service');
    await runCompatibilitySchedulerPass(now);
    return null;
  }
  return runLiveLifecycle(now);
}

export function registerLiveLifecycleTimer(app: Elysia) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const schedule = (delay: number | null) => {
    if (stopped || delay === null) return;
    timer = setTimeout(
      async () => {
        const now = new Date();
        const decision = await runLifecycleTick(now).catch((error) => {
          logError('Live lifecycle tick failed', error);
          return null;
        });
        if (!stopped) {
          const season = await seasonRepository.findCurrent().catch(() => null);
          const currentEvent = season
            ? await (await import('./events.service')).getCurrentEvent(season).catch(() => null)
            : null;
          schedule(
            decision && season
              ? lifecycleDelay(decision, season, currentEvent?.id ?? 0, now)
              : LIVE_POLL_MS,
          );
        }
      },
      Math.max(1_000, delay),
    );
  };
  return app
    .onStart(() => {
      if (isStandaloneSchedulerEnabled()) return;
      stopped = false;
      void (async () => {
        const now = new Date();
        const decision = await runLifecycleTick(now).catch((error) => {
          logError('Live lifecycle tick failed', error);
          return null;
        });
        if (!stopped) {
          const season = await seasonRepository.findCurrent().catch(() => null);
          const currentEvent = season
            ? await (await import('./events.service')).getCurrentEvent(season).catch(() => null)
            : null;
          schedule(
            decision && season
              ? lifecycleDelay(decision, season, currentEvent?.id ?? 0, now)
              : LIVE_POLL_MS,
          );
        }
      })();
    })
    .onStop(() => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    });
}
