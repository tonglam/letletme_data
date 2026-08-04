import { tournamentSetupBackfillEventScopes } from '../domain/mutation-scope';
import { getActiveCacheSeason, getActiveCacheSeasonUncached } from '../cache/cache-season';
import type { TournamentBackfillWindow, TournamentConfig } from '../domain/tournament';
import { ENTRY_SYNC_DEFAULT_CONCURRENCY } from '../queues/entry-sync.queue';
import { entryEventPicksRepository } from '../repositories/entry-event-picks';
import {
  createEntryEventResultsRepository,
  entryEventResultsRepository,
} from '../repositories/entry-event-results';
import {
  entryEventTransfersRepository,
  withEntrySeasonSyncTransaction,
} from '../repositories/entry-event-transfers';
import { entryInfoRepository } from '../repositories/entry-infos';
import { uniqueNumbers } from '../utils/async';
import { mapWithConcurrency } from '../utils/async';
import { logError, logInfo, logWarn } from '../utils/logger';
import { withMutationConflictGuard } from '../utils/mutation-lock';

import { syncEntryInfo } from './entry-info.service';
import { syncTournamentBattleRaceResultsForTournament } from './tournament-battle-race-results.service';
import { syncLeagueEventResultsByTournament } from './league-event-results.service';
import {
  syncEntryTransferHistories,
  syncTournamentEventResultsForEntryIds,
} from './tournament-event-results.service';
import { syncTournamentPointsRaceResultsForTournament } from './tournament-points-race-results.service';
import { syncTournamentSelectionStats } from './tournament-selection-stats.service';

export type TournamentSetupIssueScope =
  | 'entry-info'
  | 'event-results'
  | 'league-event-results'
  | 'points-race'
  | 'battle-race'
  | 'knockout';

export interface TournamentSetupIssue {
  scope: TournamentSetupIssueScope;
  message: string;
  eventId?: number;
  failedEntries?: number[];
  blocksStandings?: boolean;
}

export type TournamentEntrySyncPlan = {
  totalEntries: number;
  requestedEntries: number;
  reusedEntries: number;
};

export type TournamentCoreSyncPlan = {
  totalPairs: number;
  missingPairs: number;
  reusedPairs: number;
};

export type TournamentEnrichmentPlan = {
  totalPickPairs: number;
  missingPickPairs: number;
  reusedPickPairs: number;
  totalTransferEntries: number;
  requestedTransferEntries: number;
  reusedTransferEntries: number;
};

export function classifyEntrySnapshotFailures(
  failedEntryIds: number[],
  unprovenSeasonEntryIds: ReadonlySet<number>,
): TournamentSetupIssue[] {
  const entryLabel = (count: number) => `${count} ${count === 1 ? 'entry' : 'entries'}`;
  const blockingEntries = failedEntryIds.filter((entryId) => unprovenSeasonEntryIds.has(entryId));
  const warningEntries = failedEntryIds.filter((entryId) => !unprovenSeasonEntryIds.has(entryId));
  const issues: TournamentSetupIssue[] = [];
  if (blockingEntries.length > 0) {
    issues.push({
      scope: 'entry-info',
      message: `Current-season entry snapshot remains unproven for ${entryLabel(blockingEntries.length)}`,
      failedEntries: blockingEntries,
      blocksStandings: true,
    });
  }
  if (warningEntries.length > 0) {
    issues.push({
      scope: 'entry-info',
      message: `Failed to refresh detailed entry info for ${entryLabel(warningEntries.length)}`,
      failedEntries: warningEntries,
    });
  }
  return issues;
}

