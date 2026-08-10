import { getDbClient } from '../db/singleton';
import { logError, logInfo } from '../utils/logger';

import { refreshTournamentSelectionStatsMaterializedView } from './tournament-selection-stats.service';

/** Refresh the reporting snapshot used by tournament ranking/event-result reads. */
export async function refreshTournamentEntryEventSummariesMaterializedView(): Promise<void> {
  const client = await getDbClient();
  try {
    await client`SELECT reporting.refresh_tournament_entry_event_summaries()`;
    logInfo('Refreshed reporting.tournament_entry_event_summaries');
  } catch (error) {
    logError('Failed to refresh tournament entry-event summaries', error);
    throw error;
  }
}

/**
 * Finalization refresh. Selection statistics are refreshed by the dedicated
 * post-transfer job, so this path only refreshes the remaining reporting MV.
 */
export async function refreshTournamentMaterializedViews(): Promise<{
  selectionStats: boolean;
  entryEventSummaries: boolean;
}> {
  await refreshTournamentEntryEventSummariesMaterializedView();
  return { selectionStats: false, entryEventSummaries: true };
}

/**
 * A deleted tournament can remain in either MV until the next refresh. Only
 * pay the two global refresh costs when stale rows are actually present.
 */
export async function repairDeletedTournamentMaterializedViews(
  tournamentId: number,
): Promise<boolean> {
  const client = await getDbClient();
  const rows = await client<Array<{ exists: boolean }>>`
    SELECT
      EXISTS (
        SELECT 1
        FROM reporting.tournament_selection_stats
        WHERE tournament_id = ${tournamentId}
      ) OR EXISTS (
        SELECT 1
        FROM reporting.tournament_entry_event_summaries
        WHERE tournament_id = ${tournamentId}
      ) AS exists
  `;
  if (rows[0]?.exists !== true) return false;

  await refreshTournamentSelectionStatsMaterializedView();
  await refreshTournamentEntryEventSummariesMaterializedView();
  return true;
}
