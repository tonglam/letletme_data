import type { RawFPLEntryEventPickItem } from '../types';
import { entryEventResultsRepository } from '../repositories/entry-event-results';
import { eventLiveRepository } from '../repositories/event-lives';
import { tournamentEntryRepository } from '../repositories/tournament-entries';
import {
  tournamentInfoRepository,
  type TournamentInfoSummary,
} from '../repositories/tournament-infos';
import { tournamentKnockoutResultsRepository } from '../repositories/tournament-knockout-results';
import { tournamentKnockoutsRepository } from '../repositories/tournament-knockouts';
import { logError, logInfo } from '../utils/logger';

type KnockoutRoundSummary = {
  matchId: number;
  round: number;
  nextMatchId: number | null;
  roundWinner: number | null;
  nextRound: number | null;
  nextHomeEntryId: number | null;
  nextAwayEntryId: number | null;
};

function normalizePicks(raw: unknown): RawFPLEntryEventPickItem[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw as RawFPLEntryEventPickItem[];
}

function pickElements(picks: RawFPLEntryEventPickItem[], chip: string | null) {
  if (chip === 'bboost') {
    return picks.map((pick) => pick.element);
  }
  return picks.filter((pick) => pick.position <= 11).map((pick) => pick.element);
}

function sumGoals(
  elementIds: number[],
  liveMap: Map<number, { goalsScored: number | null; goalsConceded: number | null }>,
): { scored: number; conceded: number } {
  return elementIds.reduce(
    (acc, elementId) => {
      const live = liveMap.get(elementId);
      acc.scored += live?.goalsScored ?? 0;
      acc.conceded += live?.goalsConceded ?? 0;
      return acc;
    },
    { scored: 0, conceded: 0 },
  );
}

function resolveMatchWinner(
  homeEntryId: number | null,
  awayEntryId: number | null,
  homeNetPoints: number,
  awayNetPoints: number,
  homeGoalsScored: number,
  awayGoalsScored: number,
  homeGoalsConceded: number,
  awayGoalsConceded: number,
): number | null {
  if (!homeEntryId) return awayEntryId;
  if (!awayEntryId) return homeEntryId;

  if (homeNetPoints > awayNetPoints) return homeEntryId;
  if (homeNetPoints < awayNetPoints) return awayEntryId;

  if (homeGoalsScored > awayGoalsScored) return homeEntryId;
  if (homeGoalsScored < awayGoalsScored) return awayEntryId;

  if (homeGoalsConceded < awayGoalsConceded) return homeEntryId;
  if (homeGoalsConceded > awayGoalsConceded) return awayEntryId;

  return Math.random() < 0.5 ? homeEntryId : awayEntryId;
}

function calcEntryWinningNum(
  results: Array<{
    homeEntryId: number | null;
    awayEntryId: number | null;
    homeNetPoints: number | null;
    awayNetPoints: number | null;
  }>,
  entryId: number | null,
): number {
  if (!entryId) {
    return 0;
  }

  let winningNum = 0;
  for (const result of results) {
    const homeNet = result.homeNetPoints ?? 0;
    const awayNet = result.awayNetPoints ?? 0;
    if (result.homeEntryId === entryId && homeNet > awayNet) {
      winningNum += 1;
    } else if (result.awayEntryId === entryId && awayNet > homeNet) {
      winningNum += 1;
    } else if (
      homeNet === awayNet &&
      (result.homeEntryId === entryId || result.awayEntryId === entryId)
    ) {
      winningNum += 0.5;
    }
  }
  return winningNum;
}

