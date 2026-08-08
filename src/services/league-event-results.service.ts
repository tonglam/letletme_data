import { fplClient } from '../clients/fpl';
import {
  type DbEntryEventResult,
  type DbEventLive,
  type DbLeagueEventResultInsert,
} from '../db/schemas/index.schema';
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
import { getActiveCacheSeason } from '../cache/cache-season';
import {
  leagueEventResultsRepository,
  type LeagueEventResultEvidenceInsert,
} from '../repositories/league-event-results';
import { playerRepository } from '../repositories/players';
import { tournamentInfoRepository } from '../repositories/tournament-infos';
import { readCoreSnapshotOrderingTimestamp } from './core-snapshot-persistence.service';
import type { RawFPLEntryEventPickItem, RawFPLEntryEventPicksResponse } from '../types';
import { mapWithConcurrency, uniqueNumbers } from '../utils/async';
import { IncompleteDataSyncError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';
import { resolveTournamentEntryIds } from './tournament-entry-resolver.service';
import { resolveRichResultFreshnessCutoff } from '../domain/entry-sync';

const DEFAULT_CONCURRENCY = 5;

type AutoSubItem = {
  element_in?: number | null;
  elementIn?: number | null;
};

type MissingPickResult = {
  entryId: number;
  picks: RawFPLEntryEventPicksResponse | null;
};

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

function getAutoSubPoints(autoSubs: AutoSubItem[], eventLiveMap: Map<number, DbEventLive>): number {
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
  eventLiveMap: Map<number, DbEventLive>,
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

function isBlank(eventLive: DbEventLive | undefined, elementType: number | null): boolean {
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

function resolveEventNetPoints(eventPoints: number, transfersCost: number): number {
  return eventPoints - transfersCost;
}

function latestDate(...dates: Array<Date | null | undefined>): Date | undefined {
  const validDates = dates.filter(
    (date): date is Date => date instanceof Date && !Number.isNaN(date.getTime()),
  );
  if (validDates.length === 0) return undefined;
  return new Date(Math.max(...validDates.map((date) => date.getTime())));
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
      return { entryId, picks } satisfies MissingPickResult;
    } catch (error) {
      errors += 1;
      logError('Failed to fetch entry event picks for league results', error, {
        entryId,
        eventId,
      });
      return { entryId, picks: null } satisfies MissingPickResult;
    }
  });

  return { results, errors };
}

