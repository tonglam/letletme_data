import { entryEventResultsRepository } from '../repositories/entry-event-results';
import { tournamentEntryRepository } from '../repositories/tournament-entries';
import { tournamentGroupRepository } from '../repositories/tournament-groups';
import { tournamentPointsGroupResultsRepository } from '../repositories/tournament-points-group-results';
import {
  tournamentInfoRepository,
  type TournamentInfoSummary,
} from '../repositories/tournament-infos';
import { logError, logInfo } from '../utils/logger';

type EntryTotals = {
  totalPoints: number;
  totalTransfersCost: number;
  totalNetPoints: number;
};

function groupRankKey(totalNetPoints: number, overallRank: number | null) {
  return `${totalNetPoints}-${overallRank ?? Number.MAX_SAFE_INTEGER}`;
}

function rankGroups(
  groups: Array<{ entryId: number; totalNetPoints: number; overallRank: number | null }>,
) {
  const sorted = [...groups].sort((a, b) => {
    if (a.totalNetPoints !== b.totalNetPoints) {
      return b.totalNetPoints - a.totalNetPoints;
    }
    const rankA = a.overallRank ?? Number.MAX_SAFE_INTEGER;
    const rankB = b.overallRank ?? Number.MAX_SAFE_INTEGER;
    return rankA - rankB;
  });

  const rankMap = new Map<string, number>();
  sorted.forEach((entry, index) => {
    rankMap.set(groupRankKey(entry.totalNetPoints, entry.overallRank), index + 1);
  });

  return rankMap;
}

async function loadTournamentEntryTotals(
  entryIds: number[],
  startEventId: number,
  endEventId: number,
): Promise<Map<number, EntryTotals>> {
  const totals = await entryEventResultsRepository.aggregateTotalsByEntry(
    entryIds,
    startEventId,
    endEventId,
  );
  return new Map(
    totals.map((row) => [
      row.entryId,
      {
        totalPoints: row.totalPoints,
        totalTransfersCost: row.totalTransfersCost,
        totalNetPoints: row.totalNetPoints,
      },
    ]),
  );
}

