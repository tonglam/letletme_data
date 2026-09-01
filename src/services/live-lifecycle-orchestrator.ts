import type { Elysia } from 'elysia';

import { fplClient } from '../clients/fpl';
import type { Event } from '../domain/events';
import { findEventEligibleEntryIds } from '../domain/entry-infos';
import type { FplSeasonRef } from '../domain/fpl-season';
import { isCompleteEntryPicks } from '../domain/entry-picks';
import type { Fixture, RawFPLEntryEventPicksResponse } from '../types';
import { eventRepository } from '../repositories/events';
import { fixtureRepository } from '../repositories/fixtures';
import { seasonRepository } from '../repositories/seasons';
import { tournamentEntryRepository } from '../repositories/tournament-entries';
import { tournamentInfoRepository } from '../repositories/tournament-infos';
import { mapWithConcurrency, uniqueNumbers } from '../utils/async';
import { isMatchDayTime } from '../utils/conditions';
import { logError, logInfo } from '../utils/logger';
import { checkpointEntryLiveInputV2, persistEntryEventPicksResponse } from './entries.service';
import { enqueueEntryPicksSyncJob } from '../jobs/entry-sync-enqueue';
import { enqueueLiveActiveSnapshot, enqueueLiveSnapshot } from '../jobs/live-data.jobs';
import { enqueueTournamentOfficialH2H } from '../jobs/tournament-sync.jobs';
import { entryInfoRepository } from '../repositories/entry-infos';
import {
  liveV2LifecycleKey,
  liveV2PicksCoordinatorKey,
  liveV2PicksCoverageKey,
  liveV2PicksPendingKey,
  readEntryCheckpointDesiredV2,
  readLivePublicationV2,
  readEntryLiveInputV2,
  setEntryCheckpointDesiredV2,
} from '../cache/live-publication-v2';
import { redisSingleton } from '../cache/singleton';
import { isStandaloneSchedulerEnabled } from '../utils/scheduler-mode';
import { liveLifecycleStatusRepository } from '../repositories/live-window';
import { getConfig } from '../utils/config';
import { normalizeMatchLifecycleState } from './live-match-v3';

const runtimeConfig = getConfig();
/** The live producer cadence is a data contract: one fresh poll every 30s by default. */
export const LIVE_POLL_MS = runtimeConfig.LIVE_POLL_MS;
export const PICKS_FIRST_PROBE_OFFSET_MS = runtimeConfig.PICKS_FIRST_PROBE_OFFSET_MS;
export const PICKS_RETRY_SCHEDULE_MS = runtimeConfig.PICKS_RETRY_SCHEDULE_MS.split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0);
export const FPL_BULK_MAX_INFLIGHT_DURING_LIVE = runtimeConfig.FPL_BULK_MAX_INFLIGHT_DURING_LIVE;
const BETWEEN_FIXTURES_POLL_MS = runtimeConfig.BETWEEN_FIXTURES_POLL_MS;
const DAY_SETTLING_INITIAL_POLL_MS = runtimeConfig.DAY_SETTLING_INITIAL_POLL_MS;
const DAY_SETTLING_STABLE_POLL_MS = runtimeConfig.DAY_SETTLING_STABLE_POLL_MS;
const DAY_SETTLING_STABLE_AFTER_MS = runtimeConfig.DAY_SETTLING_STABLE_AFTER_MS;
const PICKS_PROBE_POLL_MS = runtimeConfig.PICKS_PROBE_POLL_MS;
const PRE_DEADLINE_SLOW_POLL_MS = runtimeConfig.PRE_DEADLINE_SLOW_POLL_MS;
const PRE_DEADLINE_WARM_POLL_MS = runtimeConfig.PRE_DEADLINE_WARM_POLL_MS;
const PRE_DEADLINE_NEAR_POLL_MS = runtimeConfig.PRE_DEADLINE_NEAR_POLL_MS;
const GW_REVIEW_POLL_MS = runtimeConfig.GW_REVIEW_POLL_MS;
const GW_REVIEW_FINALIZATION_POLL_MS = runtimeConfig.GW_REVIEW_FINALIZATION_POLL_MS;
const FINALIZED_POLL_MS = runtimeConfig.FINALIZED_POLL_MS;

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
  /** Match desk/detail observation may run before Live Points is eligible. */
  shouldObserveMatches: boolean;
  shouldProbePicks: boolean;
  shouldSyncPicks: boolean;
  recoverStaleFixtures: boolean;
  finalizeEvent: boolean;
  nextRetryAt: Date | null;
  /** The next scheduled kickoff used to select pre-deadline cadence. */
  nextKickoffAt?: Date | null;
};

export type LiveLifecycleObservation = {
  /** The last content revision observed for this event, if any. */
  lastRevision?: number | string | null;
  /** When the current revision first became quiet. */
  unchangedSince?: number | null;
  /** Whether the current time is still inside an authoritative fixture window. */
  matchDayTime?: boolean;
  /** A valid live publication can lead core fixture lifecycle flags briefly. */
  publicationActive?: boolean;
  publicationStarted?: boolean;
};

export function shouldRefreshOfficialH2H(
  decision: LiveLifecycleDecision,
  matchDayTime: boolean,
): boolean {
  return (
    decision.shouldFetchLive &&
    decision.state !== 'FINALIZED' &&
    (matchDayTime || decision.state === 'GW_REVIEW')
  );
}