export function buildEntryResultData(
  entryResult: DbEntryEventResult | undefined,
  fallbackPicks: RawFPLEntryEventPicksResponse | null,
  eventId: number,
  eventLiveMap: Map<number, DbEventLive>,
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

  const eventPoints = entryResult?.eventPoints ?? fallbackPicks?.entry_history.points ?? 0;
  const eventTransfers =
    entryResult?.eventTransfers ?? fallbackPicks?.entry_history.event_transfers ?? 0;
  const eventTransfersCost =
    entryResult?.eventTransfersCost ?? fallbackPicks?.entry_history.event_transfers_cost ?? 0;
  const eventNetPoints =
    entryResult?.eventNetPoints ?? resolveEventNetPoints(eventPoints, eventTransfersCost);
  const eventBenchPoints =
    entryResult?.eventBenchPoints ?? fallbackPicks?.entry_history.points_on_bench ?? null;
  const eventAutoSubPoints =
    entryResult?.eventAutoSubPoints ?? getAutoSubPoints(autoSubs, eventLiveMap);
  const eventRank = entryResult?.eventRank ?? fallbackPicks?.entry_history.rank ?? null;
  const eventChip = entryResult?.eventChip ?? toNullableDbChip(fallbackPicks?.active_chip);
  const overallPoints =
    entryResult?.overallPoints ?? fallbackPicks?.entry_history.total_points ?? 0;
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

export async function syncLeagueEventResultsByTournament(
  tournamentId: number,
  eventId: number,
  options?: { concurrency?: number; season?: string },
): Promise<LeagueEventResultsSyncSummary> {
  logInfo('Starting league event results sync for tournament', { tournamentId, eventId });
  // Use one database-clock token before any source reads. It is comparable
  // across workers and remains the evidence timestamp even when a slower
  // attempt finishes after a newer result-slot run.
  const sourceCheckedAt = await readCoreSnapshotOrderingTimestamp();

  const [tournament, event] = await Promise.all([
    tournamentInfoRepository.findById(tournamentId),
    eventRepository.findById(eventId),
  ]);
  if (!tournament) {
    throw new Error(`Tournament ${tournamentId} not found`);
  }

  // A finalized event establishes a canonical evidence boundary. Require the
  // stricter of that boundary and this attempt's database-clock token so the
  // reuse, write, and post-write audit all share one clock domain.
  const finalizationCutoff = resolveRichResultFreshnessCutoff(event);
  const requiredRichFreshAfter = latestDate(sourceCheckedAt, finalizationCutoff);
  const checkpointSeason = options?.season ?? (await getActiveCacheSeason());

  const entryIds = await resolveTournamentEntryIds(tournament);
  const reusedEntryIds = requiredRichFreshAfter
    ? await leagueEventResultsRepository.findEntryIdsByLeagueEvent(
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

  const entryInfos = await entryInfoRepository.findByIds(entriesToBuild);
  const entryInfoMap = new Map(entryInfos.map((info) => [info.id, info]));

  const eventLives = finalizationCutoff
    ? await eventLiveRepository.findFinalizedByEventIdForSeason(eventId, checkpointSeason)
    : await eventLiveRepository.findByEventId(eventId);
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
  const players = await playerRepository.findByIds(playerIds);
  const elementTypeMap = new Map(players.map((player) => [player.id, player.type]));

  const entryResults = await entryEventResultsRepository.findByEventAndEntryIds(
    eventId,
    entriesToBuild,
  );
  const entryResultsMap = new Map(entryResults.map((result) => [result.entryId, result]));

  const missingEntryIds = entriesToBuild.filter((entryId) => {
    const result = entryResultsMap.get(entryId);
    return (
      !result ||
      !isCompleteEntryPicks(result.eventPicks) ||
      !isEntryResultRichEnough(result, requiredRichFreshAfter)
    );
  });
  const concurrency = options?.concurrency ?? DEFAULT_CONCURRENCY;
  const missingPicksMap = new Map<number, RawFPLEntryEventPicksResponse>();
  let skipped = 0;

  if (missingEntryIds.length > 0) {
    const { results } = await fetchMissingEntryPicks(missingEntryIds, eventId, concurrency);
    for (const result of results) {
      if (result.picks) {
        missingPicksMap.set(result.entryId, result.picks);
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
    const entryResult = isEntryResultRichEnough(persistedEntryResult, requiredRichFreshAfter)
      ? persistedEntryResult
      : undefined;
    const fallbackPicks = missingPicksMap.get(entryId) ?? null;
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
      captainId: data.captainId,
      captainPoints: data.captainPoints,
      captainBlank: data.captainBlank,
      viceCaptainId: data.viceCaptainId,
      viceCaptainPoints: data.viceCaptainPoints,
      viceCaptainBlank: data.viceCaptainBlank,
      playedCaptainId: data.playedCaptainId,
      highestScoreElementId: data.highestScoreElementId,
      highestScorePoints: data.highestScorePoints,
      highestScoreBlank: data.highestScoreBlank,
      sourceCheckedAt,
    });
  }

  const batchSize = 500;
  let updated = 0;

  for (let index = 0; index < inserts.length; index += batchSize) {
    const batch = inserts.slice(index, index + batchSize);
    updated += await leagueEventResultsRepository.upsertBatch(batch, checkpointSeason);
  }

  const auditCutoff = requiredRichFreshAfter ?? sourceCheckedAt;
  const persistedEntryIds = new Set(
    await leagueEventResultsRepository.findEntryIdsByLeagueEvent(
      tournament.leagueId,
      tournament.leagueType,
      eventId,
      entriesToBuild,
      auditCutoff,
    ),
  );
  const missingPersistedEntryIds = findMissingLeagueResultEntryIds(
    entriesToBuild,
    persistedEntryIds,
  );
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