async function syncTournamentPointsRaceResultsForTournament(
  tournament: TournamentInfoSummary,
  eventId: number,
): Promise<{ updatedGroups: number; updatedResults: number; skipped: number }> {
  if (!tournament.groupStartedEventId || !tournament.groupEndedEventId) {
    logInfo('Skipping points race tournament without group window', {
      tournamentId: tournament.id,
    });
    return { updatedGroups: 0, updatedResults: 0, skipped: 0 };
  }

  const entryIds = await tournamentEntryRepository.findEntryIdsByTournamentId(tournament.id);
  if (entryIds.length === 0) {
    logInfo('No tournament entries found for points race results', { tournamentId: tournament.id });
    return { updatedGroups: 0, updatedResults: 0, skipped: 0 };
  }

  const eventResults = await entryEventResultsRepository.findByEventAndEntryIds(eventId, entryIds);
  if (eventResults.length === 0) {
    logInfo('Entry event results missing for points race', {
      tournamentId: tournament.id,
      eventId,
    });
    return { updatedGroups: 0, updatedResults: 0, skipped: entryIds.length };
  }
  const eventResultMap = new Map(eventResults.map((result) => [result.entryId, result]));

  const tournamentGroups = await tournamentGroupRepository.findByTournamentAndEntries(
    tournament.id,
    entryIds,
  );
  if (tournamentGroups.length === 0) {
    logInfo('Tournament group records missing for points race', { tournamentId: tournament.id });
    return { updatedGroups: 0, updatedResults: 0, skipped: entryIds.length };
  }

  const totalsMap = await loadTournamentEntryTotals(
    entryIds,
    tournament.groupStartedEventId,
    Math.min(eventId, tournament.groupEndedEventId),
  );

  const pointsGroupResults = await tournamentPointsGroupResultsRepository.findByTournamentAndEvent(
    tournament.id,
    eventId,
    entryIds,
  );
  const pointsGroupResultsMap = new Map(
    pointsGroupResults.map((result) => [result.entryId, result]),
  );

  const updatedGroups = [];
  const updatedResults = [];
  let skipped = 0;

  const groupsByGroupId = new Map<
    number,
    Array<{ entryId: number; totalNetPoints: number; overallRank: number | null }>
  >();

  for (const group of tournamentGroups) {
    const entryId = group.entryId;
    const eventResult = eventResultMap.get(entryId);
    if (!eventResult) {
      skipped += 1;
      continue;
    }

    const totals = totalsMap.get(entryId) ?? {
      totalPoints: 0,
      totalTransfersCost: 0,
      totalNetPoints: 0,
    };

    const play = eventId - tournament.groupStartedEventId + 1;
    const groupUpdate = {
      id: group.id,
      tournamentId: group.tournamentId,
      groupId: group.groupId,
      groupName: group.groupName,
      groupIndex: group.groupIndex,
      entryId: group.entryId,
      startedEventId: group.startedEventId,
      endedEventId: group.endedEventId,
      groupPoints: totals.totalNetPoints,
      groupRank: group.groupRank,
      played: play,
      won: group.won,
      drawn: group.drawn,
      lost: group.lost,
      totalPoints: totals.totalPoints,
      totalTransfersCost: totals.totalTransfersCost,
      totalNetPoints: totals.totalNetPoints,
      qualified: group.qualified,
      overallRank: eventResult.overallRank,
      createdAt: group.createdAt,
    };
    updatedGroups.push(groupUpdate);

    const groupList = groupsByGroupId.get(group.groupId) ?? [];
    groupList.push({
      entryId,
      totalNetPoints: totals.totalNetPoints,
      overallRank: eventResult.overallRank,
    });
    groupsByGroupId.set(group.groupId, groupList);

    const existingPoints = pointsGroupResultsMap.get(entryId);
    const eventNetPoints = eventResult.eventPoints - eventResult.eventTransfersCost;
    updatedResults.push({
      id: existingPoints?.id,
      tournamentId: group.tournamentId,
      groupId: group.groupId,
      eventId,
      entryId,
      eventGroupRank: existingPoints?.eventGroupRank,
      eventPoints: eventResult.eventPoints,
      eventCost: eventResult.eventTransfersCost,
      eventNetPoints,
      eventRank: eventResult.eventRank,
      createdAt: existingPoints?.createdAt ?? new Date(),
    });
  }

  const rankLookup = new Map<number, Map<string, number>>();
  for (const [groupId, groupEntries] of groupsByGroupId.entries()) {
    rankLookup.set(groupId, rankGroups(groupEntries));
  }

  for (const group of updatedGroups) {
    const groupRankMap = rankLookup.get(group.groupId) ?? new Map();
    const rankKey = groupRankKey(group.totalNetPoints ?? 0, group.overallRank ?? null);
    const rank = groupRankMap.get(rankKey) ?? 0;
    group.groupRank = rank;
    group.groupPoints = group.totalNetPoints;
  }

  for (const result of updatedResults) {
    const groupRankMap = rankLookup.get(result.groupId) ?? new Map();
    const totals = totalsMap.get(result.entryId) ?? {
      totalPoints: 0,
      totalTransfersCost: 0,
      totalNetPoints: 0,
    };
    const rankKey = groupRankKey(
      totals.totalNetPoints,
      eventResultMap.get(result.entryId)?.overallRank ?? null,
    );
    result.eventGroupRank = groupRankMap.get(rankKey) ?? result.eventGroupRank ?? 0;
  }

  const updatedGroupsCount = await tournamentGroupRepository.upsertBatch(updatedGroups);
  const updatedResultsCount =
    await tournamentPointsGroupResultsRepository.upsertBatch(updatedResults);

  return { updatedGroups: updatedGroupsCount, updatedResults: updatedResultsCount, skipped };
}

export async function syncTournamentPointsRaceResults(
  eventId: number,
): Promise<{ eventId: number; updatedGroups: number; updatedResults: number; skipped: number }> {
  logInfo('Starting tournament points race results sync', { eventId });

  const tournaments = await tournamentInfoRepository.findPointsRaceByEvent(eventId);
  if (tournaments.length === 0) {
    logInfo('No points race tournaments found', { eventId });
    return { eventId, updatedGroups: 0, updatedResults: 0, skipped: 0 };
  }

  let updatedGroups = 0;
  let updatedResults = 0;
  let skipped = 0;

  for (const tournament of tournaments) {
    try {
      const result = await syncTournamentPointsRaceResultsForTournament(tournament, eventId);
      updatedGroups += result.updatedGroups;
      updatedResults += result.updatedResults;
      skipped += result.skipped;
    } catch (error) {
      logError('Failed to sync points race results', error, {
        tournamentId: tournament.id,
        eventId,
      });
    }
  }

  logInfo('Tournament points race results sync completed', {
    eventId,
    updatedGroups,
    updatedResults,
    skipped,
  });

  return { eventId, updatedGroups, updatedResults, skipped };
}
