import { getDbClient } from '../db/singleton';
import { logError, logInfo } from '../utils/logger';

/**
 * Refresh tournament materialized views.
 *
 * These views power the GraphQL tournament APIs (tournamentEntryRankingSummary
 * and tournamentEventResults). They must be refreshed after the underlying
 * tables (tournament_points_group_results, league_event_results, entry_infos)
 * are updated.
 *
 * Uses REFRESH MATERIALIZED VIEW CONCURRENTLY so reads are not blocked.
 * The unique indexes on the views enable concurrent refresh.
 */
export async function refreshTournamentMaterializedViews(): Promise<{
  eventSnapshot: boolean;
  tournamentSnapshot: boolean;
}> {
  const client = await getDbClient();

  try {
    logInfo('Refreshing tournament materialized views...');

    // Refresh event-level snapshot first (parent of tournament snapshot)
    await client`REFRESH MATERIALIZED VIEW CONCURRENTLY mv_tournament_event_snapshot`;
    logInfo('Refreshed mv_tournament_event_snapshot');

    // Refresh tournament-level snapshot (depends on event snapshot)
    await client`REFRESH MATERIALIZED VIEW CONCURRENTLY mv_tournament_snapshot`;
    logInfo('Refreshed mv_tournament_snapshot');

    return { eventSnapshot: true, tournamentSnapshot: true };
  } catch (error) {
    logError('Failed to refresh tournament materialized views', error);
    throw error;
  }
}

/**
 * Repair only a deletion that is still present in the published snapshot.
 * This keeps a retry idempotent after the canonical row has gone without
 * allowing arbitrary missing IDs to trigger an expensive global refresh.
 */
export async function repairDeletedTournamentMaterializedViews(
  tournamentId: number,
): Promise<boolean> {
  const client = await getDbClient();
  const rows = await client<{ exists: boolean }[]>`
    SELECT
      EXISTS (
        SELECT 1
        FROM mv_tournament_snapshot
        WHERE tournament_id = ${tournamentId}
      ) OR EXISTS (
        SELECT 1
        FROM mv_tournament_event_snapshot
        WHERE tournament_id = ${tournamentId}
      ) AS exists
  `;
  if (rows[0]?.exists !== true) return false;

  await refreshTournamentMaterializedViews();
  return true;
}