export async function syncTournamentEntryDetails(
  entryIds: number[],
  options?: {
    targetEventId?: number;
    season?: string;
    onPlan?: (plan: TournamentEntrySyncPlan) => void | Promise<void>;
    onProgress?: (completed: number, total: number) => Promise<void>;
  },
): Promise<TournamentSetupIssue[]> {
  const sanitized = uniqueNumbers(entryIds.filter((entryId) => entryId > 0));
  if (sanitized.length === 0) {
    await options?.onPlan?.({ totalEntries: 0, requestedEntries: 0, reusedEntries: 0 });
    return [];
  }

  const targetEventId = options?.targetEventId ?? 0;
  const season = options?.season ?? (await getActiveCacheSeason());
  const requestedEntryIds = await entryInfoRepository.findIdsNeedingSnapshotSync(
    sanitized,
    targetEventId,
    season,
  );
  const plan = {
    totalEntries: sanitized.length,
    requestedEntries: requestedEntryIds.length,
    reusedEntries: sanitized.length - requestedEntryIds.length,
  } satisfies TournamentEntrySyncPlan;
  await options?.onPlan?.(plan);
  logInfo('Tournament entry snapshot sync planned', { targetEventId, ...plan });

  const failures: number[] = [];
  let completed = 0;
  const progressBatchSize = Math.max(ENTRY_SYNC_DEFAULT_CONCURRENCY * 2, 10);
  for (let index = 0; index < requestedEntryIds.length; index += progressBatchSize) {
    const batch = requestedEntryIds.slice(index, index + progressBatchSize);
    await mapWithConcurrency(batch, ENTRY_SYNC_DEFAULT_CONCURRENCY, async (entryId) => {
      try {
        await syncEntryInfo(entryId, undefined, targetEventId, season);
      } catch (error) {
        failures.push(entryId);
        logError('Failed to sync detailed tournament entry info', error, { entryId });
      }
    });
    completed += batch.length;
    await options?.onProgress?.(completed, requestedEntryIds.length);
  }

  // Reused entries make no downstream FPL call, so the caller cannot rely on
  // per-entry commit fences alone. Abort the whole plan if annual authority
  // changed while snapshots were selected or fetched.
  const canonicalSeason = await getActiveCacheSeasonUncached();
  if (canonicalSeason !== season) {
    throw new Error(
      `Active season changed from ${season} to ${canonicalSeason} during tournament entry sync`,
    );
  }

  if (failures.length > 0) {
    // Audit canonical checkpoints after the attempts. This distinguishes an
    // upstream/transaction failure (no current-season proof) from a derived
    // cache publication failure after the database commit.
    const failedEntries = await entryInfoRepository.findByIds(failures);
    const checkpointSeasonByEntryId = new Map(
      failedEntries.map((entry) => [entry.id, entry.entrySnapshotSyncedSeason]),
    );
    // Missing and legacy-null checkpoints cannot prove ownership of
    // event-numbered rows, so their failed refresh blocks publication.
    const unprovenSeasonEntryIds = new Set(
      failures.filter((entryId) => checkpointSeasonByEntryId.get(entryId) !== season),
    );
    logWarn('Tournament entry detail sync completed with warnings', {
      totalEntries: sanitized.length,
      requestedEntries: requestedEntryIds.length,
      failedCount: failures.length,
      blockingCount: failures.filter((entryId) => unprovenSeasonEntryIds.has(entryId)).length,
      failedEntryPreview: failures.slice(0, 10),
    });
    return classifyEntrySnapshotFailures(failures, unprovenSeasonEntryIds);
  }

  return [];
}

export type MissingTournamentUnits = Map<number, number[]>;

type MissingTournamentUnitsAudit = {
  missing: MissingTournamentUnits;
  totalPairs: number;
};

async function loadEntryStartEvents(entryIds: number[]): Promise<Map<number, number | null>> {
  const rows = await entryInfoRepository.findByIds(entryIds);
  return new Map(rows.map((row) => [row.id, row.startedEvent]));
}

function isEligibleForEvent(
  entryId: number,
  eventId: number,
  entryStartEvents: ReadonlyMap<number, number | null>,
): boolean {
  const startedEvent = entryStartEvents.get(entryId);
  return startedEvent === undefined || startedEvent === null || eventId >= startedEvent;
}

