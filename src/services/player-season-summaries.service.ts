import { getDbClient } from '../db/singleton';
import type { FplSeasonRef } from '../domain/fpl-season';
import { logError, logInfo } from '../utils/logger';

export type PlayerSeasonSummaryRefresh = Readonly<{
  revision: number;
  playerCount: number;
  statsRowCount: number;
  sourceUpdatedAt: string;
  refreshedAt: string;
}>;

type RefreshRow = {
  revision: number | string;
  player_count: number;
  stats_row_count: number | string;
  source_updated_at: Date | string;
  refreshed_at: Date | string;
};

type StaleSeasonRow = {
  season_id: number;
  season_code: string;
};

const iso = (value: Date | string): string =>
  (value instanceof Date ? value : new Date(value)).toISOString();

export async function refreshPlayerSeasonSummaries(
  season: FplSeasonRef,
): Promise<PlayerSeasonSummaryRefresh> {
  const client = await getDbClient();
  const rows = await client<RefreshRow[]>`
    SELECT revision, player_count, stats_row_count, source_updated_at, refreshed_at
    FROM reporting.refresh_player_season_summaries(${season.seasonId}::smallint)
  `;
  const row = rows[0];
  if (!row) {
    throw new Error(`Player season summary refresh returned no metadata for ${season.seasonCode}`);
  }
  const result = {
    revision: Number(row.revision),
    playerCount: row.player_count,
    statsRowCount: Number(row.stats_row_count),
    sourceUpdatedAt: iso(row.source_updated_at),
    refreshedAt: iso(row.refreshed_at),
  };
  logInfo('Player season summary rows refreshed', {
    season: season.seasonCode,
    revision: result.revision,
    playerCount: result.playerCount,
    statsRowCount: result.statsRowCount,
  });
  return result;
}

async function findStalePlayerSeasonSummaries(): Promise<FplSeasonRef[]> {
  const client = await getDbClient();
  const rows = await client<StaleSeasonRow[]>`
    WITH source_revisions AS (
      SELECT
        season.season_id,
        season.season_code,
        GREATEST(
          COALESCE((
            SELECT max(player.updated_at)
            FROM fpl.players player
            WHERE player.season_id = season.season_id
          ), '-infinity'::timestamptz),
          COALESCE((
            SELECT max(stats.updated_at)
            FROM fpl.player_gameweek_stats stats
            WHERE stats.season_id = season.season_id
          ), '-infinity'::timestamptz)
        ) AS source_updated_at
      FROM fpl.seasons season
    )
    SELECT source.season_id, source.season_code
    FROM source_revisions source
    LEFT JOIN reporting.player_season_summary_refreshes refresh
      ON refresh.season_id = source.season_id
    WHERE refresh.season_id IS NULL
      OR refresh.source_updated_at < source.source_updated_at
    ORDER BY source.season_id
  `;
  return rows.map((row) => ({ seasonId: row.season_id, seasonCode: row.season_code }));
}

export async function repairPlayerSeasonSummaries(): Promise<{
  checked: number;
  refreshed: number;
}> {
  const seasons = await findStalePlayerSeasonSummaries();
  if (seasons.length === 0) return { checked: 0, refreshed: 0 };

  const results = await Promise.allSettled(seasons.map(refreshPlayerSeasonSummaries));
  const failures = results.flatMap((result, index) =>
    result.status === 'rejected' ? [{ season: seasons[index], reason: result.reason }] : [],
  );
  for (const failure of failures) {
    logError('Player season summary repair failed', failure.reason, {
      season: failure.season.seasonCode,
    });
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure) => failure.reason),
      `Failed to repair ${failures.length} player season summary scope(s)`,
    );
  }
  return { checked: seasons.length, refreshed: results.length };
}