type PicksProbeState = {
  attempts: number;
  nextProbeAt: number;
  canarySucceeded: boolean;
  failedCanaryEntryIds: Set<number>;
};

const COORDINATOR_STATE_TTL_SECONDS = 7 * 24 * 60 * 60;
const PICKS_COVERAGE_TTL_SECONDS = 7 * 24 * 60 * 60;

type SharedPicksCoordinatorState = {
  attempts: number;
  nextProbeAt: number;
  canarySucceeded: boolean;
  failedCanaryEntryIds: number[];
};

type SharedLifecycleQuietState = {
  revision: number | string | null;
  unchangedSince: number;
  state?: LiveLifecycleState;
  expectedNextCheckAt?: string | null;
};

const defaultPicksCoordinatorState = (): SharedPicksCoordinatorState => ({
  attempts: 0,
  nextProbeAt: 0,
  canarySucceeded: false,
  failedCanaryEntryIds: [],
});

async function readPicksCoordinatorState(
  seasonCode: string,
  eventId: number,
): Promise<SharedPicksCoordinatorState> {
  try {
    const redis = await redisSingleton.getClient();
    const raw = await redis.get(liveV2PicksCoordinatorKey({ season: seasonCode, eventId }));
    if (!raw) return defaultPicksCoordinatorState();
    const value = JSON.parse(raw) as Partial<SharedPicksCoordinatorState>;
    const attempts = value.attempts;
    const nextProbeAt = value.nextProbeAt;
    if (
      !value ||
      typeof attempts !== 'number' ||
      !Number.isSafeInteger(attempts) ||
      typeof nextProbeAt !== 'number' ||
      !Number.isFinite(nextProbeAt) ||
      typeof value.canarySucceeded !== 'boolean' ||
      !Array.isArray(value.failedCanaryEntryIds) ||
      !value.failedCanaryEntryIds.every((entryId) => Number.isSafeInteger(entryId) && entryId > 0)
    )
      return defaultPicksCoordinatorState();
    return {
      attempts: Math.max(0, attempts),
      nextProbeAt: Math.max(0, nextProbeAt),
      canarySucceeded: value.canarySucceeded,
      failedCanaryEntryIds: [...new Set(value.failedCanaryEntryIds)],
    };
  } catch (error) {
    logError('Failed to read shared live picks coordinator state', error, { seasonCode, eventId });
    return defaultPicksCoordinatorState();
  }
}

async function writePicksCoordinatorState(
  seasonCode: string,
  eventId: number,
  state: SharedPicksCoordinatorState,
): Promise<void> {
  try {
    const redis = await redisSingleton.getClient();
    await redis.set(
      liveV2PicksCoordinatorKey({ season: seasonCode, eventId }),
      JSON.stringify(state),
      'EX',
      String(COORDINATOR_STATE_TTL_SECONDS),
    );
  } catch (error) {
    logError('Failed to write shared live picks coordinator state', error, { seasonCode, eventId });
  }
}

export async function readLifecycleQuietState(
  seasonCode: string,
  eventId: number,
): Promise<SharedLifecycleQuietState | null> {
  try {
    const redis = await redisSingleton.getClient();
    const raw = await redis.get(liveV2LifecycleKey({ season: seasonCode, eventId }));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<SharedLifecycleQuietState>;
    const unchangedSince = value.unchangedSince;
    if (
      typeof unchangedSince !== 'number' ||
      !Number.isFinite(unchangedSince) ||
      unchangedSince <= 0
    )
      return null;
    if (
      !(
        typeof value.revision === 'number' ||
        typeof value.revision === 'string' ||
        value.revision === null
      )
    )
      return null;
    const expectedNextCheckAt =
      value.expectedNextCheckAt === null
        ? null
        : typeof value.expectedNextCheckAt === 'string' &&
            Number.isFinite(Date.parse(value.expectedNextCheckAt))
          ? value.expectedNextCheckAt
          : undefined;
    return { revision: value.revision, unchangedSince, expectedNextCheckAt };
  } catch (error) {
    logError('Failed to read shared live lifecycle state', error, { seasonCode, eventId });
    return null;
  }
}

async function writeLifecycleQuietState(
  seasonCode: string,
  eventId: number,
  state: SharedLifecycleQuietState,
): Promise<void> {
  try {
    const redis = await redisSingleton.getClient();
    await redis.set(
      liveV2LifecycleKey({ season: seasonCode, eventId }),
      JSON.stringify(state),
      'EX',
      String(COORDINATOR_STATE_TTL_SECONDS),
    );
  } catch (error) {
    logError('Failed to write shared live lifecycle state', error, { seasonCode, eventId });
  }
}

export function resolveLivePicksCoordinatorDeduplicationId(
  seasonCode: string,
  eventId: number,
): string {
  return `live-picks-refresh:${seasonCode}:event-${eventId}`;
}

export function resolveLivePicksEntryDeduplicationId(
  seasonCode: string,
  eventId: number,
  entryId: number,
): string {
  if (!Number.isSafeInteger(entryId) || entryId <= 0) {
    throw new Error('Live picks entry deduplication requires a positive entry id');
  }
  return `live-picks-entry:${seasonCode}:event-${eventId}:entry-${entryId}`;
}

