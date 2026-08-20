import { getDbClient } from '../db/singleton';
import type { FplSeasonRef } from '../domain/fpl-season';
import { tournamentInfoRepository } from '../repositories/tournament-infos';
import { DatabaseError, IncompleteDataSyncError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';
import { publishTournamentTrendScopes } from './tournament-trends-publication.service';

type ScopeAudit = {
  tournamentId: number;
  expectedEntries: number;
  completePickEntries: number;
  transferCheckpointEntries: number;
};

function uniquePositiveIds(ids: readonly number[]): number[] {
  return [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];
}

async function auditSelectionSourceScopes(
  season: FplSeasonRef,
  tournamentIds: number[],
  eventId: number,
): Promise<ScopeAudit[]> {
  if (tournamentIds.length === 0) return [];
  const client = await getDbClient();
  const rows = await client<
    Array<{
      tournament_id: number;
      expected_entries: number;
      complete_pick_entries: number;
      transfer_checkpoint_entries: number;
    }>
  >`
    WITH requested AS (
      SELECT unnest(${tournamentIds}::int[]) AS tournament_id
    ), tournament_scope AS (
      SELECT tournament.tournament_id
      FROM requested
      JOIN competition.tournaments tournament
        ON tournament.tournament_id = requested.tournament_id
       AND tournament.season_id = ${season.seasonId}
    ), eligible_entries AS (
      SELECT
        scope.tournament_id,
        entry.entry_id,
        entry.transfers_synced_through_event_id
      FROM tournament_scope scope
      JOIN competition.tournament_entries tournament_entry
        ON tournament_entry.tournament_id = scope.tournament_id
       AND tournament_entry.season_id = ${season.seasonId}
      JOIN competition.entries entry
        ON entry.season_id = tournament_entry.season_id
       AND entry.entry_id = tournament_entry.entry_id
      WHERE entry.started_event IS NULL OR entry.started_event <= ${eventId}
    ), valid_pick_entries AS (
      SELECT eligible.tournament_id, eligible.entry_id
      FROM eligible_entries eligible
      JOIN competition.entry_event_picks pick
        ON pick.season_id = ${season.seasonId}
       AND pick.entry_id = eligible.entry_id
       AND pick.event_id = ${eventId}
      GROUP BY eligible.tournament_id, eligible.entry_id
      HAVING count(*) = 15
         AND min(pick.position) = 1
         AND max(pick.position) = 15
         AND count(*) FILTER (WHERE pick.is_captain) = 1
         AND count(*) FILTER (WHERE pick.is_vice_captain) = 1
    )
    SELECT
      scope.tournament_id,
      count(eligible.entry_id)::int AS expected_entries,
      count(valid.entry_id)::int AS complete_pick_entries,
      count(eligible.entry_id) FILTER (
        WHERE eligible.transfers_synced_through_event_id >= ${eventId}
      )::int AS transfer_checkpoint_entries
    FROM tournament_scope scope
    LEFT JOIN eligible_entries eligible
      ON eligible.tournament_id = scope.tournament_id
    LEFT JOIN valid_pick_entries valid
      ON valid.tournament_id = eligible.tournament_id
     AND valid.entry_id = eligible.entry_id
    GROUP BY scope.tournament_id
    ORDER BY scope.tournament_id
  `;
  return rows.map((row) => ({
    tournamentId: Number(row.tournament_id),
    expectedEntries: Number(row.expected_entries),
    completePickEntries: Number(row.complete_pick_entries),
    transferCheckpointEntries: Number(row.transfer_checkpoint_entries),
  }));
}

export async function refreshTournamentSelectionStatsMaterializedView(): Promise<void> {
  const client = await getDbClient();
  await client`SELECT reporting.refresh_tournament_selection_stats()`;
}

async function countPublishedRows(
  season: FplSeasonRef,
  tournamentIds: number[],
  eventId: number,
): Promise<{ rows: number; tournaments: number }> {
  if (tournamentIds.length === 0) return { rows: 0, tournaments: 0 };
  const client = await getDbClient();
  const rows = await client<Array<{ row_count: number; tournament_count: number }>>`
    SELECT
      count(*)::int AS row_count,
      count(DISTINCT tournament_id)::int AS tournament_count
    FROM reporting.tournament_selection_stats
    WHERE season_id = ${season.seasonId}
      AND event_id = ${eventId}
      AND tournament_id = ANY(${tournamentIds}::int[])
  `;
  return {
    rows: Number(rows[0]?.row_count ?? 0),
    tournaments: Number(rows[0]?.tournament_count ?? 0),
  };
}

export async function syncTournamentSelectionStats(
  season: FplSeasonRef,
  eventId: number,
  options?: { tournamentIds?: number[] },
): Promise<{
  eventId: number;
  tournaments: number;
  sourceEntries: number;
  rows: number;
  requiredUnits: number;
  reusedUnits: number;
  succeededUnits: number;
  failedUnits: number;
}> {
  const empty = {
    eventId,
    tournaments: 0,
    sourceEntries: 0,
    rows: 0,
    requiredUnits: 0,
    reusedUnits: 0,
    succeededUnits: 0,
    failedUnits: 0,
  };
  if (!Number.isInteger(eventId) || eventId <= 0 || eventId > 38) {
    logInfo('Skipping tournament selection stats refresh - invalid event', { eventId });
    return empty;
  }

  try {
    const tournamentIds = options?.tournamentIds
      ? uniquePositiveIds(options.tournamentIds)
      : (await tournamentInfoRepository.findActive(season)).map((tournament) => tournament.id);
    if (tournamentIds.length === 0) return empty;

    // The immutable per-scope read model is the new Trends path.  Keep the
    // legacy MV best-effort during the compatibility window; a failed scope
    // must not prevent other tournaments from publishing.
    const publication = await publishTournamentTrendScopes(season, eventId, tournamentIds);
    if (publication.failed > 0) {
      logError('Some tournament Trends scopes failed to publish', undefined, {
        season: season.seasonCode,
        eventId,
        failed: publication.failed,
      });
    }

    const audits = await auditSelectionSourceScopes(season, tournamentIds, eventId);
    if (audits.length !== tournamentIds.length) {
      throw new IncompleteDataSyncError(
        'Tournament selection statistics contain an invalid season or tournament scope',
        tournamentIds.length,
        0,
        audits.length,
        tournamentIds.length - audits.length,
      );
    }

    const incomplete = audits.filter(
      (audit) =>
        audit.completePickEntries !== audit.expectedEntries ||
        audit.transferCheckpointEntries !== audit.expectedEntries,
    );
    if (incomplete.length > 0) {
      const expected = incomplete.reduce((sum, audit) => sum + audit.expectedEntries, 0);
      const complete = incomplete.reduce(
        (sum, audit) => sum + Math.min(audit.completePickEntries, audit.transferCheckpointEntries),
        0,
      );
      throw new IncompleteDataSyncError(
        'Tournament selection statistics require complete picks and transfer checkpoints',
        expected,
        0,
        complete,
        expected - complete,
      );
    }

    await refreshTournamentSelectionStatsMaterializedView();
    const published = await countPublishedRows(season, tournamentIds, eventId);
    const tournamentsWithEntries = audits.filter((audit) => audit.expectedEntries > 0).length;
    if (published.tournaments !== tournamentsWithEntries) {
      throw new IncompleteDataSyncError(
        'Tournament selection statistics materialized view did not publish every complete scope',
        tournamentsWithEntries,
        0,
        published.tournaments,
        tournamentsWithEntries - published.tournaments,
      );
    }

    const sourceEntries = audits.reduce((sum, audit) => sum + audit.expectedEntries, 0);
    logInfo('Tournament selection stats materialized view refreshed', {
      season: season.seasonCode,
      eventId,
      tournaments: tournamentIds.length,
      sourceEntries,
      rows: published.rows,
    });
    return {
      eventId,
      tournaments: tournamentIds.length,
      sourceEntries,
      rows: published.rows,
      requiredUnits: tournamentsWithEntries,
      reusedUnits: 0,
      succeededUnits: published.tournaments,
      failedUnits: 0,
    };
  } catch (error) {
    logError('Failed to refresh tournament selection stats', error, {
      season: season.seasonCode,
      eventId,
    });
    if (error instanceof IncompleteDataSyncError) throw error;
    throw new DatabaseError(
      'Failed to refresh tournament selection stats',
      'TOURNAMENT_SELECTION_STATS_REFRESH_ERROR',
      error instanceof Error ? error : undefined,
    );
  }
}