function resolveRoundWinner(
  matchResults: Array<{
    matchWinner: number | null;
    homeEntryId: number | null;
    awayEntryId: number | null;
    homeNetPoints: number | null;
    awayNetPoints: number | null;
    homeGoalsScored: number | null;
    homeGoalsConceded: number | null;
    awayGoalsScored: number | null;
    awayGoalsConceded: number | null;
  }>,
  homeEntryId: number | null,
  awayEntryId: number | null,
): number | null {
  if (matchResults.length === 0) {
    return null;
  }

  if (matchResults.length === 1) {
    return matchResults[0].matchWinner ?? null;
  }

  const winners = new Set(matchResults.map((result) => result.matchWinner).filter(Boolean));
  if (winners.size === 1) {
    return [...winners][0] ?? null;
  }

  const totals = matchResults.reduce(
    (acc, result) => {
      if (result.homeEntryId === homeEntryId) {
        acc.homeNet += result.homeNetPoints ?? 0;
        acc.homeGoalsScored += result.homeGoalsScored ?? 0;
        acc.homeGoalsConceded += result.homeGoalsConceded ?? 0;
      }
      if (result.awayEntryId === homeEntryId) {
        acc.homeNet += result.awayNetPoints ?? 0;
        acc.homeGoalsScored += result.awayGoalsScored ?? 0;
        acc.homeGoalsConceded += result.awayGoalsConceded ?? 0;
      }
      if (result.homeEntryId === awayEntryId) {
        acc.awayNet += result.homeNetPoints ?? 0;
        acc.awayGoalsScored += result.homeGoalsScored ?? 0;
        acc.awayGoalsConceded += result.homeGoalsConceded ?? 0;
      }
      if (result.awayEntryId === awayEntryId) {
        acc.awayNet += result.awayNetPoints ?? 0;
        acc.awayGoalsScored += result.awayGoalsScored ?? 0;
        acc.awayGoalsConceded += result.awayGoalsConceded ?? 0;
      }
      return acc;
    },
    {
      homeNet: 0,
      awayNet: 0,
      homeGoalsScored: 0,
      awayGoalsScored: 0,
      homeGoalsConceded: 0,
      awayGoalsConceded: 0,
    },
  );

  return resolveMatchWinner(
    homeEntryId,
    awayEntryId,
    totals.homeNet,
    totals.awayNet,
    totals.homeGoalsScored,
    totals.awayGoalsScored,
    totals.homeGoalsConceded,
    totals.awayGoalsConceded,
  );
}