export function resolveLivePicksProbeBackoffResult(
  canarySucceeded: boolean,
  options: Readonly<{
    schedulerFenced?: boolean;
    retryableRepair?: boolean;
  }> = {},
) {
  const schedulerFenced = options.schedulerFenced === true;
  const retryableRepair = options.retryableRepair === true;
  const acceptedBackoff = canarySucceeded && schedulerFenced;
  // A governance repair carries a freshness window but no scheduler fence.
  // It must stay source-not-ready so the BullMQ retry policy can wait for the
  // shared probe backoff to expire; only a fenced scheduler root may be
  // terminally settled as an accepted no-op.
  const sourceReady = canarySucceeded && (!retryableRepair || schedulerFenced);
  return {
    canaryCount: 0,
    synced: 0,
    pending: 0,
    sourceReady,
    scanComplete: false,
    ...(acceptedBackoff ? { outcome: 'accepted-backoff' as const } : {}),
  } as const;
}

/**
 * The scheduler asks the shared coordinator before creating a root probe.
 * This keeps the retry schedule in one durable Redis state machine instead of
 * manufacturing a ten-minute cohort obligation that wakes already-complete
 * entries.  A Redis read failure is fail-open for the producer lane: the root
 * will perform the same bounded check and preserve the last publication if
 * the provider is unavailable.
 */
export async function isLivePicksProbeDue(
  seasonCode: string,
  eventId: number,
  now = new Date(),
): Promise<boolean> {
  const state = await readPicksCoordinatorState(seasonCode, eventId);
  return now.getTime() >= state.nextProbeAt;
}

export function resolveLivePicksRefreshFanout(
  seasonCode: string,
  eventId: number,
  pendingEntryIds: readonly number[],
  canaryEntryIds: readonly number[],
): { entryIds: number[] } {
  if (!/^\d{4}$/.test(seasonCode) || !Number.isSafeInteger(eventId) || eventId <= 0) {
    throw new Error('Live picks fan-out requires a valid season and event');
  }
  const canarySet = new Set(canaryEntryIds);
  return {
    entryIds: uniqueNumbers(pendingEntryIds).filter((entryId) => !canarySet.has(entryId)),
  };
}

async function addPendingLivePicksEntries(
  seasonCode: string,
  eventId: number,
  entryIds: readonly number[],
): Promise<void> {
  if (entryIds.length === 0) return;
  const redis = await redisSingleton.getClient();
  const pendingKey = liveV2PicksPendingKey({ season: seasonCode, eventId });
  const coverageKey = liveV2PicksCoverageKey({ season: seasonCode, eventId });
  await redis.sadd(pendingKey, ...uniqueNumbers(entryIds).map(String));
  await redis.set(coverageKey, 'initialized', 'EX', String(PICKS_COVERAGE_TTL_SECONDS));
  await redis.expire(pendingKey, PICKS_COVERAGE_TTL_SECONDS);
}

/**
 * Marks a per-entry provider job complete only after its V2 input is visible.
 * The marker remains after the set reaches zero, so a restarted worker cannot
 * confuse an expired/missing cohort with an already drained cohort.
 */
