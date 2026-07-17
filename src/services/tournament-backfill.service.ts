import { tournamentSetupBackfillEventScopes } from '../domain/mutation-scope';
import type { TournamentBackfillWindow, TournamentConfig } from '../domain/tournament';
import { ENTRY_SYNC_DEFAULT_CONCURRENCY } from '../queues/entry-sync.queue';
import { uniqueNumbers } from '../utils/async';
import { mapWithConcurrency } from '../utils/async';
import { logError, logInfo, logWarn } from '../utils/logger';
import { withMutationConflictGuard } from '../utils/mutation-lock';

import { syncEntryInfo } from './entry-info.service';
import { syncLeagueEventResultsByTournament } from './league-event-results.service';
import { syncTournamentEventResultsForEntryIds } from './tournament-event-results.service';
import { syncTournamentPointsRaceResultsForTournament } from './tournament-points-race-results.service';

export type TournamentSetupIssueScope =
  | 'entry-info'
  | 'event-results'
  | 'league-event-results'
  | 'points-race'
  | 'knockout';

export interface TournamentSetupIssue {
  scope: TournamentSetupIssueScope;
  message: string;
  eventId?: number;
  failedEntries?: number[];
}

export async function syncTournamentEntryDetails(
  entryIds: number[],
): Promise<TournamentSetupIssue[]> {
  const sanitized = uniqueNumbers(entryIds.filter((entryId) => entryId > 0));
  if (sanitized.length === 0) {
    return [];
  }

  const failures: number[] = [];
  await mapWithConcurrency(sanitized, ENTRY_SYNC_DEFAULT_CONCURRENCY, async (entryId) => {
    try {
      await syncEntryInfo(entryId);
    } catch (error) {
      failures.push(entryId);
      logError('Failed to sync detailed tournament entry info', error, { entryId });
    }
  });

  if (failures.length > 0) {
    const message = `Failed to sync detailed entry info for ${failures.length} entries`;
    logWarn('Tournament entry detail sync completed with warnings', {
      totalEntries: sanitized.length,
      failedCount: failures.length,
      failedEntryPreview: failures.slice(0, 10),
    });
    return [
      {
        scope: 'entry-info',
        message,
        failedEntries: failures,
      },
    ];
  }

  return [];
}

export async function runTournamentEventBackfill(
  tournamentId: number,
  tournament: TournamentConfig,
  entryIds: number[],
  eventId: number,
): Promise<TournamentSetupIssue[]> {
  const issues: TournamentSetupIssue[] = [];
  const eventResults = await syncTournamentEventResultsForEntryIds(entryIds, eventId, {
    concurrency: ENTRY_SYNC_DEFAULT_CONCURRENCY,
  });
  logInfo('Tournament event results sync completed for tournament', {
    tournamentId,
    eventId,
    totalEntries: eventResults.totalEntries,
    synced: eventResults.synced,
    errors: eventResults.errors,
  });
  if (eventResults.errors > 0 || eventResults.synced < eventResults.totalEntries) {
    const message = `Tournament event results incomplete for event ${eventId}: ${eventResults.synced}/${eventResults.totalEntries}`;
    issues.push({
      scope: 'event-results',
      eventId,
      message,
    });
    logWarn('Tournament event backfill completed with warnings', {
      tournamentId,
      eventId,
      totalEntries: eventResults.totalEntries,
      synced: eventResults.synced,
      errors: eventResults.errors,
    });
  }

  const leagueEventResults = await syncLeagueEventResultsByTournament(tournamentId, eventId, {
    concurrency: ENTRY_SYNC_DEFAULT_CONCURRENCY,
  });
  if (
    leagueEventResults.skipped > 0 ||
    leagueEventResults.updated < leagueEventResults.totalEntries
  ) {
    const message = `League event results incomplete for event ${eventId}: ${leagueEventResults.updated}/${leagueEventResults.totalEntries}`;
    issues.push({
      scope: 'league-event-results',
      eventId,
      message,
    });
    logWarn('League event results backfill completed with warnings', {
      tournamentId,
      eventId,
      totalEntries: leagueEventResults.totalEntries,
      updated: leagueEventResults.updated,
      skipped: leagueEventResults.skipped,
    });
  }

  if (
    tournament.groupMode === 'points_races' &&
    tournament.groupStartedEventId &&
    tournament.groupEndedEventId &&
    eventId >= tournament.groupStartedEventId &&
    eventId <= tournament.groupEndedEventId
  ) {
    const pointsRaceResult = await syncTournamentPointsRaceResultsForTournament(
      tournament,
      eventId,
    );
    if (pointsRaceResult.skipped > 0) {
      issues.push({
        scope: 'points-race',
        eventId,
        message: `Tournament points race sync incomplete for event ${eventId}: skipped ${pointsRaceResult.skipped}`,
      });
      logWarn('Tournament points race sync completed with warnings', {
        tournamentId,
        eventId,
        skipped: pointsRaceResult.skipped,
      });
    }
  }

  if (
    tournament.knockoutMode !== 'no_knockout' &&
    tournament.knockoutStartedEventId &&
    tournament.knockoutEndedEventId &&
    eventId >= tournament.knockoutStartedEventId &&
    eventId <= tournament.knockoutEndedEventId
  ) {
    const { syncKnockoutForTournament } = await import('./tournament-knockout-results.service');
    const knockoutResult = await syncKnockoutForTournament(tournament, eventId);
    if (knockoutResult.skipped > 0) {
      issues.push({
        scope: 'knockout',
        eventId,
        message: `Tournament knockout sync incomplete for event ${eventId}: skipped ${knockoutResult.skipped}`,
      });
      logWarn('Tournament knockout sync completed with warnings', {
        tournamentId,
        eventId,
        skipped: knockoutResult.skipped,
      });
    }
  }

  return issues;
}

export async function backfillTournamentHistory(
  tournamentId: number,
  tournament: TournamentConfig,
  entryIds: number[],
  window: TournamentBackfillWindow | null,
): Promise<TournamentSetupIssue[]> {
  if (!window) {
    return [];
  }

  const issues: TournamentSetupIssue[] = [];
  for (let eventId = window.startEventId; eventId <= window.endEventId; eventId += 1) {
    // Per-event structure lock: allows cascade points/battle/knockout to run
    // between events instead of waiting for the entire multi-GW history pass.
    const eventIssues = await withMutationConflictGuard(
      {
        queueName: 'tournament-setup',
        jobName: 'tournament-setup',
        tournamentId,
        eventId,
        scopes: tournamentSetupBackfillEventScopes(eventId),
      },
      () => runTournamentEventBackfill(tournamentId, tournament, entryIds, eventId),
    );
    issues.push(...eventIssues);
  }

  return issues;
}