async function seedPreEntryCoreBaselines(
  entryIds: number[],
  window: TournamentBackfillWindow,
  checkpointSeason: string,
): Promise<number> {
  if (!/^\d{4}$/.test(checkpointSeason)) {
    throw new Error('A valid four-digit setup season is required');
  }
  const entryStartEvents = await loadEntryStartEvents(entryIds);
  const units: Array<{ entryId: number; eventId: number }> = [];
  for (const entryId of entryIds) {
    const startedEvent = entryStartEvents.get(entryId);
    if (startedEvent === undefined || startedEvent === null) continue;
    const lastPreEntryEvent = Math.min(window.endEventId, startedEvent - 1);
    for (let eventId = window.startEventId; eventId <= lastPreEntryEvent; eventId += 1) {
      units.push({ entryId, eventId });
    }
  }
  // Keep the season captured by the caller. Reading Season:active here after
  // deriving the units could pair an old started_event with a new-season
  // checkpoint during the annual rollover.
  const canonicalSeason = await getActiveCacheSeasonUncached();
  if (canonicalSeason !== checkpointSeason) {
    throw new Error(
      `Active season changed from ${checkpointSeason} to ${canonicalSeason} before baseline seeding`,
    );
  }
  const unitsByEntry = new Map<number, Array<{ entryId: number; eventId: number }>>();
  for (const unit of units) {
    const entryUnits = unitsByEntry.get(unit.entryId) ?? [];
    entryUnits.push(unit);
    unitsByEntry.set(unit.entryId, entryUnits);
  }

  let inserted = 0;
  for (const [entryId, entryUnits] of unitsByEntry) {
    inserted += await withEntrySeasonSyncTransaction(entryId, checkpointSeason, async (tx) =>
      createEntryEventResultsRepository(tx).seedPreEntryBaselines(entryUnits),
    );
  }
  return inserted;
}

async function auditMissingUnits(
  entryIds: number[],
  window: TournamentBackfillWindow,
  kind: 'results' | 'picks',
  requiredPicksEvents: ReadonlySet<number> = new Set(),
): Promise<MissingTournamentUnitsAudit> {
  const missing = new Map<number, number[]>();
  const entryStartEvents = await loadEntryStartEvents(entryIds);
  let totalPairs = 0;
  for (let eventId = window.startEventId; eventId <= window.endEventId; eventId += 1) {
    const eligibleEntryIds = entryIds.filter((entryId) =>
      isEligibleForEvent(entryId, eventId, entryStartEvents),
    );
    totalPairs += eligibleEntryIds.length;
    if (eligibleEntryIds.length === 0) continue;
    let present: number[];
    if (kind === 'results') {
      const resultRows = await entryEventResultsRepository.findByEventAndEntryIds(
        eventId,
        eligibleEntryIds,
      );
      if (requiredPicksEvents.has(eventId)) {
        // Knockout scoring consumes entry_event_results.event_picks directly.
        // A separate entry_event_picks row is not proof that this canonical
        // scoring row was updated successfully.
        present = resultRows
          .filter((row) => Array.isArray(row.eventPicks) && row.eventPicks.length > 0)
          .map((row) => row.entryId);
      } else {
        present = resultRows.map((row) => row.entryId);
      }
    } else {
      present = await entryEventPicksRepository.findEntryIdsByEvent(eventId, eligibleEntryIds);
    }
    const presentSet = new Set(present);
    const missingEntryIds = eligibleEntryIds.filter((entryId) => !presentSet.has(entryId));
    if (missingEntryIds.length > 0) {
      missing.set(eventId, missingEntryIds);
    }
  }
  return { missing, totalPairs };
}

export async function findMissingCoreResults(
  entryIds: number[],
  window: TournamentBackfillWindow,
): Promise<MissingTournamentUnits> {
  return (await auditMissingUnits(entryIds, window, 'results')).missing;
}

export async function findMissingHistoricalPicks(
  entryIds: number[],
  window: TournamentBackfillWindow,
): Promise<MissingTournamentUnits> {
  return (await auditMissingUnits(entryIds, window, 'picks')).missing;
}