export async function markLivePicksEntryComplete(
  seasonCode: string,
  eventId: number,
  entryId: number,
): Promise<boolean> {
  const scope = { season: seasonCode, eventId, entryId } as const;
  const [input, desired] = await Promise.all([
    readEntryLiveInputV2(scope),
    readEntryCheckpointDesiredV2(scope),
  ]);
  // The cohort marker is a durable-completion marker, not a source-fetch
  // marker. A Redis input with an outstanding desired pointer is still
  // pending even when the provider child itself completed successfully.
  if (!input || input.publication.checkpointedAt === null || desired !== null) return false;
  const redis = await redisSingleton.getClient();
  const pendingKey = liveV2PicksPendingKey({ season: seasonCode, eventId });
  await redis.srem(pendingKey, String(entryId));
  const marker = await redis.get(liveV2PicksCoverageKey({ season: seasonCode, eventId }));
  if (marker === null) return false;
  return (await redis.scard(pendingKey)) === 0;
}

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
      shouldObserveMatches: true,
      shouldProbePicks: false,
      // GW_REVIEW owns recurring multiplier/automatic-sub refreshes. Once
      // FPL marks the event data-checked, picks are immutable and the durable
      // final snapshot is the only remaining one-shot obligation.
      shouldSyncPicks: false,
      recoverStaleFixtures: false,
      finalizeEvent: true,
      nextRetryAt: null,
    };
  }
  if (allFinished && lastKickoffMs !== null) {
    return {
      // Time since the last kickoff controls polling cadence only.  It must
      // not manufacture FINALIZED before the event is explicitly marked
      // finished and data-checked.
      state: 'GW_REVIEW',
      // Keep the official event-live heartbeat alive until the event reaches
      // its explicit finalized boundary. A time limit here would make every
      // provisional manager and H2H score disappear during a delayed review.
      shouldFetchLive: true,
      shouldObserveMatches: true,
      shouldProbePicks: false,
      shouldSyncPicks: true,
      recoverStaleFixtures: false,
      finalizeEvent: false,
      nextRetryAt: null,
    };
  }
  if (active) {
    return {
      state: 'LIVE_ACTIVE',
      shouldFetchLive: true,
      shouldObserveMatches: true,
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
        // Keep polling at the low cadence so a new official revision and any
        // multiplier changes can both be observed.
        shouldFetchLive: true,
        shouldObserveMatches: true,
        shouldProbePicks: false,
        shouldSyncPicks: true,
        recoverStaleFixtures: false,
        finalizeEvent: false,
        nextRetryAt: null,
      };
    }
    return {
      state: 'DAY_SETTLING',
      shouldFetchLive: true,
      shouldObserveMatches: true,
      shouldProbePicks: false,
      shouldSyncPicks: true,
      recoverStaleFixtures: false,
      finalizeEvent: false,
      nextRetryAt: null,
    };
  }
  if (Number.isFinite(deadlineMs) && nowMs < deadlineMs) {
    const nextKickoffAt = firstKickoffMs === null ? null : new Date(firstKickoffMs);
    return {
      state: 'PRE_DEADLINE',
      shouldFetchLive: false,
      shouldObserveMatches: true,
      shouldProbePicks: false,
      shouldSyncPicks: false,
      recoverStaleFixtures: false,
      finalizeEvent: false,
      nextRetryAt: null,
      nextKickoffAt,
    };
  }
  if (Number.isFinite(deadlineMs) && nowMs < deadlineMs + PICKS_FIRST_PROBE_OFFSET_MS) {
    return {
      state: 'PICKS_WAIT',
      shouldFetchLive: false,
      shouldObserveMatches: false,
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
      shouldObserveMatches: true,
      shouldProbePicks: true,
      shouldSyncPicks: false,
      recoverStaleFixtures: false,
      finalizeEvent: false,
      nextRetryAt: null,
      nextKickoffAt: new Date(firstKickoffMs),
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
      shouldObserveMatches: true,
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
    shouldObserveMatches: false,
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
  const candidateEntryIds = uniqueNumbers([
    ...entryLists.flat(),
    ...knownEntries
      .filter((entry) => entry.startedEvent === null || entry.startedEvent <= eventId)
      .map((entry) => entry.id),
  ]).filter((entryId) => entryId > 0);
  return findEventEligibleEntryIds(candidateEntryIds, knownEntries, eventId)
    .filter((entryId) => entryId > 0)
    .sort((a, b) => a - b);
}

function isStablePicksResponse(payload: RawFPLEntryEventPicksResponse, eventId: number): boolean {
  return payload.entry_history.event === eventId && isCompleteEntryPicks(payload.picks);
}

/**
 * Picks are a one-time base-input publication for a live event. After a
 * complete V2 input exists, automatic substitutions and captain promotion are
 * calculated from the live publication; the source is not swept again every
 * ten minutes. Only entries without a complete same-event input are admitted
 * to the FPL lane.
 */
export async function findMissingEntryLiveInputIds(
  season: FplSeasonRef,
  eventId: number,
  entryIds: readonly number[],
  options: { readonly repairCheckpoint?: boolean } = {},
): Promise<number[]> {
  const repairCheckpoint = options.repairCheckpoint !== false;
  const liveObservation = await readLivePublicationV2({
    season: season.seasonCode,
    eventId,
  }).catch(() => null);
  const results = await mapWithConcurrency(entryIds, 32, async (entryId) => {
    const scope = {
      season: season.seasonCode,
      eventId,
      entryId,
    } as const;
    const [input, desired] = await Promise.all([
      readEntryLiveInputV2(scope),
      readEntryCheckpointDesiredV2(scope),
    ]);
    if (input) {
      const chip = input.input.picksBase.chip;
      const managerFact = input.input.picksBase.assistantManagerPoints;
      const managerObservationChanged =
        (chip === 'manager' || chip === 'MANAGER') &&
        liveObservation !== null &&
        (!managerFact ||
          managerFact.livePublicationId !== liveObservation.publication.publicationId ||
          managerFact.liveGeneration !== liveObservation.publication.generation ||
          managerFact.liveScoreCoreRevision !==
            liveObservation.publication.revisions.scoreCore.revision);
      if (managerObservationChanged) return entryId;
      if (!repairCheckpoint) return null;
      if (!desired && input.publication.checkpointedAt !== null) return null;
      // Redis already contains the complete input. Retry only the durable
      // checkpoint; never refetch FPL merely because PostgreSQL was down. A
      // missing desired pointer with an uncheckpointed publication is also a
      // repair case, not a provider-missing case.
      let checkpointed = false;
      try {
        if (!desired && input.publication.checkpointedAt === null) {
          await setEntryCheckpointDesiredV2(input.publication);
        }
        const checkpointResult = await checkpointEntryLiveInputV2(season, eventId, entryId);
        if (checkpointResult === 'checkpointed') {
          checkpointed = true;
          // This is a no-op until the cohort pending set is initialized.  Once
          // it exists, it is the durable completion signal for canaries as well
          // as queued entries.
          await markLivePicksEntryComplete(season.seasonCode, eventId, entryId);
        }
      } catch (error) {
        logError('Entry live V2 checkpoint repair failed', error, { entryId, eventId });
      }
      return checkpointed ? null : entryId;
    }
    return input ? null : entryId;
  });
  return results.filter((entryId): entryId is number => entryId !== null);
}

export async function findPendingEntryLiveCheckpointIds(
  season: FplSeasonRef,
  eventId: number,
  entryIds: readonly number[],
): Promise<number[]> {
  const results = await mapWithConcurrency(entryIds, 32, async (entryId) => {
    const scope = { season: season.seasonCode, eventId, entryId } as const;
    const [input, desired] = await Promise.all([
      readEntryLiveInputV2(scope),
      readEntryCheckpointDesiredV2(scope),
    ]);
    return input && (desired || input.publication.checkpointedAt === null) ? entryId : null;
  });
  return results.filter((entryId): entryId is number => entryId !== null);
}

export async function runPicksProbeAndSync(
  season: FplSeasonRef,
  eventId: number,
  now = new Date(),
  obligation: Readonly<{
    obligationId?: string;
    obligationGeneration?: number;
    freshnessWindowId?: number;
  }> = {},
): Promise<{
  canaryCount: number;
  synced: number;
  pending: number;
  /** The scheduler may settle this root as skipped after an accepted backoff. */
  outcome?: 'accepted-backoff';
  /** The source canary was accepted for this event window. */
  sourceReady: boolean;
  /** The complete eligible-entry sweep reached its semantic finalizer. */
  scanComplete: boolean;
}> {
  const sharedState = await readPicksCoordinatorState(season.seasonCode, eventId);
  const state: PicksProbeState = {
    attempts: sharedState.attempts,
    nextProbeAt: sharedState.nextProbeAt,
    canarySucceeded: sharedState.canarySucceeded,
    failedCanaryEntryIds: new Set(sharedState.failedCanaryEntryIds),
  };
  if (now.getTime() < state.nextProbeAt) {
    // The scheduler can resolve an obligation just before the coordinator
    // writes its next-probe fence. A fenced root whose source canary has
    // already been accepted is a successful no-op; an unfenced freshness
    // repair must remain source-not-ready so BullMQ retries it. Keep
    // scanComplete false so an outstanding checkpoint/repair is not marked
    // complete early.
    const schedulerFenced =
      typeof obligation.obligationId === 'string' &&
      obligation.obligationId.length > 0 &&
      typeof obligation.obligationGeneration === 'number' &&
      Number.isSafeInteger(obligation.obligationGeneration) &&
      obligation.obligationGeneration >= 0;
    return resolveLivePicksProbeBackoffResult(state.canarySucceeded, {
      schedulerFenced,
      retryableRepair: obligation.freshnessWindowId !== undefined,
    });
  }
  const entryIds = await resolveUniqueActiveTournamentEntryIds(season, eventId);
  if (entryIds.length === 0) {
    return {
      canaryCount: 0,
      synced: 0,
      pending: 0,
      sourceReady: true,
      scanComplete: true,
    };
  }
  const nowMs = now.getTime();
  const pending = await findMissingEntryLiveInputIds(season, eventId, entryIds);
  const pendingCheckpoints = await findPendingEntryLiveCheckpointIds(season, eventId, entryIds);
  if (pending.length === 0) {
    // A complete input is never refetched from FPL, but the coordinator still
    // performs a bounded Redis/DB coverage scan while the event can affect
    // live projections. This repairs an evicted entry key or a delayed
    // checkpoint without reopening the provider fan-out for readable inputs.
    const nextProbeAt = nowMs + PICKS_PROBE_POLL_MS;
    await writePicksCoordinatorState(season.seasonCode, eventId, {
      attempts: state.attempts,
      nextProbeAt,
      canarySucceeded: true,
      failedCanaryEntryIds: [],
    });
    return {
      canaryCount: 0,
      synced: 0,
      pending: pendingCheckpoints.length,
      sourceReady: true,
      scanComplete: pendingCheckpoints.length === 0,
    };
  }

  let canaries = state.canarySucceeded
    ? []
    : pending.filter((entryId) => !state.failedCanaryEntryIds.has(entryId)).slice(0, 2);
  if (!state.canarySucceeded && canaries.length === 0) {
    state.failedCanaryEntryIds.clear();
    canaries = pending.slice(0, 2);
  }
  const canaryResults = await Promise.allSettled(
    canaries.map(async (entryId) => {
      const liveObservation = await readLivePublicationV2({
        season: season.seasonCode,
        eventId,
      });
      const payload = await fplClient.getEntryEventPicks(entryId, eventId);
      if (!isStablePicksResponse(payload, eventId)) {
        throw new Error(`Entry ${entryId} picks are not a complete event ${eventId} payload`);
      }
      const managerChip = payload.active_chip === 'manager' || payload.active_chip === 'MANAGER';
      // Manager points must be derived from a provider event-live observation,
      // never from the cached player subtotal in the Redis publication. The
      // persistence fence compares this response with the same live revision
      // before attaching the manager-only fact.
      const providerEventLive = managerChip ? await fplClient.getEventLive(eventId) : undefined;
      await persistEntryEventPicksResponse(season, entryId, eventId, payload, undefined, {
        liveObservation,
        providerEventLive,
      });
      return entryId;
    }),
  );
  const canaryCount = canaryResults.filter((result) => result.status === 'fulfilled').length;
  canaryResults.forEach((result, index) => {
    const entryId = canaries[index];
    if (entryId === undefined) return;
    if (result.status === 'fulfilled') {
      state.failedCanaryEntryIds.delete(entryId);
    } else state.failedCanaryEntryIds.add(entryId);
  });
  if (!state.canarySucceeded && canaryCount === 0) {
    state.attempts += 1;
    const delay =
      PICKS_RETRY_SCHEDULE_MS[Math.min(state.attempts - 1, PICKS_RETRY_SCHEDULE_MS.length - 1)] ??
      600_000;
    state.nextProbeAt = now.getTime() + delay;
    await writePicksCoordinatorState(season.seasonCode, eventId, {
      attempts: state.attempts,
      nextProbeAt: state.nextProbeAt,
      canarySucceeded: state.canarySucceeded,
      failedCanaryEntryIds: [...state.failedCanaryEntryIds].sort((left, right) => left - right),
    });
    logInfo('Live picks canary is not ready; fan-out remains paused', {
      eventId,
      canaries: canaries.length,
    });
    return {
      canaryCount,
      synced: 0,
      pending: pending.length,
      sourceReady: false,
      scanComplete: false,
    };
  }

  const successfulCanaryIds = canaries.filter(
    (entryId, index) => canaryResults[index]?.status === 'fulfilled',
  );
  state.canarySucceeded = state.canarySucceeded || successfulCanaryIds.length > 0;
  const fanout = resolveLivePicksRefreshFanout(
    season.seasonCode,
    eventId,
    pending,
    successfulCanaryIds,
  );
  const remaining = fanout.entryIds;
  // Canary publications are also async checkpoint obligations. Keep them in
  // the same durable pending set until checkpointEntryLiveInputV2 succeeds;
  // otherwise the final queued child can settle the cohort too early. This
  // must also run when the cohort contains only the two canaries.
  await addPendingLivePicksEntries(
    season.seasonCode,
    eventId,
    uniqueNumbers([...remaining, ...successfulCanaryIds]),
  );
  let completedEntryIds: boolean[] = [];
  if (remaining.length > 0) {
    // Each entry gets its own BullMQ single-flight identity. The queue still
    // limits provider concurrency to three, but one slow/new entry can no
    // longer deduplicate or delay every other entry in the event cohort.
    completedEntryIds = await mapWithConcurrency(remaining, 8, async (entryId) => {
      const queuedJob = await enqueueEntryPicksSyncJob(season, 'cron', {
        eventId,
        entryIds: [entryId],
        concurrency: 1,
        throttleMs: 0,
        lane: 'live-picks',
        queueKey: `live-picks-${eventId}-entry-${entryId}`,
        jobId: `entry-picks-${season.seasonCode}-live-repair-${eventId}-${entryId}-${nowMs}`,
        obligationId: obligation.obligationId,
        obligationGeneration: obligation.obligationGeneration,
        freshnessWindowId: obligation.freshnessWindowId,
        deduplicationId: resolveLivePicksEntryDeduplicationId(season.seasonCode, eventId, entryId),
      });
      const childState = await queuedJob.getState();
      if (childState !== 'completed') return false;
      // A retained completed job is only reusable when its V2 input is still
      // visible. This prevents queue history from being mistaken for a live
      // publication after Redis eviction or repair.
      const input = await readEntryLiveInputV2({
        season: season.seasonCode,
        eventId,
        entryId,
      });
      if (!input) return false;
      await markLivePicksEntryComplete(season.seasonCode, eventId, entryId);
      return true;
    });
  }
  const pendingAfterQueue = remaining.filter((_, index) => !completedEntryIds[index]);
  const pendingCheckpointAfterQueue = await findPendingEntryLiveCheckpointIds(
    season,
    eventId,
    entryIds,
  );
  const canaryCheckpointIds = await findPendingEntryLiveCheckpointIds(
    season,
    eventId,
    successfulCanaryIds,
  );
  const pendingCheckpointIds = uniqueNumbers([
    ...pendingCheckpointAfterQueue,
    ...canaryCheckpointIds,
  ]);
  const reusedCompletedScan = remaining.length > 0 && pendingAfterQueue.length === 0;
  state.attempts += 1;
  state.nextProbeAt = now.getTime() + (PICKS_RETRY_SCHEDULE_MS[0] ?? 120_000);
  await writePicksCoordinatorState(season.seasonCode, eventId, {
    attempts: state.attempts,
    nextProbeAt: state.nextProbeAt,
    canarySucceeded: state.canarySucceeded,
    failedCanaryEntryIds: [...state.failedCanaryEntryIds].sort((left, right) => left - right),
  });
  logInfo('Live picks sync accepted after canary', {
    eventId,
    canaryCount,
    totalUniqueEntries: entryIds.length,
    queued: remaining.length,
  });
  return {
    canaryCount,
    synced: canaryCount,
    pending: pendingAfterQueue.length + pendingCheckpointIds.length,
    sourceReady: true,
    scanComplete:
      (pendingAfterQueue.length === 0 || reusedCompletedScan) && pendingCheckpointIds.length === 0,
  };
}

/**
 * Observe and persist the lifecycle checkpoint without enqueuing work. The
 * standalone scheduler owns queue dispatch, so it calls this on every pass to
 * keep lifecycle state independent from publication revisions.
 */
export async function persistLiveLifecycleStatus(now = new Date()) {
  const season = await seasonRepository.findCurrent();
  const currentEvent = await (await import('./events.service')).getCurrentEvent(season);
  if (!currentEvent) return null;
  const fixtures = await fixtureRepository.findByEvent(season, currentEvent.id);
  const cache = await readLivePublicationV2({
    season: season.seasonCode,
    eventId: currentEvent.id,
  }).catch(() => null);
  const generation = cache?.publication.generation ?? null;
  const sourceCheckedAt = cache?.publication.sourceCheckedAt;
  const persisted = await liveLifecycleStatusRepository
    .findByEventId(season, currentEvent.id)
    .catch(() => null);
  const publishedAtMs = cache?.publication.publishedAt
    ? new Date(cache.publication.publishedAt).getTime()
    : Number.NaN;
  const persistedSourceCheckedAtMs = persisted?.sourceCheckedAt?.getTime() ?? Number.NaN;
  const initialUnchangedSince = Number.isFinite(publishedAtMs)
    ? Math.min(now.getTime(), publishedAtMs)
    : Number.isFinite(persistedSourceCheckedAtMs)
      ? Math.min(now.getTime(), persistedSourceCheckedAtMs)
      : now.getTime();
  const previous = await readLifecycleQuietState(season.seasonCode, currentEvent.id);
  const observation =
    previous && previous.revision === generation
      ? previous
      : { revision: generation, unchangedSince: initialUnchangedSince };
  const decision = decideLiveLifecycle(currentEvent, fixtures, now, {
    lastRevision: generation,
    unchangedSince: observation?.unchangedSince ?? null,
    matchDayTime: isMatchDayTime(currentEvent, fixtures, now),
    publicationStarted: cache?.fixtures.some((fixture) => fixture.started === true),
    publicationActive: cache?.fixtures.some(
      (fixture) => fixture.started === true && !fixture.finished && !fixture.finishedProvisional,
    ),
  });

  const nextRefreshDelay = resolveLiveLifecycleDelay(
    decision,
    season,
    currentEvent.id,
    now,
    observation.unchangedSince,
  );
  const nextRefreshAt =
    nextRefreshDelay === null ? null : new Date(now.getTime() + nextRefreshDelay);
  // The quiet clock and expected next check are shared restart-safe control
  // state. Redis writes are intentionally cheap; PostgreSQL is boundary-only.
  await writeLifecycleQuietState(season.seasonCode, currentEvent.id, {
    ...observation,
    state: decision.state,
    expectedNextCheckAt: nextRefreshAt?.toISOString() ?? null,
  });
  if (
    shouldPersistLiveLifecycleStatus({
      persisted,
      state: decision.state,
      generation,
      publicationId: cache?.publication.publicationId ?? null,
    })
  ) {
    await liveLifecycleStatusRepository
      .upsert(season, {
        eventId: currentEvent.id,
        state: decision.state,
        observedAt: now,
        lastChangedAt: persisted?.state === decision.state ? persisted.lastChangedAt : now,
        nextRefreshAt,
        generation,
        publicationId: cache?.publication.publicationId ?? null,
        sourceCheckedAt: sourceCheckedAt ? new Date(sourceCheckedAt) : null,
      })
      .catch((error) => {
        logError('Failed to persist live lifecycle status', error, {
          eventId: currentEvent.id,
          state: decision.state,
        });
      });
  }

  return { season, currentEvent, fixtures, decision, expectedNextCheckAt: nextRefreshAt };
}

/**
 * The direct cron timer historically only considered getCurrentEvent(). That
 * event is the latest deadline that has passed, so the next event never got a
 * pre-deadline Match V3 warmup when the standalone registry was not running.
 * Keep this as a Match-only lane and do not promote the global event pointer:
 * the current event remains the eventless GraphQL authority until its own
 * post-deadline/live lane advances it.
 */
async function observeUpcomingMatchEventDirect(
  season: FplSeasonRef,
  currentEventId: number,
  now: Date,
): Promise<void> {
  const nextEvent = await (await import('./events.service')).getNextEvent(season).catch(() => null);
  if (!nextEvent || nextEvent.id === currentEventId || !nextEvent.deadlineTime) return;
  const fixtures = await fixtureRepository.findByEvent(season, nextEvent.id).catch(() => []);
  const decision = decideLiveLifecycle(nextEvent, fixtures, now);
  if (decision.state !== 'PRE_DEADLINE' || !decision.shouldObserveMatches) return;

  const quiet = await readLifecycleQuietState(season.seasonCode, nextEvent.id);
  const expectedNextCheckMs = quiet?.expectedNextCheckAt
    ? Date.parse(quiet.expectedNextCheckAt)
    : Number.NaN;
  if (Number.isFinite(expectedNextCheckMs) && expectedNextCheckMs > now.getTime()) return;

  const pollIntervalMs = resolveLiveLifecycleDelay(
    decision,
    season,
    nextEvent.id,
    now,
    quiet?.unchangedSince,
  );
  if (pollIntervalMs === null) return;
  const expectedNextCheckAt = new Date(now.getTime() + pollIntervalMs);
  await enqueueLiveSnapshot(season, nextEvent.id, 'cron', {
    now,
    lifecycleState: 'PRE_DEADLINE',
    expectedNextCheckAt,
    matchObservationOnly: true,
  });
  await writeLifecycleQuietState(season.seasonCode, nextEvent.id, {
    revision: quiet?.revision ?? null,
    unchangedSince: quiet?.unchangedSince ?? now.getTime(),
    state: 'PRE_DEADLINE',
    expectedNextCheckAt: expectedNextCheckAt.toISOString(),
  });
}

export async function runLiveLifecycle(now = new Date()): Promise<LiveLifecycleDecision | null> {
  const tick = await persistLiveLifecycleStatus(now);
  if (!tick) return null;
  const { season, currentEvent, fixtures, decision, expectedNextCheckAt } = tick;

  // The deadline canary and pre-start retry lane are the only coordinator
  // probes. Once the live publication is active, complete picks are immutable
  // base input; new entries arrive through their own onboarding/repair job.
  if (decision.shouldProbePicks) {
    await runPicksProbeAndSync(season, currentEvent.id, now).catch((error) => {
      logError('Live picks probe/sync failed', error, {
        eventId: currentEvent.id,
        state: decision.state,
      });
    });
  }
  if (decision.shouldFetchLive || decision.shouldObserveMatches) {
    const shouldEnqueueFinalization = decision.finalizeEvent
      ? (await eventRepository.findLiveSnapshotFinalizedAt(season, currentEvent.id)) === null
      : false;
    if (!decision.finalizeEvent || shouldEnqueueFinalization) {
      if (decision.state === 'LIVE_ACTIVE') {
        await enqueueLiveActiveSnapshot(
          season,
          currentEvent.id,
          now,
          normalizeMatchLifecycleState(decision.state) ?? 'LIVE_ACTIVE',
          expectedNextCheckAt,
        );
      } else {
        await enqueueLiveSnapshot(season, currentEvent.id, 'cron', {
          finalizeEvent: decision.finalizeEvent,
          matchObservationOnly: decision.shouldObserveMatches && !decision.shouldFetchLive,
          lifecycleState: normalizeMatchLifecycleState(decision.state),
          expectedNextCheckAt,
          now,
        });
      }
    }
    if (shouldRefreshOfficialH2H(decision, isMatchDayTime(currentEvent, fixtures, now))) {
      await enqueueTournamentOfficialH2H(season, currentEvent.id, 'cron', {
        jobId: `official-h2h-e${currentEvent.id}-${now.toISOString().slice(0, 16).replace(/\D/g, '')}`,
      }).catch((error) => {
        logError('Failed to enqueue live official H2H sync', error, {
          eventId: currentEvent.id,
        });
      });
    }
  }
  await observeUpcomingMatchEventDirect(season, currentEvent.id, now).catch((error) => {
    logError('Failed to enqueue upcoming direct Match V3 observation', error, {
      eventId: currentEvent.id,
    });
  });
  logInfo('Live lifecycle tick completed', {
    eventId: currentEvent.id,
    state: decision.state,
    shouldFetchLive: decision.shouldFetchLive,
    shouldObserveMatches: decision.shouldObserveMatches,
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

export function resolveLiveLifecycleDelay(
  decision: LiveLifecycleDecision,
  season: FplSeasonRef,
  eventId: number,
  now: Date,
  unchangedSince?: number | null,
): number | null {
  void season;
  void eventId;
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
      return unchangedSince !== null &&
        unchangedSince !== undefined &&
        now.getTime() - unchangedSince >= DAY_SETTLING_STABLE_AFTER_MS
        ? DAY_SETTLING_STABLE_POLL_MS
        : DAY_SETTLING_INITIAL_POLL_MS;
    }
    case 'GW_REVIEW':
      return isUkFinalizationWindow(now) ? GW_REVIEW_FINALIZATION_POLL_MS : GW_REVIEW_POLL_MS;
    case 'PICKS_PROBE':
      // A picks probe is already a post-deadline retry lane. Its backoff is
      // owned by nextRetryAt/PICKS_PROBE_POLL_MS, not by the next fixture
      // kickoff. Applying pre-deadline tiers here can turn a failed canary
      // into a fifteen-minute wait and miss the 2/3/5/10-minute retry plan.
      return PICKS_PROBE_POLL_MS;
    case 'PICKS_SYNC':
      return PICKS_PROBE_POLL_MS;
    case 'PRE_DEADLINE':
      if (!decision.nextKickoffAt) return PRE_DEADLINE_SLOW_POLL_MS;
      {
        const untilKickoffMs = decision.nextKickoffAt.getTime() - now.getTime();
        if (untilKickoffMs <= 5 * 60_000) return PRE_DEADLINE_NEAR_POLL_MS;
        if (untilKickoffMs <= 30 * 60_000) return PRE_DEADLINE_WARM_POLL_MS;
        return PRE_DEADLINE_SLOW_POLL_MS;
      }
    case 'PICKS_WAIT':
      return PICKS_PROBE_POLL_MS;
    default:
      return LIVE_POLL_MS;
  }
}

/**
 * Lifecycle is a hot Redis control signal. PostgreSQL records the first
 * observation and lifecycle boundaries, but must not become a 30-second
 * heartbeat write sink. Publication freshness remains available from the V2
 * Redis manifest and is therefore not lost by this write reduction.
 */
export function shouldPersistLiveLifecycleStatus(input: {
  readonly persisted: {
    readonly state: string;
    readonly generation: number | null;
    readonly publicationId: string | null;
  } | null;
  readonly state: LiveLifecycleState;
  readonly generation: number | null;
  readonly publicationId: string | null;
}): boolean {
  if (!input.persisted) return true;
  if (input.persisted.state !== input.state) return true;
  return (
    input.state !== 'LIVE_ACTIVE' &&
    (input.persisted.generation !== input.generation ||
      input.persisted.publicationId !== input.publicationId)
  );
}

async function runLifecycleTick(now: Date): Promise<LiveLifecycleDecision | null> {
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
          const quiet =
            season && currentEvent
              ? await readLifecycleQuietState(season.seasonCode, currentEvent.id)
              : null;
          schedule(
            decision && season
              ? resolveLiveLifecycleDelay(
                  decision,
                  season,
                  currentEvent?.id ?? 0,
                  now,
                  quiet?.unchangedSince,
                )
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
          const quiet =
            season && currentEvent
              ? await readLifecycleQuietState(season.seasonCode, currentEvent.id)
              : null;
          schedule(
            decision && season
              ? resolveLiveLifecycleDelay(
                  decision,
                  season,
                  currentEvent?.id ?? 0,
                  now,
                  quiet?.unchangedSince,
                )
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
