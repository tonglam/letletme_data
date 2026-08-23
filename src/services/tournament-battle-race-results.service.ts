import { entryEventResultsRepository } from '../repositories/entry-event-results';
import { tournamentBattleGroupResultsRepository } from '../repositories/tournament-battle-group-results';
import { tournamentGroupRepository } from '../repositories/tournament-groups';
import { tournamentEntryRepository } from '../repositories/tournament-entries';
import { tournamentInfoRepository } from '../repositories/tournament-infos';
import { tournamentRosterRepository } from '../repositories/tournament-roster';
import { enqueueTournamentRosterReconcile } from '../jobs/tournament-sync.jobs';
import { mapWithConcurrency } from '../utils/async';
import { IncompleteDataSyncError } from '../utils/errors';
import { logError, logInfo, logWarn } from '../utils/logger';

import type { DbTournamentGroup, DbTournamentGroupInsert } from '../db/schemas/index.schema';
import type { FplSeasonRef } from '../domain/fpl-season';
import { isOfficialH2HTournament, type TournamentSyncContext } from '../domain/tournament';
import { eventRepository } from '../repositories/events';
import {
  OfficialH2HStrategy,
  type OfficialH2HSyncOptions,
} from './tournament-official-h2h.service';

const officialH2HRecoveryTargets = new WeakMap<IncompleteDataSyncError, number[]>();

async function getOfficialH2HSyncOptions(season: FplSeasonRef): Promise<OfficialH2HSyncOptions> {
  const latestFinalizedEvent = await eventRepository.findLatestFinalized(season);
  return {
    finalizedThroughEventId: latestFinalizedEvent?.id ?? null,
  };
}

export function getOfficialH2HRecoveryTargets(error: unknown): readonly number[] {
  return error instanceof IncompleteDataSyncError
    ? (officialH2HRecoveryTargets.get(error) ?? [])
    : [];
}

export async function enqueueOfficialH2HRosterRecoveries(
  season: FplSeasonRef,
  eventId: number,
  tournamentIds: readonly number[],
): Promise<void> {
  await mapWithConcurrency([...new Set(tournamentIds)], 5, async (tournamentId) => {
    try {
      const recoveryMarker = await tournamentRosterRepository.prepareUnlockedOfficialH2HRecovery(
        season,
        tournamentId,
      );
      if (!recoveryMarker) {
        logWarn('Skipped unsafe or already claimed official H2H roster recovery', {
          tournamentId,
          eventId,
        });
        return;
      }
      const recoveryJob = await enqueueTournamentRosterReconcile(season, tournamentId, 'watchdog', {
        allowUnlockedOfficialH2HRecovery: true,
        expectedProgressMarker: recoveryMarker,
      });
      logWarn('Enqueued guarded official H2H roster recovery', {
        tournamentId,
        eventId,
        jobId: recoveryJob.id,
      });
    } catch (recoveryError) {
      logError('Failed to enqueue guarded official H2H roster recovery', recoveryError, {
        tournamentId,
        eventId,
      });
    }
  });
}

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