export async function ensureTournamentCoreResults(
  entryIds: number[],
  window: TournamentBackfillWindow,
  onProgress?: (completed: number, total: number) => Promise<void>,
  onPlan?: (plan: TournamentCoreSyncPlan) => void | Promise<void>,
  options?: {
    requirePicksForEvents?: readonly number[];
    setupSeason?: string;
  },
): Promise<void> {
  const requiredPicksEvents = new Set(options?.requirePicksForEvents ?? []);
  const checkpointSeason = options?.setupSeason ?? (await getActiveCacheSeason());
  const seededBaselines = await seedPreEntryCoreBaselines(entryIds, window, checkpointSeason);
  const audit = await auditMissingUnits(entryIds, window, 'results', requiredPicksEvents);
  const missing = audit.missing;
  const total = [...missing.values()].reduce((sum, ids) => sum + ids.length, 0);
  const totalPairs = audit.totalPairs;
  await onPlan?.({ totalPairs, missingPairs: total, reusedPairs: totalPairs - total });
  let completed = 0;
  logInfo('Tournament core result audit planned', {
    entryCount: entryIds.length,
    eventCount: window.endEventId - window.startEventId + 1,
    seededPreEntryBaselines: seededBaselines,
    missingPairs: total,
    missingEvents: missing.size,
  });

  for (const [eventId, missingEntryIds] of missing) {
    await syncTournamentEventResultsForEntryIds(missingEntryIds, eventId, {
      concurrency: ENTRY_SYNC_DEFAULT_CONCURRENCY,
      skipTransfers: true,
      season: checkpointSeason,
    });
    completed += missingEntryIds.length;
    await onProgress?.(completed, total);
  }

  const remaining = (await auditMissingUnits(entryIds, window, 'results', requiredPicksEvents))
    .missing;
  if (remaining.size > 0) {
    const preview = [...remaining]
      .slice(0, 5)
      .map(([eventId, ids]) => `GW${eventId}: ${ids.join(',')}`)
      .join('; ');
    throw new Error(`Core tournament results remain incomplete (${preview})`);
  }
  logInfo('Tournament core result audit completed', {
    fetchedPairs: completed,
    remainingPairs: 0,
  });
}

