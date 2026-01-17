import { fplClient } from '../clients/fpl';
import {
  type DbEntryEventResult,
  type DbEventLive,
  type DbLeagueEventResultInsert,
} from '../db/schemas/index.schema';
import { entryEventResultsRepository } from '../repositories/entry-event-results';
import { entryInfoRepository } from '../repositories/entry-infos';
import { eventLiveRepository } from '../repositories/event-lives';
import { leagueEventResultsRepository } from '../repositories/league-event-results';
import { playerRepository } from '../repositories/players';
import { tournamentEntryRepository } from '../repositories/tournament-entries';
import {
  tournamentInfoRepository,
  type TournamentInfoSummary,
} from '../repositories/tournament-infos';
import type { RawFPLEntryEventPickItem, RawFPLEntryEventPicksResponse } from '../types';
import { logError, logInfo } from '../utils/logger';

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

function uniqueNumbers(values: number[]): number[] {
  return Array.from(new Set(values));
}

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

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  handler: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  const results = new Array<R>(items.length);
  let index = 0;

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      results[currentIndex] = await handler(items[currentIndex]);
    }
  });

  await Promise.all(workers);
  return results;
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

async function fetchLeagueEntryIds(tournament: TournamentInfoSummary): Promise<number[]> {
  const maxEntries = tournament.totalTeamNum > 0 ? tournament.totalTeamNum : undefined;
  const entryIds: number[] = [];
  let page = 1;
  let hasNext = true;

  while (hasNext) {
    const response =
      tournament.leagueType === 'classic'
        ? await fplClient.getLeagueClassicStandings(tournament.leagueId, page)
        : await fplClient.getLeagueH2HStandings(tournament.leagueId, page);

    const pageEntries = response.standings.results.map((result) => result.entry).filter(Boolean);
    entryIds.push(...pageEntries);

    if (maxEntries && entryIds.length >= maxEntries) {
      break;
    }

    hasNext = response.standings.has_next;
    page += 1;
  }

  const uniqueEntryIds = uniqueNumbers(entryIds);
  if (maxEntries) {
    return uniqueEntryIds.slice(0, maxEntries);
  }

  return uniqueEntryIds;
}

async function resolveTournamentEntries(tournament: TournamentInfoSummary): Promise<number[]> {
  const storedEntries = await tournamentEntryRepository.findEntryIdsByTournamentId(tournament.id);
  if (storedEntries.length > 0) {
    return uniqueNumbers(storedEntries);
  }

  return fetchLeagueEntryIds(tournament);
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

function buildEntryResultData(
  entryResult: DbEntryEventResult | undefined,
  fallbackPicks: RawFPLEntryEventPicksResponse | null,
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
  const picks = entryResult ? normalizePicks(entryResult.eventPicks) : (fallbackPicks?.picks ?? []);
  if (picks.length === 0) {
    return null;
  }

  const autoSubs = entryResult
    ? normalizeAutoSubs(entryResult.eventAutoSub)
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
  const eventChip = entryResult?.eventChip ?? fallbackPicks?.active_chip ?? null;
  const overallPoints =
    entryResult?.overallPoints ?? fallbackPicks?.entry_history.total_points ?? 0;
  const overallRank = entryResult?.overallRank ?? fallbackPicks?.entry_history.overall_rank ?? 0;
  const teamValue = entryResult?.teamValue ?? fallbackPicks?.entry_history.value ?? null;
  const bank = entryResult?.bank ?? fallbackPicks?.entry_history.bank ?? null;

  const captainPick = picks.find((pick) => pick.is_captain) ?? null;
  const vicePick = picks.find((pick) => pick.is_vice_captain) ?? null;
  const captainId = captainPick?.element ?? null;
  const viceCaptainId = vicePick?.element ?? null;
  const captainLive = captainId ? eventLiveMap.get(captainId) : undefined;
  const viceLive = viceCaptainId ? eventLiveMap.get(viceCaptainId) : undefined;
  const captainMultiplier = captainPick?.multiplier ?? 1;
  const captainPoints = captainId ? (captainLive?.totalPoints ?? 0) * captainMultiplier : null;
  const viceCaptainPoints = viceCaptainId ? (viceLive?.totalPoints ?? 0) : null;
  const captainBlank = isBlank(
    captainLive,
    captainId ? (elementTypeMap.get(captainId) ?? null) : null,
  );
  const viceCaptainBlank = isBlank(
    viceLive,
    viceCaptainId ? (elementTypeMap.get(viceCaptainId) ?? null) : null,
  );

  let playedCaptainId = captainId;
  if (captainId && viceCaptainId) {
    const captainMinutes = captainLive?.minutes ?? 0;
    const viceMinutes = viceLive?.minutes ?? 0;
    if (captainMinutes === 0 && viceMinutes > 0) {
      playedCaptainId = viceCaptainId;
    }
  }

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

export async function syncLeagueEventResultsByTournament(
  tournamentId: number,
  eventId: number,
  options?: { concurrency?: number },
): Promise<{
  tournamentId: number;
  eventId: number;
  totalEntries: number;
  updated: number;
  skipped: number;
}> {
  logInfo('Starting league event results sync for tournament', { tournamentId, eventId });

  const tournament = await tournamentInfoRepository.findById(tournamentId);
  if (!tournament) {
    throw new Error(`Tournament ${tournamentId} not found`);
  }

  const entryIds = await resolveTournamentEntries(tournament);
  const entryInfos = await entryInfoRepository.findByIds(entryIds);
  const entryInfoMap = new Map(entryInfos.map((info) => [info.id, info]));

  const eventLives = await eventLiveRepository.findByEventId(eventId);
  if (eventLives.length === 0) {
    logInfo('No event live data found for league event results', { eventId, tournamentId });
    return { tournamentId, eventId, totalEntries: 0, updated: 0, skipped: 0 };
  }
  const eventLiveMap = new Map(eventLives.map((live) => [live.elementId, live]));
  const playerIds = uniqueNumbers(eventLives.map((live) => live.elementId));
  const players = await playerRepository.findByIds(playerIds);
  const elementTypeMap = new Map(players.map((player) => [player.id, player.type]));

  const entryResults = await entryEventResultsRepository.findByEventAndEntryIds(eventId, entryIds);
  const entryResultsMap = new Map(entryResults.map((result) => [result.entryId, result]));

  const missingEntryIds = entryIds.filter((entryId) => !entryResultsMap.has(entryId));
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

  const inserts: DbLeagueEventResultInsert[] = [];
  let totalEntries = 0;

  for (const entryId of entryIds) {
    totalEntries += 1;
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

    const entryResult = entryResultsMap.get(entryId);
    const fallbackPicks = missingPicksMap.get(entryId) ?? null;
    const data = buildEntryResultData(entryResult, fallbackPicks, eventLiveMap, elementTypeMap);
    if (!data) {
      skipped += 1;
      logInfo('Skipping league entry without picks data', {
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
    });
  }

  const batchSize = 500;
  let updated = 0;

  for (let index = 0; index < inserts.length; index += batchSize) {
    const batch = inserts.slice(index, index + batchSize);
    updated += await leagueEventResultsRepository.upsertBatch(batch);
  }

  logInfo('League event results sync completed for tournament', {
    eventId,
    tournamentId,
    totalEntries,
    updated,
    skipped,
  });

  return { tournamentId, eventId, totalEntries, updated, skipped };
}
