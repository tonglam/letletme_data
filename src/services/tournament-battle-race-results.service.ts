import { entryEventResultsRepository } from '../repositories/entry-event-results';
import { tournamentBattleGroupResultsRepository } from '../repositories/tournament-battle-group-results';
import { tournamentGroupRepository } from '../repositories/tournament-groups';
import { tournamentEntryRepository } from '../repositories/tournament-entries';
import {
  tournamentInfoRepository,
  type TournamentInfoSummary,
} from '../repositories/tournament-infos';
import { logError, logInfo } from '../utils/logger';

function groupRankKey(points: number, overallRank: number | null) {
  return `${points}-${overallRank ?? Number.MAX_SAFE_INTEGER}`;
}

function rankBattleGroups(groups: Array<{ groupPoints: number; overallRank: number | null }>) {
  const sorted = [...groups].sort((a, b) => {
    if (a.groupPoints !== b.groupPoints) {
      return b.groupPoints - a.groupPoints;
    }
    const rankA = a.overallRank ?? Number.MAX_SAFE_INTEGER;
    const rankB = b.overallRank ?? Number.MAX_SAFE_INTEGER;
    return rankA - rankB;
  });

  const rankMap = new Map<string, number>();
  sorted.forEach((entry, index) => {
    rankMap.set(groupRankKey(entry.groupPoints, entry.overallRank), index + 1);
  });

  return rankMap;
}

function matchPoints(homeNet: number, awayNet: number) {
  if (homeNet > awayNet) return 3;
  if (homeNet < awayNet) return 0;
  return 1;
}