export async function syncTournamentBattleRaceResultsForTournament(
  season: FplSeasonRef,
  tournament: TournamentSyncContext,
  eventId: number,
): Promise<{ updatedGroups: number; updatedResults: number; skipped: number }> {
  if (!tournament.groupStartedEventId || !tournament.groupEndedEventId) {
    logInfo('Skipping battle race tournament without group window', {
      tournamentId: tournament.id,
    });
    return { updatedGroups: 0, updatedResults: 0, skipped: 0 };
  }
  const groupStartedEventId = tournament.groupStartedEventId;
  const groupEndedEventId = tournament.groupEndedEventId;

  const entryIds = await tournamentEntryRepository.findEntryIdsByTournamentId(
    season,
    tournament.id,
  );
  if (entryIds.length === 0) {
    logInfo('No tournament entries found for battle race results', { tournamentId: tournament.id });
    return { updatedGroups: 0, updatedResults: 0, skipped: 0 };
  }

  const eventResults = await entryEventResultsRepository.findByEventAndEntryIds(
    season,
    eventId,
    entryIds,
  );
  if (eventResults.length === 0) {
    logInfo('Entry event results missing for battle race', {
      tournamentId: tournament.id,
      eventId,
    });
    return { updatedGroups: 0, updatedResults: 0, skipped: entryIds.length };
  }
  const eventResultMap = new Map(eventResults.map((result) => [result.entryId, result]));

  const battleResults = await tournamentBattleGroupResultsRepository.findByTournamentAndEvent(
    season,
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

  // Score this event's matchups. A matchup is scored only when BOTH sides have
  // an entry_event_results row — scoring a missing side as 0 would award
  // phantom-zero wins (FP-09 / C6). Skipped matchups keep their NULL points and
  // are excluded from the upsert; they can be scored later once results arrive.
  let skipped = 0;
  const scoredBattleResults = [];
  for (const result of battleResults) {
    if (
      result.officialMatchId != null ||
      result.homeEntryId === null ||
      result.awayEntryId === null
    ) {
      skipped += 1;
      logWarn('Skipping non-local row in LocalBattleStrategy', {
        tournamentId: tournament.id,
        eventId,
        officialMatchId: result.officialMatchId,
      });
      continue;
    }
    const homeResult = eventResultMap.get(result.homeEntryId);
    const awayResult = eventResultMap.get(result.awayEntryId);
    if (!homeResult || !awayResult) {
      skipped += 1;
      logWarn('Skipping battle race matchup with missing entry event result', {
        tournamentId: tournament.id,
        eventId,
        groupId: result.groupId,
        homeEntryId: result.homeEntryId,
        awayEntryId: result.awayEntryId,
        missingHome: !homeResult,
        missingAway: !awayResult,
      });
      // Clear any previously written phantom 3/0 points so history recompute
      // does not keep counting a stale win (FP-09 Codex P1).
      scoredBattleResults.push({
        ...result,
        homeNetPoints: null,
        homeRank: null,
        homeMatchPoints: null,
        awayNetPoints: null,
        awayRank: null,
        awayMatchPoints: null,
      });
      continue;
    }

    const homeNet = homeResult.eventNetPoints;
    const awayNet = awayResult.eventNetPoints;
    scoredBattleResults.push({
      ...result,
      homeNetPoints: homeNet,
      homeRank: homeResult.eventRank ?? null,
      homeMatchPoints: matchPoints(homeNet, awayNet),
      awayNetPoints: awayNet,
      awayRank: awayResult.eventRank ?? null,
      awayMatchPoints: matchPoints(awayNet, homeNet),
    });
  }

  // Upsert scored matchups BEFORE reading the history so the recompute below
  // sees this event's points.
  const updatedResultsCount = await tournamentBattleGroupResultsRepository.upsertBatch(
    season,
    scoredBattleResults,
  );

  // Recompute through the latest event that has battle rows in the group
  // window — not only through this job's eventId. A delayed/retried backfill
  // of an older GW must not overwrite standings with a prefix total and drop
  // later GWs (FP-09 Codex P1).
  const maxStoredEventId = await tournamentBattleGroupResultsRepository.findMaxEventIdInRange(
    season,
    tournament.id,
    groupStartedEventId,
    groupEndedEventId,
  );
  const recomputeThroughEventId = Math.min(
    groupEndedEventId,
    Math.max(eventId, maxStoredEventId ?? eventId),
  );

  // Recompute group counters from the full matchup history in the group
  // window. Re-runs are idempotent and backfill + re-run converges; the old
  // one-way increment guard (played >= expected → skip) locked wrong counters
  // in place forever (FP-09 / C6).
  const history = await tournamentBattleGroupResultsRepository.findByTournamentAndEventRange(
    season,
    tournament.id,
    groupStartedEventId,
    recomputeThroughEventId,
  );

  const totalsMap = new Map(
    (
      await entryEventResultsRepository.aggregateTotalsByEntry(
        season,
        entryIds,
        groupStartedEventId,
        recomputeThroughEventId,
      )
    ).map((row) => [row.entryId, row]),
  );

  // Overall ranks for tie-breaks: use results at the recompute horizon.
  const rankingResultMap =
    recomputeThroughEventId === eventId
      ? eventResultMap
      : new Map(
          (
            await entryEventResultsRepository.findByEventAndEntryIds(
              season,
              recomputeThroughEventId,
              entryIds,
            )
          ).map((result) => [result.entryId, result]),
        );

  type Counter = { points: number; won: number; drawn: number; lost: number };
  const newCounter = (): Counter => ({ points: 0, won: 0, drawn: 0, lost: 0 });
  const groupIds = [...new Set(history.map((row) => row.groupId))];
  const countersByGroup = new Map<number, Map<number, Counter>>();
  for (const row of history) {
    if (row.homeMatchPoints === null || row.awayMatchPoints === null) {
      continue; // unplayed or skipped matchup — no match points awarded yet
    }
    if (row.homeEntryId === null || row.awayEntryId === null) {
      continue;
    }
    const groupCounters = countersByGroup.get(row.groupId) ?? new Map<number, Counter>();
    for (const [entryId, points] of [
      [row.homeEntryId, row.homeMatchPoints],
      [row.awayEntryId, row.awayMatchPoints],
    ] as const) {
      const counter = groupCounters.get(entryId) ?? newCounter();
      counter.points += points;
      if (points === 3) {
        counter.won += 1;
      } else if (points === 1) {
        counter.drawn += 1;
      } else {
        counter.lost += 1;
      }
      groupCounters.set(entryId, counter);
    }
    countersByGroup.set(row.groupId, groupCounters);
  }

  const updatedGroups: DbTournamentGroupInsert[] = [];
  // Derived absolutely (like points-race) instead of incremented, so re-runs
  // of the same event never inflate the counter.
  const played = recomputeThroughEventId - groupStartedEventId + 1;

  // Batch-load every group row for this tournament's entries in one (chunked)
  // query and bucket by groupId in memory, instead of one query per group (FP-17).
  const groupEntriesByGroupId = new Map<number, DbTournamentGroup[]>();
  const allGroupEntries = await tournamentGroupRepository.findByTournamentAndEntries(
    season,
    tournament.id,
    entryIds,
  );
  for (const group of allGroupEntries) {
    const bucket = groupEntriesByGroupId.get(group.groupId);
    if (bucket) {
      bucket.push(group);
    } else {
      groupEntriesByGroupId.set(group.groupId, [group]);
    }
  }

  for (const groupId of groupIds) {
    const groupEntries = groupEntriesByGroupId.get(groupId) ?? [];
    const groupCounters = countersByGroup.get(groupId) ?? new Map<number, Counter>();
    const groupUpdates = groupEntries.map((group) => {
      const entryId = group.entryId;
      const eventResult = rankingResultMap.get(entryId);
      if (!eventResult) {
        skipped += 1;
        return null;
      }

      const counter = groupCounters.get(entryId) ?? newCounter();
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
        groupPoints: counter.points,
        groupRank: group.groupRank,
        played,
        won: counter.won,
        drawn: counter.drawn,
        lost: counter.lost,
        totalPoints: totals?.totalPoints ?? 0,
        totalTransfersCost: totals?.totalTransfersCost ?? 0,
        totalNetPoints: totals?.totalNetPoints ?? 0,
        qualified: group.qualified,
        overallRank: eventResult.overallRank,
        createdAt: group.createdAt,
      };
    });

    const filtered = groupUpdates.filter(
      (group): group is NonNullable<(typeof groupUpdates)[number]> => group !== null,
    );
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

  const updatedGroupsCount = await tournamentGroupRepository.upsertBatch(season, updatedGroups);

  return { updatedGroups: updatedGroupsCount, updatedResults: updatedResultsCount, skipped };
}

export const LocalBattleStrategy = {
  sync: syncTournamentBattleRaceResultsForTournament,
};

export async function syncOfficialH2HTournaments(
  season: FplSeasonRef,
  eventId: number,
): Promise<{ eventId: number; updatedGroups: number; updatedResults: number; skipped: number }> {
  const tournaments = (
    await tournamentInfoRepository.findBattleRaceByEvent(season, eventId)
  ).filter(isOfficialH2HTournament);
  const options =
    tournaments.length > 0
      ? await getOfficialH2HSyncOptions(season)
      : { finalizedThroughEventId: null };
  let updatedGroups = 0;
  let updatedResults = 0;
  const failures: number[] = [];
  const recoveryTournamentIds: number[] = [];
  const results = await mapWithConcurrency(tournaments, 5, async (tournament) => {
    try {
      return await OfficialH2HStrategy.sync(season, tournament, eventId, options);
    } catch (error) {
      if (
        error !== null &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'TOURNAMENT_OFFICIAL_H2H_STANDINGS_INCOMPLETE'
      ) {
        recoveryTournamentIds.push(tournament.id);
      }
      failures.push(tournament.id);
      logError('Official H2H strategy failed', error, { tournamentId: tournament.id, eventId });
      return { updatedGroups: 0, updatedResults: 0, skipped: 0 };
    }
  });
  for (const result of results) {
    updatedGroups += result.updatedGroups;
    updatedResults += result.updatedResults;
  }
  if (failures.length > 0) {
    const error = new IncompleteDataSyncError(
      'Official H2H mirrors did not converge',
      tournaments.length,
      0,
      tournaments.length - failures.length,
      failures.length,
    );
    officialH2HRecoveryTargets.set(error, recoveryTournamentIds);
    throw error;
  }
  return { eventId, updatedGroups, updatedResults, skipped: 0 };
}

export async function syncTournamentBattleRaceResults(
  season: FplSeasonRef,
  eventId: number,
): Promise<{ eventId: number; updatedGroups: number; updatedResults: number; skipped: number }> {
  logInfo('Starting tournament battle race results sync', { eventId });

  const tournaments = await tournamentInfoRepository.findBattleRaceByEvent(season, eventId);
  if (tournaments.length === 0) {
    logInfo('No battle race tournaments found', { eventId });
    return { eventId, updatedGroups: 0, updatedResults: 0, skipped: 0 };
  }

  const officialH2HOptions = tournaments.some(isOfficialH2HTournament)
    ? await getOfficialH2HSyncOptions(season)
    : { finalizedThroughEventId: null };

  let updatedGroups = 0;
  let updatedResults = 0;
  let skipped = 0;
  const failedTournamentIds: number[] = [];
  const syncResults = await mapWithConcurrency(tournaments, 10, async (tournament) => {
    try {
      return isOfficialH2HTournament(tournament)
        ? await OfficialH2HStrategy.sync(season, tournament, eventId, officialH2HOptions)
        : await LocalBattleStrategy.sync(season, tournament, eventId);
    } catch (error) {
      logError('Failed to sync battle race results', error, {
        tournamentId: tournament.id,
        eventId,
      });
      failedTournamentIds.push(tournament.id);
      return { updatedGroups: 0, updatedResults: 0, skipped: 0 };
    }
  });
  for (const result of syncResults) {
    updatedGroups += result.updatedGroups;
    updatedResults += result.updatedResults;
    skipped += result.skipped;
  }

  logInfo('Tournament battle race results sync completed', {
    eventId,
    updatedGroups,
    updatedResults,
    skipped,
    failedCount: failedTournamentIds.length,
  });

  const failedUnits = skipped + failedTournamentIds.length;
  if (failedUnits > 0) {
    const succeededUnits = Math.max(updatedGroups, updatedResults);
    throw new IncompleteDataSyncError(
      'Battle-race results did not converge for every required unit',
      succeededUnits + failedUnits,
      0,
      succeededUnits,
      failedUnits,
    );
  }

  return { eventId, updatedGroups, updatedResults, skipped };
}
