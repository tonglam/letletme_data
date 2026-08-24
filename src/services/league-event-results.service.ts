import { fplClient } from '../clients/fpl';
import {
  type DbEntryEventResult,
  type DbEventLive,
  type DbLeagueEventResultInsert,
} from '../db/schemas/index.schema';
import { readDatabaseOrderingTimestamp } from '../db/ordering-timestamp';
import { toNullableDbChip } from '../domain/chips';
import {
  entryEventResultsRepository,
  validateAutomaticSubs,
} from '../repositories/entry-event-results';
import { entryInfoRepository } from '../repositories/entry-infos';
import {
  hasCompleteEntryPickLiveCoverage,
  isCompleteEntryPicks,
  isEntryPicksPayloadForEvent,
  resolveScoringCaptainPick,
} from '../domain/entry-picks';
import { eventLiveRepository } from '../repositories/event-lives';
import { eventRepository } from '../repositories/events';
import type { FplSeasonRef } from '../domain/fpl-season';
import type { EventLive } from '../domain/event-lives';
import {
  leagueEventResultsRepository,
  type LeagueEventResultEvidenceInsert,
} from '../repositories/league-event-results';
import { playerRepository } from '../repositories/players';
import { tournamentInfoRepository } from '../repositories/tournament-infos';
import type { RawFPLEntryEventPickItem, RawFPLEntryEventPicksResponse } from '../types';
import { mapWithConcurrency, uniqueNumbers } from '../utils/async';
import { IncompleteDataSyncError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';
import { resolveTournamentEntryIds } from './tournament-entry-resolver.service';
import { resolveRichResultFreshnessCutoff } from '../domain/entry-sync';
import { latestFreshnessTimestamp } from '../domain/freshness';
import {
  eventLiveAuthorityCheckedAt,
  eventLiveHeartbeatIsFresh,
  eventLivePicksAreFresh,
  loadFreshEventLiveAuthoritySnapshot,
} from './event-live-manager-scores.service';

export { latestFreshnessTimestamp } from '../domain/freshness';

const DEFAULT_CONCURRENCY = 5;

type AutoSubItem = {
  element_in?: number | null;
  elementIn?: number | null;
};

type MissingPickResult = {
  entryId: number;
  picks: RawFPLEntryEventPicksResponse | null;
  checkedAt: Date | null;
};

type LeagueEventLive = EventLive | DbEventLive;

type HighestScoreResult = {
  elementId: number | null;
  points: number | null;
};

function normalizePicks(raw: unknown): RawFPLEntryEventPickItem[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw as RawFPLEntryEventPickItem[];
}

function normalizeAutoSubs(raw: unknown): AutoSubItem[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw as AutoSubItem[];
}

function getAutoSubPoints(
  autoSubs: AutoSubItem[],
  eventLiveMap: ReadonlyMap<number, LeagueEventLive>,
): number {
  return autoSubs.reduce((total, sub) => {
    const elementId = sub.element_in ?? sub.elementIn;
    if (!elementId) {
      return total;
    }

    return total + (eventLiveMap.get(elementId)?.totalPoints ?? 0);
  }, 0);
}

function getHighestScoreElement(
  picks: RawFPLEntryEventPickItem[],
  eventLiveMap: ReadonlyMap<number, LeagueEventLive>,
): HighestScoreResult {
  let bestElement: number | null = null;
  let bestPoints: number | null = null;

  for (const pick of picks) {
    const points = eventLiveMap.get(pick.element)?.totalPoints ?? 0;
    if (bestPoints === null || points > bestPoints) {
      bestPoints = points;
      bestElement = pick.element;
    }
  }

  return { elementId: bestElement, points: bestPoints };
}

function isBlank(eventLive: LeagueEventLive | undefined, elementType: number | null): boolean {
  if (!eventLive) {
    return true;
  }

  const goalsScored = eventLive.goalsScored ?? 0;
  const assists = eventLive.assists ?? 0;
  const bonus = eventLive.bonus ?? 0;
  const penaltiesSaved = eventLive.penaltiesSaved ?? 0;
  const saves = eventLive.saves ?? 0;
  const cleanSheets = eventLive.cleanSheets ?? 0;

  if (goalsScored > 0 || assists > 0 || bonus > 0 || penaltiesSaved > 0 || saves > 3) {
    return false;
  }

  if ((elementType === 1 || elementType === 2) && cleanSheets > 0) {
    return false;
  }

  return true;
}

export function isEntryResultRichEnough(
  entryResult: Pick<DbEntryEventResult, 'richSyncedAt'> | undefined,
  freshAfter?: Date,
): boolean {
  if (!entryResult) return false;
  if (!freshAfter) return entryResult.richSyncedAt !== null;
  return (
    entryResult.richSyncedAt !== null && entryResult.richSyncedAt.getTime() >= freshAfter.getTime()
  );
}

async function fetchMissingEntryPicks(
  entryIds: number[],
  eventId: number,
  concurrency: number,
): Promise<{ results: MissingPickResult[]; errors: number }> {
  let errors = 0;
  const results = await mapWithConcurrency(entryIds, concurrency, async (entryId) => {
    try {
      const picks = await fplClient.getEntryEventPicks(entryId, eventId);
      if (!isEntryPicksPayloadForEvent(picks, eventId)) {
        throw new Error(`Entry ${entryId} returned picks for an unexpected event`);
      }
      return { entryId, picks, checkedAt: new Date() } satisfies MissingPickResult;
    } catch (error) {
      errors += 1;
      logError('Failed to fetch entry event picks for league results', error, {
        entryId,
        eventId,
      });
      return { entryId, picks: null, checkedAt: null } satisfies MissingPickResult;
    }
  });

  return { results, errors };
}

export function buildEntryResultData(
  entryResult: DbEntryEventResult | undefined,
  fallbackPicks: RawFPLEntryEventPicksResponse | null,
  eventId: number,
  eventLiveMap: ReadonlyMap<number, LeagueEventLive>,
  elementTypeMap: Map<number, number>,
): {
  eventPoints: number;
  eventTransfers: number;
  eventTransfersCost: number;
  eventNetPoints: number;
  eventBenchPoints: number | null;
  eventAutoSubPoints: number | null;
  eventRank: number | null;
  eventChip: DbLeagueEventResultInsert['eventChip'];
  overallPoints: number;
  overallRank: number;
  teamValue: number | null;
  bank: number | null;
  captainId: number | null;
  captainPoints: number | null;
  captainBlank: boolean;
  viceCaptainId: number | null;
  viceCaptainPoints: number | null;
  viceCaptainBlank: boolean;
  playedCaptainId: number | null;
  highestScoreElementId: number | null;
  highestScorePoints: number | null;
  highestScoreBlank: boolean;
} | null {
  if (fallbackPicks && !isEntryPicksPayloadForEvent(fallbackPicks, eventId)) {
    return null;
  }
  const storedPicks = entryResult ? normalizePicks(entryResult.eventPicks) : [];
  const fallbackPickRows = fallbackPicks?.picks ?? [];
  const picks = isCompleteEntryPicks(storedPicks)
    ? storedPicks
    : isCompleteEntryPicks(fallbackPickRows)
      ? fallbackPickRows
      : [];
  if (picks.length === 0) {
    return null;
  }
  if (!hasCompleteEntryPickLiveCoverage(picks, [...eventLiveMap.keys()])) {
    return null;
  }

  const storedAutoSubs = entryResult ? normalizeAutoSubs(entryResult.eventAutoSub) : [];
  const autoSubs =
    storedAutoSubs.length > 0
      ? storedAutoSubs
      : normalizeAutoSubs(fallbackPicks?.automatic_subs ?? []);

  const eventPoints = picks.reduce(
    (total, pick) => total + (eventLiveMap.get(pick.element)?.totalPoints ?? 0) * pick.multiplier,
    0,
  );
  const eventTransfers =
    entryResult?.eventTransfers ?? fallbackPicks?.entry_history.event_transfers ?? 0;
  const eventTransfersCost =
    entryResult?.eventTransfersCost ?? fallbackPicks?.entry_history.event_transfers_cost ?? 0;
  const eventNetPoints = eventPoints - eventTransfersCost;
  const eventBenchPoints = picks
    // Official multipliers encode the effective post-substitution lineup.
    // Position is only the original bench order and is wrong after auto-subs;
    // Bench Boost correctly produces zero non-scoring picks.
    .filter((pick) => pick.multiplier === 0)
    .reduce((total, pick) => total + (eventLiveMap.get(pick.element)?.totalPoints ?? 0), 0);
  const eventAutoSubPoints = getAutoSubPoints(autoSubs, eventLiveMap);
  const eventRank = entryResult?.eventRank ?? fallbackPicks?.entry_history.rank ?? null;
  const eventChip = entryResult?.eventChip ?? toNullableDbChip(fallbackPicks?.active_chip);
  const previousOverallPoints = entryResult
    ? entryResult.overallPoints - entryResult.eventNetPoints
    : fallbackPicks
      ? fallbackPicks.entry_history.total_points -
        (fallbackPicks.entry_history.points - fallbackPicks.entry_history.event_transfers_cost)
      : 0;
  const overallPoints = previousOverallPoints + eventNetPoints;
  const overallRank = entryResult?.overallRank ?? fallbackPicks?.entry_history.overall_rank ?? 0;
  const teamValue = entryResult?.teamValue ?? fallbackPicks?.entry_history.value ?? null;
  const bank = entryResult?.bank ?? fallbackPicks?.entry_history.bank ?? null;

  const captainPick = picks.find((pick) => pick.is_captain) ?? null;
  const vicePick = picks.find((pick) => pick.is_vice_captain) ?? null;
  const scoringCaptainPick = resolveScoringCaptainPick(picks);
  const captainId = captainPick?.element ?? null;
  const viceCaptainId = vicePick?.element ?? null;
  const captainLive = captainId ? eventLiveMap.get(captainId) : undefined;
  const viceLive = viceCaptainId ? eventLiveMap.get(viceCaptainId) : undefined;
  const scoringCaptainLive = scoringCaptainPick
    ? eventLiveMap.get(scoringCaptainPick.element)
    : undefined;
  const captainPoints = scoringCaptainPick
    ? (scoringCaptainLive?.totalPoints ?? 0) * scoringCaptainPick.multiplier
    : null;
  const viceCaptainPoints = viceCaptainId ? (viceLive?.totalPoints ?? 0) : null;
  const captainBlank = isBlank(
    captainLive,
    captainId ? (elementTypeMap.get(captainId) ?? null) : null,
  );
  const viceCaptainBlank = isBlank(
    viceLive,
    viceCaptainId ? (elementTypeMap.get(viceCaptainId) ?? null) : null,
  );

  const playedCaptainId = scoringCaptainPick?.element ?? null;

  const highest = getHighestScoreElement(picks, eventLiveMap);
  const highestScoreBlank = isBlank(
    highest.elementId ? eventLiveMap.get(highest.elementId) : undefined,
    highest.elementId ? (elementTypeMap.get(highest.elementId) ?? null) : null,
  );

  return {
    eventPoints,
    eventTransfers,
    eventTransfersCost,
    eventNetPoints,
    eventBenchPoints,
    eventAutoSubPoints,
    eventRank,
    eventChip,
    overallPoints,
    overallRank,
    teamValue,
    bank,
    captainId,
    captainPoints,
    captainBlank,
    viceCaptainId,
    viceCaptainPoints,
    viceCaptainBlank,
    playedCaptainId,
    highestScoreElementId: highest.elementId,
    highestScorePoints: highest.points,
    highestScoreBlank,
  };
}

export function findMissingLeagueResultEntryIds(
  expectedEntryIds: readonly number[],
  persistedEntryIds: ReadonlySet<number>,
): number[] {
  return expectedEntryIds.filter((entryId) => !persistedEntryIds.has(entryId));
}

export function findEventEligibleEntryIds(
  entryIds: readonly number[],
  entryInfos: ReadonlyArray<{ id: number; startedEvent: number | null }>,
  eventId: number,
): number[] {
  const startsByEntryId = new Map(entryInfos.map((entry) => [entry.id, entry.startedEvent]));
  return entryIds.filter((entryId) => {
    const startedEvent = startsByEntryId.get(entryId);
    return startedEvent === undefined || startedEvent === null || eventId >= startedEvent;
  });
}

export type LeagueEventResultsSyncSummary = {
  tournamentId: number;
  eventId: number;
  totalEntries: number;
  updated: number;
  skipped: number;
  errors: number;
  requiredUnits: number;
  reusedUnits: number;
  succeededUnits: number;
  failedUnits: number;
};

export function summarizeMissingLeagueEventLiveData(
  tournamentId: number,
  eventId: number,
  requiredEntryCount: number,
  reusedUnits = 0,
): LeagueEventResultsSyncSummary {
  return {
    tournamentId,
    eventId,
    totalEntries: requiredEntryCount + reusedUnits,
    updated: 0,
    skipped: requiredEntryCount,
    errors: requiredEntryCount,
    requiredUnits: requiredEntryCount,
    reusedUnits,
    succeededUnits: 0,
    failedUnits: requiredEntryCount,
  };
}

export function leagueEventLiveInputsAreFresh(
  liveCheckedAt: string,
  picksCheckedAt: string,
  nowMs = Date.now(),
): boolean {
  return (
    eventLiveHeartbeatIsFresh(liveCheckedAt, nowMs) &&
    eventLivePicksAreFresh(picksCheckedAt, liveCheckedAt)
  );
}

export function findMissingLeagueResultSourceCheckpoints(
  expected: ReadonlyArray<Pick<LeagueEventResultEvidenceInsert, 'entryId' | 'sourceCheckedAt'>>,
  persisted: ReadonlyArray<{ entryId: number; sourceCheckedAt: Date | null }>,
): number[] {
  const persistedByEntry = new Map(persisted.map((row) => [row.entryId, row.sourceCheckedAt]));
  return uniqueNumbers(
    expected
      .filter((row) => {
        const expectedMs =
          row.sourceCheckedAt instanceof Date
            ? row.sourceCheckedAt.getTime()
            : Date.parse(row.sourceCheckedAt);
        if (!Number.isFinite(expectedMs)) {
          throw new Error('A valid league result source timestamp is required');
        }
        const checkpoint = persistedByEntry.get(row.entryId);
        const checkpointMs = checkpoint?.getTime() ?? Number.NaN;
        return !Number.isFinite(checkpointMs) || checkpointMs < expectedMs;
      })
      .map((row) => row.entryId),
  );
}

export async function syncLeagueEventResultsByTournament(
  season: FplSeasonRef,
  tournamentId: number,
  eventId: number,
  options?: {
    concurrency?: number;
    freshAfter?: Date | string;
    entryIds?: number[];
  },
): Promise<LeagueEventResultsSyncSummary> {
  logInfo('Starting league event results sync for tournament', { tournamentId, eventId });
  // Use one database-clock token before any source reads. It is comparable
  // across workers and remains the evidence timestamp even when a slower
  // attempt finishes after a newer result-slot run.
  const sourceOrdering = await readDatabaseOrderingTimestamp();
  const freshAfter = options?.freshAfter ?? sourceOrdering.exact;
  const [tournament, event] = await Promise.all([
    tournamentInfoRepository.findById(season, tournamentId),
    eventRepository.findById(season, eventId),
  ]);
  if (!tournament) {
    throw new Error(`Tournament ${tournamentId} not found`);
  }

  // A finalized event establishes a canonical evidence boundary. Require the
  // stricter of that boundary and this attempt's database-clock token so the
  // reuse, write, and post-write audit all share one clock domain.
  const finalizationDate = resolveRichResultFreshnessCutoff(event);
  const finalizationCutoff = finalizationDate
    ? ((await eventRepository.findDataCheckedAtExact(season, eventId)) ?? finalizationDate)
    : null;
  const requiredRichFreshAfter = latestFreshnessTimestamp(freshAfter, finalizationCutoff);

  const resolvedEntryIds = await resolveTournamentEntryIds(season, tournament);
  const requestedEntryIds = options?.entryIds ? new Set(uniqueNumbers(options.entryIds)) : null;
  const scopedEntryIds = requestedEntryIds
    ? resolvedEntryIds.filter((entryId) => requestedEntryIds.has(entryId))
    : resolvedEntryIds;
  const entryInfos = await entryInfoRepository.findByIds(season, scopedEntryIds);
  const entryInfoMap = new Map(entryInfos.map((info) => [info.id, info]));
  const entryIds = findEventEligibleEntryIds(scopedEntryIds, entryInfos, eventId);
  if (entryIds.length === 0) {
    return {
      tournamentId,
      eventId,
      totalEntries: 0,
      updated: 0,
      skipped: 0,
      errors: 0,
      requiredUnits: 0,
      reusedUnits: 0,
      succeededUnits: 0,
      failedUnits: 0,
    };
  }
  // Active rows are ordered by their paired official source timestamp, not by
  // the database-clock token captured before the source reads. Rebuild them on
  // every scheduled attempt; the guarded upsert will retain a concurrently
  // published row backed by newer source evidence.
  const reusedEntryIds =
    finalizationCutoff && requiredRichFreshAfter
      ? await leagueEventResultsRepository.findEntryIdsByLeagueEvent(
          season,
          tournament.leagueId,
          tournament.leagueType,
          eventId,
          entryIds,
          requiredRichFreshAfter,
        )
      : [];
  const reusedSet = new Set(reusedEntryIds);
  const entriesToBuild = entryIds.filter((entryId) => !reusedSet.has(entryId));
  if (entriesToBuild.length === 0) {
    return {
      tournamentId,
      eventId,
      totalEntries: entryIds.length,
      updated: 0,
      skipped: 0,
      errors: 0,
      requiredUnits: 0,
      reusedUnits: reusedEntryIds.length,
      succeededUnits: 0,
      failedUnits: 0,
    };
  }

  const eventLiveAuthority = finalizationCutoff
    ? null
    : await loadFreshEventLiveAuthoritySnapshot(season, eventId);
  const eventLives = finalizationCutoff
    ? await eventLiveRepository.findFinalizedByEventId(season, eventId)
    : (eventLiveAuthority?.eventLives ?? []);
  const activeEventLiveCheckedAt = eventLiveAuthority
    ? eventLiveAuthorityCheckedAt(eventLiveAuthority)
    : null;
  if (eventLives.length === 0) {
    const summary = summarizeMissingLeagueEventLiveData(
      tournamentId,
      eventId,
      entriesToBuild.length,
      reusedEntryIds.length,
    );
    throw new IncompleteDataSyncError(
      'League event results require persisted event data',
      summary.requiredUnits,
      summary.reusedUnits,
      summary.succeededUnits,
      summary.failedUnits,
    );
  }
  const eventLiveMap = new Map(eventLives.map((live) => [live.elementId, live]));
  const playerIds = uniqueNumbers(eventLives.map((live) => live.elementId));
  const players = await playerRepository.findByIds(season, playerIds);
  const elementTypeMap = new Map(players.map((player) => [player.id, player.type]));

  const [entryResults, staleRichEntryIds] = await Promise.all([
    entryEventResultsRepository.findByEventAndEntryIds(season, eventId, entriesToBuild),
    entryEventResultsRepository.findEntryIdsNeedingRichSync(
      season,
      entriesToBuild,
      eventId,
      requiredRichFreshAfter,
    ),
  ]);
  const entryResultsMap = new Map(entryResults.map((result) => [result.entryId, result]));
  const staleRichEntryIdSet = new Set(staleRichEntryIds);

  const missingEntryIds = entriesToBuild.filter((entryId) => {
    const result = entryResultsMap.get(entryId);
    return !result || !isCompleteEntryPicks(result.eventPicks) || staleRichEntryIdSet.has(entryId);
  });
  const concurrency = options?.concurrency ?? DEFAULT_CONCURRENCY;
  const missingPicksMap = new Map<
    number,
    { picks: RawFPLEntryEventPicksResponse; checkedAt: Date }
  >();
  let skipped = 0;

  if (missingEntryIds.length > 0) {
    const { results } = await fetchMissingEntryPicks(missingEntryIds, eventId, concurrency);
    for (const result of results) {
      if (result.picks && result.checkedAt) {
        missingPicksMap.set(result.entryId, {
          picks: result.picks,
          checkedAt: result.checkedAt,
        });
      }
    }
  }

  const inserts: LeagueEventResultEvidenceInsert[] = [];

  for (const entryId of entriesToBuild) {
    const entryInfo = entryInfoMap.get(entryId);
    if (!entryInfo) {
      skipped += 1;
      logInfo('Skipping league entry without entry info', {
        eventId,
        entryId,
        tournamentId,
        leagueId: tournament.leagueId,
        leagueType: tournament.leagueType,
      });
      continue;
    }

    const persistedEntryResult = entryResultsMap.get(entryId);
    const entryResult = !staleRichEntryIdSet.has(entryId) ? persistedEntryResult : undefined;
    const fallbackObservation = missingPicksMap.get(entryId);
    const fallbackPicks = fallbackObservation?.picks ?? null;
    const picksCheckedAt = fallbackObservation?.checkedAt ?? entryResult?.richSyncedAt ?? null;
    if (
      !finalizationCutoff &&
      (!activeEventLiveCheckedAt ||
        !picksCheckedAt ||
        !leagueEventLiveInputsAreFresh(activeEventLiveCheckedAt, picksCheckedAt.toISOString()))
    ) {
      skipped += 1;
      logInfo('Skipping league entry without a coherent event-live and picks observation', {
        eventId,
        entryId,
        tournamentId,
        liveCheckedAt: activeEventLiveCheckedAt,
        picksCheckedAt: picksCheckedAt?.toISOString() ?? null,
      });
      continue;
    }
    if (fallbackPicks) {
      try {
        validateAutomaticSubs(entryId, eventId, fallbackPicks);
      } catch (error) {
        skipped += 1;
        logError('Skipping league entry with invalid fallback automatic substitutions', error, {
          eventId,
          entryId,
          tournamentId,
        });
        continue;
      }
    }
    const data = buildEntryResultData(
      entryResult,
      fallbackPicks,
      eventId,
      eventLiveMap,
      elementTypeMap,
    );
    if (!data) {
      skipped += 1;
      logInfo('Skipping league entry without complete picks and event-live data', {
        eventId,
        entryId,
        tournamentId,
        leagueId: tournament.leagueId,
        leagueType: tournament.leagueType,
      });
      continue;
    }

    const combinedSourceCheckedAt =
      !finalizationCutoff && activeEventLiveCheckedAt && picksCheckedAt
        ? new Date(
            Math.min(Date.parse(activeEventLiveCheckedAt), picksCheckedAt.getTime()),
          ).toISOString()
        : requiredRichFreshAfter;
    inserts.push({
      leagueId: tournament.leagueId,
      leagueType: tournament.leagueType,
      eventId,
      entryId,
      entryName: entryInfo.entryName,
      playerName: entryInfo.playerName,
      overallPoints: data.overallPoints,
      overallRank: data.overallRank,
      teamValue: data.teamValue,
      bank: data.bank,
      eventPoints: data.eventPoints,
      eventTransfers: data.eventTransfers,
      eventTransfersCost: data.eventTransfersCost,
      eventNetPoints: data.eventNetPoints,
      eventBenchPoints: data.eventBenchPoints,
      eventAutoSubPoints: data.eventAutoSubPoints,
      eventRank: data.eventRank,
      eventChip: data.eventChip,
      captainElementId: data.captainId,
      captainPoints: data.captainPoints,
      captainBlank: data.captainBlank,
      viceCaptainElementId: data.viceCaptainId,
      viceCaptainPoints: data.viceCaptainPoints,
      viceCaptainBlank: data.viceCaptainBlank,
      playedCaptainElementId: data.playedCaptainId,
      highestScoreElementId: data.highestScoreElementId,
      highestScorePoints: data.highestScorePoints,
      highestScoreBlank: data.highestScoreBlank,
      sourceCheckedAt: combinedSourceCheckedAt,
    });
  }

  if (
    !finalizationCutoff &&
    (!activeEventLiveCheckedAt || !eventLiveHeartbeatIsFresh(activeEventLiveCheckedAt))
  ) {
    const summary = summarizeMissingLeagueEventLiveData(
      tournamentId,
      eventId,
      entriesToBuild.length,
      reusedEntryIds.length,
    );
    throw new IncompleteDataSyncError(
      'League event results require a fresh official event-live heartbeat',
      summary.requiredUnits,
      summary.reusedUnits,
      summary.succeededUnits,
      summary.failedUnits,
    );
  }

  const batchSize = 500;
  let updated = 0;

  for (let index = 0; index < inserts.length; index += batchSize) {
    const batch = inserts.slice(index, index + batchSize);
    updated += await leagueEventResultsRepository.upsertBatch(season, batch);
  }

  const builtEntryIds = new Set(inserts.map((insert) => insert.entryId));
  const missingBuiltEntryIds = findMissingLeagueResultEntryIds(entriesToBuild, builtEntryIds);
  const builtEntryIdList = [...builtEntryIds];
  const missingWrittenEntryIds = finalizationCutoff
    ? findMissingLeagueResultEntryIds(
        builtEntryIdList,
        new Set(
          builtEntryIdList.length > 0
            ? await leagueEventResultsRepository.findEntryIdsByLeagueEvent(
                season,
                tournament.leagueId,
                tournament.leagueType,
                eventId,
                builtEntryIdList,
                requiredRichFreshAfter,
              )
            : [],
        ),
      )
    : findMissingLeagueResultSourceCheckpoints(
        inserts,
        builtEntryIdList.length > 0
          ? await leagueEventResultsRepository.findSourceCheckpointsByLeagueEvent(
              season,
              tournament.leagueId,
              tournament.leagueType,
              eventId,
              builtEntryIdList,
            )
          : [],
      );
  const missingPersistedEntryIds = uniqueNumbers([
    ...missingBuiltEntryIds,
    ...missingWrittenEntryIds,
  ]);
  const succeeded = entriesToBuild.length - missingPersistedEntryIds.length;
  const errors = missingPersistedEntryIds.length;

  logInfo('League event results sync completed for tournament', {
    eventId,
    tournamentId,
    totalEntries: entryIds.length,
    updated,
    skipped,
    reused: reusedEntryIds.length,
    errors,
  });

  // A guarded upsert may legitimately affect zero rows when a newer
  // overlapping attempt already published the canonical result. The
  // post-write checkpoint audit is authoritative for convergence.
  if (errors > 0) {
    throw new IncompleteDataSyncError(
      'League event results did not converge for every tournament entry',
      entriesToBuild.length,
      reusedEntryIds.length,
      succeeded,
      errors,
    );
  }

  return {
    tournamentId,
    eventId,
    totalEntries: entryIds.length,
    updated,
    skipped,
    errors,
    requiredUnits: entriesToBuild.length,
    reusedUnits: reusedEntryIds.length,
    succeededUnits: succeeded,
    failedUnits: errors,
  };
}
