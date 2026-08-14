import type { Elysia } from 'elysia';

import { fplClient } from '../clients/fpl';
import type { Event } from '../domain/events';
import type { FplSeasonRef } from '../domain/fpl-season';
import { isCompleteEntryPicks } from '../domain/entry-picks';
import type { Fixture, RawFPLEntryEventPicksResponse } from '../types';
import { entryEventPicksRepository } from '../repositories/entry-event-picks';
import { fixtureRepository } from '../repositories/fixtures';
import { seasonRepository } from '../repositories/seasons';
import { tournamentEntryRepository } from '../repositories/tournament-entries';
import { tournamentInfoRepository } from '../repositories/tournament-infos';
import { mapWithConcurrency, uniqueNumbers } from '../utils/async';
import { logError, logInfo } from '../utils/logger';
import { persistEntryEventPicksResponse } from './entries.service';
import { enqueueEntryPicksSyncJob } from '../jobs/entry-sync-enqueue';
import { enqueueLiveSnapshot } from '../jobs/live-data.jobs';
import { readLiveSnapshotCache } from '../cache/live-snapshot-cache';

export const LIVE_POLL_MS = Number(process.env.LIVE_POLL_MS ?? 30_000);
export const PICKS_FIRST_PROBE_OFFSET_MS = Number(
  process.env.PICKS_FIRST_PROBE_OFFSET_MS ?? 90 * 60_000,
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
  nextRetryAt: Date | null;
};

type PicksProbeState = {
  attempts: number;
  nextProbeAt: number;
  canarySucceeded: boolean;
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
): LiveLifecycleDecision {
  const nowMs = now.getTime();
  const deadlineMs = event.deadlineTime ? new Date(event.deadlineTime).getTime() : Number.NaN;
  const firstKickoffMs = firstKickoff(fixtures as Fixture[]);
  const lastKickoffMs = lastKickoff(fixtures as Fixture[]);
  const allFinished =
    fixtures.length > 0 &&
    fixtures.every((fixture) => fixture.finished || fixture.finishedProvisional);
  const active = fixtures.some(
    (fixture) => fixture.started && !fixture.finished && !fixture.finishedProvisional,
  );
  const anyStarted = fixtures.some((fixture) => fixture.started);

  if (event.finished && event.dataChecked && allFinished) {
    return {
      state: 'FINALIZED',
      shouldFetchLive: false,
      shouldProbePicks: false,
      shouldSyncPicks: false,
      nextRetryAt: null,
    };
  }
  if (allFinished && lastKickoffMs !== null) {
    const afterLast = nowMs - lastKickoffMs;
    return {
      state: afterLast < 24 * 60 * 60_000 ? 'GW_REVIEW' : 'FINALIZED',
      shouldFetchLive: afterLast < 24 * 60 * 60_000,
      shouldProbePicks: false,
      shouldSyncPicks: false,
      nextRetryAt: null,
    };
  }
  if (active) {
    return {
      state: 'LIVE_ACTIVE',
      shouldFetchLive: true,
      shouldProbePicks: false,
      shouldSyncPicks: true,
      nextRetryAt: null,
    };
  }
  if (anyStarted) {
    return {
      state: 'DAY_SETTLING',
      shouldFetchLive: true,
      shouldProbePicks: false,
      shouldSyncPicks: true,
      nextRetryAt: null,
    };
  }
  if (Number.isFinite(deadlineMs) && nowMs < deadlineMs) {
    return {
      state: 'PRE_DEADLINE',
      shouldFetchLive: false,
      shouldProbePicks: false,
      shouldSyncPicks: false,
      nextRetryAt: null,
    };
  }
  if (Number.isFinite(deadlineMs) && nowMs < deadlineMs + PICKS_FIRST_PROBE_OFFSET_MS) {
    return {
      state: 'PICKS_WAIT',
      shouldFetchLive: false,
      shouldProbePicks: false,
      shouldSyncPicks: false,
      nextRetryAt: new Date(deadlineMs + PICKS_FIRST_PROBE_OFFSET_MS),
    };
  }
  if (firstKickoffMs !== null && nowMs < firstKickoffMs) {
    return {
      state: 'PICKS_PROBE',
      shouldFetchLive: false,
      shouldProbePicks: true,
      shouldSyncPicks: false,
      nextRetryAt: null,
    };
  }
  return {
    state: 'PICKS_SYNC',
    shouldFetchLive: false,
    shouldProbePicks: true,
    shouldSyncPicks: true,
    nextRetryAt: null,
  };
}

export async function resolveUniqueActiveTournamentEntryIds(
  season: FplSeasonRef,
): Promise<number[]> {
  const tournaments = await tournamentInfoRepository.findActive(season);
  const entryLists = await mapWithConcurrency(tournaments, 10, (tournament) =>
    tournamentEntryRepository.findEntryIdsByTournamentId(season, tournament.id),
  );
  return uniqueNumbers(entryLists.flat()).filter((entryId) => entryId > 0);
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
  };
  if (now.getTime() < state.nextProbeAt) return { canaryCount: 0, synced: 0, pending: 0 };
  const entryIds = await resolveUniqueActiveTournamentEntryIds(season);
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

  const canaries = state.canarySucceeded ? [] : pending.slice(0, 2);
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
  const decision = decideLiveLifecycle(currentEvent, fixtures, now);

  // DAY_SETTLING remains frequent for the first ten quiet minutes, then the
  // orchestrator can back off without changing the publication contract.
  if (decision.state === 'DAY_SETTLING') {
    const cache = await readLiveSnapshotCache(season.seasonCode, currentEvent.id).catch(() => null);
    const revision = cache?.manifest.revision ?? null;
    const key = `${season.seasonCode}:${currentEvent.id}`;
    const previous = daySettlingStates.get(key);
    if (!previous || previous.revision !== revision) {
      daySettlingStates.set(key, { revision, unchangedSince: now.getTime() });
    }
  } else {
    daySettlingStates.delete(`${season.seasonCode}:${currentEvent.id}`);
  }

  if (decision.shouldProbePicks || decision.shouldSyncPicks) {
    await runPicksProbeAndSync(season, currentEvent.id, now).catch((error) => {
      logError('Live picks probe/sync failed', error, {
        eventId: currentEvent.id,
        state: decision.state,
      });
    });
  }
  if (decision.shouldFetchLive) {
    await enqueueLiveSnapshot(season, currentEvent.id, 'cron', {
      persistEventLives: decision.state === 'DAY_SETTLING' || decision.state === 'GW_REVIEW',
      now,
    });
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
  if (decision.state === 'FINALIZED') return null;
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

export function registerLiveLifecycleTimer(app: Elysia) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const schedule = (delay: number | null) => {
    if (stopped || delay === null) return;
    timer = setTimeout(
      async () => {
        const now = new Date();
        const decision = await runLiveLifecycle(now).catch((error) => {
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
      stopped = false;
      void (async () => {
        const now = new Date();
        const decision = await runLiveLifecycle(now).catch((error) => {
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
