import type { FplSeasonRef } from '../domain/fpl-season';
import { findEventEligibleEntryIds, type EntryInfo } from '../domain/entry-infos';
import { entryEventPicksRepository } from '../repositories/entry-event-picks';
import { entryInfoRepository } from '../repositories/entry-infos';
import {
  tournamentInfoRepository,
  type TournamentInfoSummary,
} from '../repositories/tournament-infos';
import { mapWithConcurrency } from '../utils/async';
import { IncompleteDataSyncError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';
import { syncEntryEventPicks } from './entries.service';
import { resolveTournamentEntryIds } from './tournament-entry-resolver.service';

const DEFAULT_CONCURRENCY = 5;

type EntrySyncOutcome = {
  entryId: number;
  success: boolean;
};

export interface LeagueEventPicksDependencies {
  findTournament: (
    season: FplSeasonRef,
    tournamentId: number,
  ) => Promise<TournamentInfoSummary | null>;
  resolveEntryIds: (season: FplSeasonRef, tournament: TournamentInfoSummary) => Promise<number[]>;
  findEntryInfos: (
    season: FplSeasonRef,
    entryIds: number[],
  ) => Promise<Array<Pick<EntryInfo, 'id' | 'startedEvent'>>>;
  findPersistedEntryIds: (
    season: FplSeasonRef,
    eventId: number,
    entryIds: number[],
  ) => Promise<number[]>;
  syncEntry: (season: FplSeasonRef, entryId: number, eventId: number) => Promise<unknown>;
}

const defaultDependencies: LeagueEventPicksDependencies = {
  findTournament: (season, tournamentId) => tournamentInfoRepository.findById(season, tournamentId),
  resolveEntryIds: resolveTournamentEntryIds,
  findEntryInfos: (season, entryIds) => entryInfoRepository.findByIds(season, entryIds),
  findPersistedEntryIds: (season, eventId, entryIds) =>
    entryEventPicksRepository.findEntryIdsByEvent(season, eventId, entryIds),
  syncEntry: (season, entryId, eventId) => syncEntryEventPicks(season, entryId, eventId),
};

export async function syncLeagueEventPicksByTournament(
  season: FplSeasonRef,
  tournamentId: number,
  eventId: number,
  options?: {
    concurrency?: number;
    dependencies?: LeagueEventPicksDependencies;
  },
): Promise<{
  tournamentId: number;
  eventId: number;
  totalEntries: number;
  synced: number;
  skipped: number;
  errors: number;
  requiredUnits: number;
  reusedUnits: number;
  succeededUnits: number;
  failedUnits: number;
}> {
  logInfo('Starting league event picks sync for tournament', { tournamentId, eventId });
  const dependencies = options?.dependencies ?? defaultDependencies;
  const tournament = await dependencies.findTournament(season, tournamentId);
  if (!tournament) {
    throw new Error(`Tournament ${tournamentId} not found`);
  }

  const candidateEntryIds = await dependencies.resolveEntryIds(season, tournament);
  const entryInfos = await dependencies.findEntryInfos(season, candidateEntryIds);
  const entryIds = findEventEligibleEntryIds(candidateEntryIds, entryInfos, eventId);
  logInfo('Resolved tournament entries for league picks', {
    eventId,
    tournamentId,
    leagueId: tournament.leagueId,
    leagueType: tournament.leagueType,
    candidateEntries: candidateEntryIds.length,
    eligibleEntries: entryIds.length,
  });

  if (entryIds.length === 0) {
    return {
      tournamentId,
      eventId,
      totalEntries: 0,
      synced: 0,
      skipped: 0,
      errors: 0,
      requiredUnits: 0,
      reusedUnits: 0,
      succeededUnits: 0,
      failedUnits: 0,
    };
  }

  const existingEntryIds = await dependencies.findPersistedEntryIds(season, eventId, entryIds);
  const existingSet = new Set(existingEntryIds);
  const entriesToSync = entryIds.filter((entryId) => !existingSet.has(entryId));
  const concurrency = options?.concurrency ?? DEFAULT_CONCURRENCY;

  if (entriesToSync.length === 0) {
    logInfo('League event picks already synced for tournament', {
      eventId,
      tournamentId,
      totalEntries: entryIds.length,
      skipped: existingEntryIds.length,
    });
    return {
      tournamentId,
      eventId,
      totalEntries: entryIds.length,
      synced: 0,
      skipped: existingEntryIds.length,
      errors: 0,
      requiredUnits: 0,
      reusedUnits: existingEntryIds.length,
      succeededUnits: 0,
      failedUnits: 0,
    };
  }

  const results = await mapWithConcurrency(entriesToSync, concurrency, async (entryId) => {
    try {
      await dependencies.syncEntry(season, entryId, eventId);
      return { entryId, success: true } satisfies EntrySyncOutcome;
    } catch (error) {
      logError('Failed to sync league entry picks', error, { eventId, entryId, tournamentId });
      return { entryId, success: false } satisfies EntrySyncOutcome;
    }
  });

  const attemptedSuccess = results.filter((result) => result.success).length;
  const persistedEntryIds = new Set(
    await dependencies.findPersistedEntryIds(season, eventId, entriesToSync),
  );
  const synced = entriesToSync.filter((entryId) => persistedEntryIds.has(entryId)).length;
  const errors = entriesToSync.length - synced;

  logInfo('League event picks sync completed for tournament', {
    eventId,
    tournamentId,
    totalEntries: entryIds.length,
    synced,
    skipped: existingEntryIds.length,
    errors,
    attemptedSuccess,
  });

  if (errors > 0) {
    throw new IncompleteDataSyncError(
      'League event picks did not converge for every tournament entry',
      entriesToSync.length,
      existingEntryIds.length,
      synced,
      errors,
    );
  }

  return {
    tournamentId,
    eventId,
    totalEntries: entryIds.length,
    synced,
    skipped: existingEntryIds.length,
    errors,
    requiredUnits: entriesToSync.length,
    reusedUnits: existingEntryIds.length,
    succeededUnits: synced,
    failedUnits: errors,
  };
}
