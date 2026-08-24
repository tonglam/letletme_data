import { databaseTransactionStorage, getDbClient, withDatabaseSavepoint } from '../db/singleton';
import type { FplSeasonRef } from '../domain/fpl-season';
import { logError, logInfo, logWarn } from '../utils/logger';
import { reconcileProviderMappings } from './provider-matcher.service';

export type PlayerSeasonSummaryRefresh = Readonly<{
  revision: number;
  playerCount: number;
  statsRowCount: number;
  sourceUpdatedAt: string;
  refreshedAt: string;
}>;

export type PlayerStateSeasonRefresh = Readonly<{
  revision: number;
  playerCount: number;
  understatPlayerCount: number;
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

type PlayerStateRefreshRow = {
  revision: number | string;
  player_count: number;
  understat_player_count: number;
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
  // Keep the expensive cross-provider projection in the same refresh trigger
  // path. Canonical FPL facts are already committed; a projection failure is
  // left for the bounded repair job instead of reporting the FPL refresh as a
  // failure after its transaction has committed.
  try {
    await refreshPlayerStateSeasonSafely(season);
  } catch (error) {
    logWarn('Player State refresh after FPL summary refresh failed; repair will retry', {
      season: season.seasonCode,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return result;
}

/** Publish the cross-provider Player State projection for one FPL season. */
export async function refreshPlayerStateSeason(
  season: FplSeasonRef,
): Promise<PlayerStateSeasonRefresh> {
  const client = await getDbClient();
  const rows = await client<PlayerStateRefreshRow[]>`
    SELECT revision, player_count, understat_player_count, source_updated_at, refreshed_at
    FROM reporting.refresh_player_state_season(${season.seasonId}::smallint)
  `;
  const row = rows[0];
  if (!row) {
    throw new Error(`Player State refresh returned no metadata for ${season.seasonCode}`);
  }
  const result = {
    revision: Number(row.revision),
    playerCount: row.player_count,
    understatPlayerCount: row.understat_player_count,
    sourceUpdatedAt: iso(row.source_updated_at),
    refreshedAt: iso(row.refreshed_at),
  };
  logInfo('Player State season rows refreshed', {
    season: season.seasonCode,
    revision: result.revision,
    playerCount: result.playerCount,
    understatPlayerCount: result.understatPlayerCount,
  });
  return result;
}

async function withPlayerStateProjectionSavepoint<T>(operation: () => Promise<T>): Promise<T> {
  if (!databaseTransactionStorage.getStore()) return operation();
  return withDatabaseSavepoint(operation);
}

/** Refresh Player State without allowing a projection failure to abort its caller's write. */
export async function refreshPlayerStateSeasonSafely(
  season: FplSeasonRef,
): Promise<PlayerStateSeasonRefresh> {
  return withPlayerStateProjectionSavepoint(() => refreshPlayerStateSeason(season));
}

/**
 * Reconcile the verified provider bridge and publish the cross-provider read
 * model after an Understat resource commits. A resource may be published
 * while sibling resources are still running or have failed, so callers must
 * treat this as a best-effort projection step and leave canonical facts
 * untouched when it fails.
 */
export async function publishUnderstatPlayerState(season: FplSeasonRef): Promise<{
  mappings: Awaited<ReturnType<typeof reconcileProviderMappings>>;
  refresh: PlayerStateSeasonRefresh;
}> {
  const mappings = await withPlayerStateProjectionSavepoint(() =>
    reconcileProviderMappings(season.seasonCode),
  );
  const refresh = await withPlayerStateProjectionSavepoint(() => refreshPlayerStateSeason(season));
  logInfo('Understat Player State published', {
    season: season.seasonCode,
    mappingMatches: mappings.matches.verified,
    mappingPlayers: mappings.players.verified,
    confirmedPlayers: mappings.players.confirmed,
    revision: refresh.revision,
    understatPlayerCount: refresh.understatPlayerCount,
  });
  return { mappings, refresh };
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

async function findStalePlayerStateSeasons(): Promise<FplSeasonRef[]> {
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
            SELECT max(summary.source_updated_at)
            FROM reporting.player_season_summary_rows summary
            WHERE summary.season_id = season.season_id
          ), '-infinity'::timestamptz),
          COALESCE((
            SELECT max(metrics.updated_at)
            FROM understat.player_seasons metrics
            WHERE metrics.season_code = season.season_code
          ), '-infinity'::timestamptz),
          COALESCE((
            SELECT max(provider_season.updated_at)
            FROM understat.seasons provider_season
            WHERE provider_season.season_code = season.season_code
          ), '-infinity'::timestamptz),
          COALESCE((
            SELECT max(link.updated_at)
            FROM bridge.entity_links link
            WHERE link.entity_type = 'player'
              AND link.left_provider = 'understat'
              AND link.right_provider = 'fpl'
          ), '-infinity'::timestamptz)
        ) AS source_updated_at
      FROM fpl.seasons season
    )
    SELECT source.season_id, source.season_code
    FROM source_revisions source
    LEFT JOIN reporting.player_state_season_refreshes refresh
      ON refresh.season_id = source.season_id
    WHERE refresh.season_id IS NULL
      OR refresh.source_updated_at < source.source_updated_at
    ORDER BY source.season_id
  `;
  return rows.map((row) => ({ seasonId: row.season_id, seasonCode: row.season_code }));
}

export async function repairPlayerStateSeasons(): Promise<{
  checked: number;
  refreshed: number;
}> {
  const seasons = await findStalePlayerStateSeasons();
  if (seasons.length === 0) return { checked: 0, refreshed: 0 };

  const results = await Promise.allSettled(seasons.map(refreshPlayerStateSeason));
  const failures = results.flatMap((result, index) =>
    result.status === 'rejected' ? [{ season: seasons[index], reason: result.reason }] : [],
  );
  for (const failure of failures) {
    logError('Player State repair failed', failure.reason, {
      season: failure.season.seasonCode,
    });
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure) => failure.reason),
      `Failed to repair ${failures.length} Player State season scope(s)`,
    );
  }
  return { checked: seasons.length, refreshed: results.length };
}

export async function repairPlayerSeasonSummaries(): Promise<{
  checked: number;
  refreshed: number;
}> {
  const seasons = await findStalePlayerSeasonSummaries();
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
  const playerState = await repairPlayerStateSeasons();
  return {
    checked: seasons.length + playerState.checked,
    refreshed: results.length + playerState.refreshed,
  };
}