async function syncKnockoutForTournament(
  tournament: TournamentInfoSummary,
  eventId: number,
): Promise<{ updatedResults: number; updatedKnockouts: number; skipped: number }> {
  if (!tournament.knockoutStartedEventId || !tournament.knockoutEndedEventId) {
    logInfo('Skipping knockout tournament without knockout window', {
      tournamentId: tournament.id,
    });
    return { updatedResults: 0, updatedKnockouts: 0, skipped: 0 };
  }

  const entryIds = await tournamentEntryRepository.findEntryIdsByTournamentId(tournament.id);
  const eventResults = await entryEventResultsRepository.findByEventAndEntryIds(eventId, entryIds);
  if (eventResults.length === 0) {
    logInfo('Entry event results missing for knockout', { tournamentId: tournament.id, eventId });
    return { updatedResults: 0, updatedKnockouts: 0, skipped: entryIds.length };
  }
  const eventResultMap = new Map(eventResults.map((result) => [result.entryId, result]));

  const eventLives = await eventLiveRepository.findByEventId(eventId);
  if (eventLives.length === 0) {
    logInfo('Event live data missing for knockout', { tournamentId: tournament.id, eventId });
    return { updatedResults: 0, updatedKnockouts: 0, skipped: entryIds.length };
  }
  const liveMap = new Map(
    eventLives.map((live) => [
      live.elementId,
      { goalsScored: live.goalsScored, goalsConceded: live.goalsConceded },
    ]),
  );

  const knockoutResults = await tournamentKnockoutResultsRepository.findByTournamentAndEvent(
    tournament.id,
    eventId,
  );
  if (knockoutResults.length === 0) {
    logInfo('No knockout fixtures found for event', { tournamentId: tournament.id, eventId });
    return { updatedResults: 0, updatedKnockouts: 0, skipped: entryIds.length };
  }

  const updatedResults = knockoutResults.map((result) => {
    const homeEntryId = result.homeEntryId ?? null;
    const awayEntryId = result.awayEntryId ?? null;
    const homeResult = homeEntryId ? eventResultMap.get(homeEntryId) : undefined;
    const awayResult = awayEntryId ? eventResultMap.get(awayEntryId) : undefined;
    const homePicks = normalizePicks(homeResult?.eventPicks);
    const awayPicks = normalizePicks(awayResult?.eventPicks);
    const homeElements = pickElements(homePicks, homeResult?.eventChip ?? null);
    const awayElements = pickElements(awayPicks, awayResult?.eventChip ?? null);
    const homeGoals = sumGoals(homeElements, liveMap);
    const awayGoals = sumGoals(awayElements, liveMap);
    const homeNetPoints = homeResult?.eventNetPoints ?? 0;
    const awayNetPoints = awayResult?.eventNetPoints ?? 0;
    const matchWinner = resolveMatchWinner(
      homeEntryId,
      awayEntryId,
      homeNetPoints,
      awayNetPoints,
      homeGoals.scored,
      awayGoals.scored,
      homeGoals.conceded,
      awayGoals.conceded,
    );

    return {
      ...result,
      homeNetPoints,
      homeGoalsScored: homeGoals.scored,
      homeGoalsConceded: homeGoals.conceded,
      awayNetPoints,
      awayGoalsScored: awayGoals.scored,
      awayGoalsConceded: awayGoals.conceded,
      matchWinner,
    };
  });

  const updatedResultsCount = await tournamentKnockoutResultsRepository.upsertBatch(updatedResults);

  const matchIds = Array.from(new Set(updatedResults.map((result) => result.matchId)));
  const allMatchResults = await tournamentKnockoutResultsRepository.findByTournamentAndMatchIds(
    tournament.id,
    matchIds,
  );

  const matchResultsByMatch = new Map<number, typeof allMatchResults>();
  for (const result of allMatchResults) {
    const list = matchResultsByMatch.get(result.matchId) ?? [];
    list.push(result);
    matchResultsByMatch.set(result.matchId, list);
  }

  const knockouts = await tournamentKnockoutsRepository.findByTournamentAndEndedEvent(
    tournament.id,
    eventId,
  );
  const updatedKnockouts = [];
  const nextRoundMap = new Map<number, KnockoutRoundSummary>();

  for (const knockout of knockouts) {
    const results = matchResultsByMatch.get(knockout.matchId) ?? [];
    const homeEntryId = knockout.homeEntryId ?? null;
    const awayEntryId = knockout.awayEntryId ?? null;

    let homeNetPoints = 0;
    let awayNetPoints = 0;
    let homeGoalsScored = 0;
    let awayGoalsScored = 0;
    let homeGoalsConceded = 0;
    let awayGoalsConceded = 0;

    for (const result of results) {
      if (result.homeEntryId === homeEntryId) {
        homeNetPoints += result.homeNetPoints ?? 0;
        homeGoalsScored += result.homeGoalsScored ?? 0;
        homeGoalsConceded += result.homeGoalsConceded ?? 0;
      }
      if (result.awayEntryId === homeEntryId) {
        homeNetPoints += result.awayNetPoints ?? 0;
        homeGoalsScored += result.awayGoalsScored ?? 0;
        homeGoalsConceded += result.awayGoalsConceded ?? 0;
      }
      if (result.homeEntryId === awayEntryId) {
        awayNetPoints += result.homeNetPoints ?? 0;
        awayGoalsScored += result.homeGoalsScored ?? 0;
        awayGoalsConceded += result.homeGoalsConceded ?? 0;
      }
      if (result.awayEntryId === awayEntryId) {
        awayNetPoints += result.awayNetPoints ?? 0;
        awayGoalsScored += result.awayGoalsScored ?? 0;
        awayGoalsConceded += result.awayGoalsConceded ?? 0;
      }
    }

    const roundWinner = resolveRoundWinner(results, homeEntryId, awayEntryId);
    const homeWins = calcEntryWinningNum(results, homeEntryId);
    const awayWins = calcEntryWinningNum(results, awayEntryId);

    updatedKnockouts.push({
      ...knockout,
      homeNetPoints,
      homeGoalsScored,
      homeGoalsConceded,
      homeWins,
      awayNetPoints,
      awayGoalsScored,
      awayGoalsConceded,
      awayWins,
      roundWinner,
    });

    if (knockout.nextMatchId && roundWinner) {
      const existing = nextRoundMap.get(knockout.nextMatchId) ?? {
        matchId: knockout.matchId,
        round: knockout.round,
        nextMatchId: knockout.nextMatchId,
        roundWinner: null,
        nextRound: knockout.round + 1,
        nextHomeEntryId: null,
        nextAwayEntryId: null,
      };
      if (knockout.matchId % 2 === 1) {
        existing.nextHomeEntryId = roundWinner;
      } else {
        existing.nextAwayEntryId = roundWinner;
      }
      nextRoundMap.set(knockout.nextMatchId, existing);
    }
  }

  const updatedKnockoutsCount = await tournamentKnockoutsRepository.upsertBatch(updatedKnockouts);

  if (nextRoundMap.size > 0) {
    const nextRound = [...nextRoundMap.values()][0]?.nextRound ?? null;
    if (nextRound) {
      const nextKnockouts = await tournamentKnockoutsRepository.findByTournamentAndRound(
        tournament.id,
        nextRound,
      );
      const updatedNextKnockouts = nextKnockouts.map((knockout) => {
        const nextData = nextRoundMap.get(knockout.matchId);
        if (!nextData) {
          return knockout;
        }
        return {
          ...knockout,
          homeEntryId: nextData.nextHomeEntryId ?? knockout.homeEntryId,
          awayEntryId: nextData.nextAwayEntryId ?? knockout.awayEntryId,
        };
      });
      await tournamentKnockoutsRepository.upsertBatch(updatedNextKnockouts);

      const nextMatchIds = [...nextRoundMap.keys()];
      const nextResults = await tournamentKnockoutResultsRepository.findByTournamentAndMatchIds(
        tournament.id,
        nextMatchIds,
      );
      const updatedNextResults = nextResults.map((result) => {
        const nextData = nextRoundMap.get(result.matchId);
        if (!nextData) {
          return result;
        }
        const homeEntryId = nextData.nextHomeEntryId;
        const awayEntryId = nextData.nextAwayEntryId;
        if (!homeEntryId || !awayEntryId) {
          return result;
        }
        const swap = result.playAgainstId % 2 === 0;
        return {
          ...result,
          homeEntryId: swap ? awayEntryId : homeEntryId,
          awayEntryId: swap ? homeEntryId : awayEntryId,
        };
      });
      await tournamentKnockoutResultsRepository.upsertBatch(updatedNextResults);
    }
  }

  return {
    updatedResults: updatedResultsCount,
    updatedKnockouts: updatedKnockoutsCount,
    skipped: 0,
  };
}

export async function syncTournamentKnockoutResults(
  eventId: number,
): Promise<{ eventId: number; updatedResults: number; updatedKnockouts: number; skipped: number }> {
  logInfo('Starting tournament knockout results sync', { eventId });

  const tournaments = await tournamentInfoRepository.findKnockoutByEvent(eventId);
  if (tournaments.length === 0) {
    logInfo('No knockout tournaments found', { eventId });
    return { eventId, updatedResults: 0, updatedKnockouts: 0, skipped: 0 };
  }

  let updatedResults = 0;
  let updatedKnockouts = 0;
  let skipped = 0;

  for (const tournament of tournaments) {
    try {
      const result = await syncKnockoutForTournament(tournament, eventId);
      updatedResults += result.updatedResults;
      updatedKnockouts += result.updatedKnockouts;
      skipped += result.skipped;
    } catch (error) {
      logError('Failed to sync knockout results', error, {
        tournamentId: tournament.id,
        eventId,
      });
    }
  }

  logInfo('Tournament knockout results sync completed', {
    eventId,
    updatedResults,
    updatedKnockouts,
    skipped,
  });

  return { eventId, updatedResults, updatedKnockouts, skipped };
}