async function syncBattleRaceForTournament(
  tournament: TournamentInfoSummary,
  eventId: number,
): Promise<{ updatedGroups: number; updatedResults: number; skipped: number }> {
  if (!tournament.groupStartedEventId || !tournament.groupEndedEventId) {
    logInfo('Skipping battle race tournament without group window', {
      tournamentId: tournament.id,
    });
    return { updatedGroups: 0, updatedResults: 0, skipped: 0 };
  }

  const entryIds = await tournamentEntryRepository.findEntryIdsByTournamentId(tournament.id);
  if (entryIds.length === 0) {
    logInfo('No tournament entries found for battle race results', { tournamentId: tournament.id });
    return { updatedGroups: 0, updatedResults: 0, skipped: 0 };
  }

  const eventResults = await entryEventResultsRepository.findByEventAndEntryIds(eventId, entryIds);
  if (eventResults.length === 0) {
    logInfo('Entry event results missing for battle race', {
      tournamentId: tournament.id,
      eventId,
    });
    return { updatedGroups: 0, updatedResults: 0, skipped: entryIds.length };
  }
  const eventResultMap = new Map(eventResults.map((result) => [result.entryId, result]));
  const totalsMap = new Map(
    (
      await entryEventResultsRepository.aggregateTotalsByEntry(
        entryIds,
        tournament.groupStartedEventId,
        Math.min(eventId, tournament.groupEndedEventId),
      )
    ).map((row) => [row.entryId, row]),
  );

  const battleResults = await tournamentBattleGroupResultsRepository.findByTournamentAndEvent(
    tournament.id,
    eventId,
  );
  if (battleResults.length === 0) {
    logInfo('No battle group fixtures found for battle race', {
      tournamentId: tournament.id,
      eventId,
    });
    return { updatedGroups: 0, updatedResults: 0, skipped: entryIds.length };
  }

  const matchPointsByGroup = new Map<number, Map<number, number>>();
  const updatedBattleResults = battleResults.map((result) => {
    const homeEntry = result.homeEntryId;
    const awayEntry = result.awayEntryId;
    const homeResult = eventResultMap.get(homeEntry);
    const awayResult = eventResultMap.get(awayEntry);
    const homeNet = homeResult?.eventNetPoints ?? 0;
    const awayNet = awayResult?.eventNetPoints ?? 0;
    const homeMatchPoints = matchPoints(homeNet, awayNet);
    const awayMatchPoints = matchPoints(awayNet, homeNet);

    const groupMap = matchPointsByGroup.get(result.groupId) ?? new Map<number, number>();
    if (homeEntry) {
      groupMap.set(homeEntry, homeMatchPoints);
    }
    if (awayEntry) {
      groupMap.set(awayEntry, awayMatchPoints);
    }
    matchPointsByGroup.set(result.groupId, groupMap);

    return {
      ...result,
      homeNetPoints: homeNet,
      homeRank: homeResult?.eventRank ?? null,
      homeMatchPoints,
      awayNetPoints: awayNet,
      awayRank: awayResult?.eventRank ?? null,
      awayMatchPoints,
    };
  });

  const updatedGroups = [];
  let skipped = 0;

  for (const [groupId, pointsMap] of matchPointsByGroup.entries()) {
    const groupEntries = await tournamentGroupRepository.findByTournamentAndGroup(
      tournament.id,
      groupId,
    );
    const groupUpdates = groupEntries.map((group) => {
      const entryId = group.entryId;
      const eventResult = eventResultMap.get(entryId);
      if (!eventResult) {
        skipped += 1;
        return null;
      }

      const expectedPlayed = eventId - tournament.groupStartedEventId + 1;
      const alreadyPlayed = (group.played ?? 0) >= expectedPlayed;
      const matchPointsValue = pointsMap.get(entryId) ?? 0;
      let groupPoints = group.groupPoints ?? 0;
      let played = group.played ?? 0;
      let win = group.won ?? 0;
      let draw = group.drawn ?? 0;
      let lose = group.lost ?? 0;

      if (!alreadyPlayed) {
        groupPoints += matchPointsValue;
        played += 1;
        if (matchPointsValue === 3) {
          win += 1;
        } else if (matchPointsValue === 1) {
          draw += 1;
        } else if (matchPointsValue === 0) {
          lose += 1;
        }
      }

      const totals = totalsMap.get(entryId);
      return {
        id: group.id,
        tournamentId: group.tournamentId,
        groupId: group.groupId,
        groupName: group.groupName,
        groupIndex: group.groupIndex,
        entryId: group.entryId,
        startedEventId: group.startedEventId,
        endedEventId: group.endedEventId,
        groupPoints,
        groupRank: group.groupRank,
        played,
        won: win,
        drawn: draw,
        lost: lose,
        totalPoints: totals?.totalPoints ?? 0,
        totalTransfersCost: totals?.totalTransfersCost ?? 0,
        totalNetPoints: totals?.totalNetPoints ?? 0,
        qualified: group.qualified,
        overallRank: eventResult.overallRank,
        createdAt: group.createdAt,
      };
    });

    const filtered = groupUpdates.filter(Boolean) as typeof updatedGroups;
    const rankMap = rankBattleGroups(
      filtered.map((entry) => ({
        groupPoints: entry.groupPoints ?? 0,
        overallRank: entry.overallRank ?? null,
      })),
    );

    filtered.forEach((entry) => {
      const rank =
        rankMap.get(groupRankKey(entry.groupPoints ?? 0, entry.overallRank ?? null)) ?? 0;
      entry.groupRank = rank;
      if (tournament.groupQualifyNum) {
        entry.qualified = rank > 0 && rank <= tournament.groupQualifyNum ? 1 : 0;
      }
      updatedGroups.push(entry);
    });
  }

  const updatedGroupsCount = await tournamentGroupRepository.upsertBatch(updatedGroups);
  const updatedResultsCount =
    await tournamentBattleGroupResultsRepository.upsertBatch(updatedBattleResults);

  return { updatedGroups: updatedGroupsCount, updatedResults: updatedResultsCount, skipped };
}

export async function syncTournamentBattleRaceResults(
  eventId: number,
): Promise<{ eventId: number; updatedGroups: number; updatedResults: number; skipped: number }> {
  logInfo('Starting tournament battle race results sync', { eventId });

  const tournaments = await tournamentInfoRepository.findBattleRaceByEvent(eventId);
  if (tournaments.length === 0) {
    logInfo('No battle race tournaments found', { eventId });
    return { eventId, updatedGroups: 0, updatedResults: 0, skipped: 0 };
  }

  let updatedGroups = 0;
  let updatedResults = 0;
  let skipped = 0;

  for (const tournament of tournaments) {
    try {
      const result = await syncBattleRaceForTournament(tournament, eventId);
      updatedGroups += result.updatedGroups;
      updatedResults += result.updatedResults;
      skipped += result.skipped;
    } catch (error) {
      logError('Failed to sync battle race results', error, {
        tournamentId: tournament.id,
        eventId,
      });
    }
  }

  logInfo('Tournament battle race results sync completed', {
    eventId,
    updatedGroups,
    updatedResults,
    skipped,
  });

  return { eventId, updatedGroups, updatedResults, skipped };
}