export async function calculateTournamentHistoryFromStoredResults(
  tournamentId: number,
  tournament: TournamentConfig,
  window: TournamentBackfillWindow | null,
  onProgress?: (completed: number, total: number) => Promise<void>,
): Promise<void> {
  if (!window) return;

  const total = window.endEventId - window.startEventId + 1;
  let completed = 0;
  for (let eventId = window.startEventId; eventId <= window.endEventId; eventId += 1) {
    const structureScopes = tournamentSetupBackfillEventScopes(eventId);
    if (
      tournament.groupMode === 'points_races' &&
      tournament.groupStartedEventId &&
      tournament.groupEndedEventId &&
      eventId >= tournament.groupStartedEventId &&
      eventId <= tournament.groupEndedEventId
    ) {
      const result = await withMutationConflictGuard(
        {
          queueName: 'tournament-setup',
          jobName: 'tournament-setup',
          tournamentId,
          eventId,
          scopes: structureScopes,
        },
        () => syncTournamentPointsRaceResultsForTournament(tournament, eventId),
      );
      if (result.skipped > 0) {
        throw new Error(
          `Core standings calculation skipped ${result.skipped} entries for event ${eventId}`,
        );
      }
    }

    if (
      tournament.groupMode === 'battle_races' &&
      tournament.groupStartedEventId &&
      tournament.groupEndedEventId &&
      eventId >= tournament.groupStartedEventId &&
      eventId <= tournament.groupEndedEventId
    ) {
      const result = await withMutationConflictGuard(
        {
          queueName: 'tournament-setup',
          jobName: 'tournament-setup',
          tournamentId,
          eventId,
          scopes: structureScopes,
        },
        () => syncTournamentBattleRaceResultsForTournament(tournament, eventId),
      );
      if (result.skipped > 0) {
        throw new Error(
          `Core battle race calculation skipped ${result.skipped} matchups for event ${eventId}`,
        );
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
      const result = await withMutationConflictGuard(
        {
          queueName: 'tournament-setup',
          jobName: 'tournament-setup',
          tournamentId,
          eventId,
          scopes: structureScopes,
        },
        () => syncKnockoutForTournament(tournament, eventId),
      );
      if (result.skipped > 0) {
        throw new Error(
          `Core knockout calculation skipped ${result.skipped} entries for event ${eventId}`,
        );
      }
    }

    completed += 1;
    await onProgress?.(completed, total);
  }
}

export async function enrichTournamentHistory(
  tournamentId: number,
  entryIds: number[],
  window: TournamentBackfillWindow | null,
  options?: {
    includeTransferHistory?: boolean;
    /** Keep every enrichment writer fenced to the setup's captured season. */
    setupSeason?: string;
    onPlan?: (plan: TournamentEnrichmentPlan) => void | Promise<void>;
    onProgress?: (completed: number, total: number) => Promise<void>;
  },
): Promise<TournamentSetupIssue[]> {
  const issues: TournamentSetupIssue[] = [];
  const targetEventId = window?.endEventId ?? 0;
  // Capture once and reuse it for every enrichment writer. Disabling transfer
  // history must not disable the season fence for picks/results/league rows.
  const setupSeason = options?.setupSeason ?? (await getActiveCacheSeason());
  const canonicalSeason = await getActiveCacheSeasonUncached();
  if (canonicalSeason !== setupSeason) {
    throw new Error(
      `Active season changed from ${setupSeason} to ${canonicalSeason} before tournament enrichment`,
    );
  }
  const transferSeason = options?.includeTransferHistory === false ? null : setupSeason;
  const pickAudit = window
    ? await auditMissingUnits(entryIds, window, 'picks')
    : { missing: new Map<number, number[]>(), totalPairs: 0 };
  const missing = pickAudit.missing;
  const missingCount = [...missing.values()].reduce((sum, ids) => sum + ids.length, 0);
  const transferEntryIds =
    options?.includeTransferHistory === false
      ? []
      : await entryEventTransfersRepository.findEntryIdsNeedingSync(
          entryIds,
          targetEventId,
          transferSeason!,
        );
  const transferUnits = transferEntryIds.length;
  const totalPickPairs = pickAudit.totalPairs;
  const enrichmentPlan = {
    totalPickPairs,
    missingPickPairs: missingCount,
    reusedPickPairs: totalPickPairs - missingCount,
    totalTransferEntries: entryIds.length,
    requestedTransferEntries: transferUnits,
    reusedTransferEntries: entryIds.length - transferUnits,
  } satisfies TournamentEnrichmentPlan;
  await options?.onPlan?.(enrichmentPlan);
  const eventIds = window
    ? Array.from(
        { length: window.endEventId - window.startEventId + 1 },
        (_, index) => window.endEventId - index,
      )
    : [];
  const total = transferUnits + missingCount + eventIds.length;
  let completed = 0;
  logInfo('Tournament history enrichment planned', {
    tournamentId,
    entryCount: entryIds.length,
    eventCount: eventIds.length,
    missingPickPairs: missingCount,
    missingPickEvents: missing.size,
    transferHistoryCalls: transferUnits,
    reusedTransferEntries: enrichmentPlan.reusedTransferEntries,
    reusedPickPairs: enrichmentPlan.reusedPickPairs,
    totalUnits: total,
  });

  if (transferEntryIds.length > 0) {
    const transferResult = await syncEntryTransferHistories(transferEntryIds, targetEventId, {
      concurrency: ENTRY_SYNC_DEFAULT_CONCURRENCY,
      season: transferSeason!,
    });
    completed += transferEntryIds.length;
    await options?.onProgress?.(completed, total);
    if (transferResult.errors > 0) {
      issues.push({
        scope: 'event-results',
        message: `Failed to sync transfer history for ${transferResult.errors} entries`,
        failedEntries: transferResult.failedEntryIds,
      });
    }
  }

  for (const eventId of eventIds) {
    const missingEntryIds = missing.get(eventId) ?? [];
    try {
      if (missingEntryIds.length > 0) {
        await syncTournamentEventResultsForEntryIds(missingEntryIds, eventId, {
          concurrency: ENTRY_SYNC_DEFAULT_CONCURRENCY,
          skipTransfers: true,
          season: setupSeason,
        });
      }
      const leagueResult = await syncLeagueEventResultsByTournament(tournamentId, eventId, {
        concurrency: ENTRY_SYNC_DEFAULT_CONCURRENCY,
        season: setupSeason,
      });
      if (leagueResult.updated < entryIds.length || leagueResult.skipped > 0) {
        issues.push({
          scope: 'league-event-results',
          eventId,
          message: `League insights incomplete for event ${eventId}: ${leagueResult.updated}/${entryIds.length}`,
        });
      }

      const selectionResult = await syncTournamentSelectionStats(eventId, {
        tournamentIds: [tournamentId],
      });
      if (entryIds.length > 0 && selectionResult.upserted === 0) {
        issues.push({
          scope: 'event-results',
          eventId,
          message: `Selection insights are incomplete for event ${eventId}`,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown enrichment failure';
      issues.push({
        scope: 'event-results',
        eventId,
        message,
        failedEntries: missingEntryIds,
      });
      logError('Tournament history enrichment failed for event', error, {
        tournamentId,
        eventId,
        missingEntryIds,
      });
    }
    completed += missingEntryIds.length + 1;
    await options?.onProgress?.(completed, total);
  }

  logInfo('Tournament history enrichment completed', {
    tournamentId,
    completedUnits: completed,
    totalUnits: total,
    warningCount: issues.length,
  });

  return issues;
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

  // Structure writes only: hold tournament-structure:global around points /
  // knockout upserts — not around FPL entry/league fetch above (Codex P2).
  const structureScopes = tournamentSetupBackfillEventScopes(eventId);

  if (
    tournament.groupMode === 'points_races' &&
    tournament.groupStartedEventId &&
    tournament.groupEndedEventId &&
    eventId >= tournament.groupStartedEventId &&
    eventId <= tournament.groupEndedEventId
  ) {
    const pointsRaceResult = await withMutationConflictGuard(
      {
        queueName: 'tournament-setup',
        jobName: 'tournament-setup',
        tournamentId,
        eventId,
        scopes: structureScopes,
      },
      () => syncTournamentPointsRaceResultsForTournament(tournament, eventId),
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
    tournament.groupMode === 'battle_races' &&
    tournament.groupStartedEventId &&
    tournament.groupEndedEventId &&
    eventId >= tournament.groupStartedEventId &&
    eventId <= tournament.groupEndedEventId
  ) {
    const battleRaceResult = await withMutationConflictGuard(
      {
        queueName: 'tournament-setup',
        jobName: 'tournament-setup',
        tournamentId,
        eventId,
        scopes: structureScopes,
      },
      () => syncTournamentBattleRaceResultsForTournament(tournament, eventId),
    );
    if (battleRaceResult.skipped > 0) {
      issues.push({
        scope: 'battle-race',
        eventId,
        message: `Tournament battle race sync incomplete for event ${eventId}: skipped ${battleRaceResult.skipped}`,
      });
      logWarn('Tournament battle race sync completed with warnings', {
        tournamentId,
        eventId,
        skipped: battleRaceResult.skipped,
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
    const knockoutResult = await withMutationConflictGuard(
      {
        queueName: 'tournament-setup',
        jobName: 'tournament-setup',
        tournamentId,
        eventId,
        scopes: structureScopes,
      },
      () => syncKnockoutForTournament(tournament, eventId),
    );
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
    // Structure locks are acquired only around points/knockout writes inside
    // runTournamentEventBackfill — not around FPL fetch for the whole event.
    const eventIssues = await runTournamentEventBackfill(
      tournamentId,
      tournament,
      entryIds,
      eventId,
    );
    issues.push(...eventIssues);
  }

  return issues;
}
