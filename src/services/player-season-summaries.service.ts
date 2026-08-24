import type postgres from 'postgres';

import {
  databaseTransactionStorage,
  getDb,
  getDbClient,
  runInDatabaseTransaction,
  withDatabaseSavepoint,
} from '../db/singleton';
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

type PlayerStateSourceMarkerRow = {
  source_updated_at: Date | string;
  understat_source_updated_at: Date | string;
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
  const sourceMarker = await advancePlayerStateSourceMarker(season);
  const result = {
    revision: Number(row.revision),
    playerCount: row.player_count,
    understatPlayerCount: row.understat_player_count,
    sourceUpdatedAt: iso(sourceMarker.source_updated_at),
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

/**
 * Provider reconciliation mutates shared bridge rows. Keep an unscoped repair
 * atomic as well as protecting resource mutations with a savepoint, otherwise
 * a statement failure can leave an earlier quarantine or confirmation behind.
 */
async function withPlayerStateReconciliationTransaction<T>(
  operation: () => Promise<T>,
): Promise<T> {
  if (databaseTransactionStorage.getStore()) return withDatabaseSavepoint(operation);

  const db = await getDb();
  return (await db.transaction(async (drizzleTransaction) => {
    const transaction = (
      drizzleTransaction as unknown as {
        session?: { client?: postgres.TransactionSql };
      }
    ).session?.client;
    if (!transaction) {
      throw new Error('Drizzle transaction did not expose its pinned postgres client');
    }
    return runInDatabaseTransaction(transaction, operation, drizzleTransaction);
  })) as T;
}

/** Persist every Understat source timestamp consumed by the Player State repair selector. */
async function advancePlayerStateSourceMarker(
  season: FplSeasonRef,
): Promise<PlayerStateSourceMarkerRow> {
  const client = await getDbClient();
  const rows = await client<PlayerStateSourceMarkerRow[]>`
    WITH understat_source AS (
      SELECT GREATEST(
        COALESCE((
          SELECT max(metrics.updated_at)
          FROM understat.player_seasons metrics
          WHERE metrics.season_code = ${season.seasonCode}
        ), '-infinity'::timestamptz),
        COALESCE((
          SELECT max(provider_season.updated_at)
          FROM understat.seasons provider_season
          WHERE provider_season.season_code = ${season.seasonCode}
        ), '-infinity'::timestamptz),
        COALESCE((
          SELECT max(understat_match.updated_at)
          FROM understat.matches understat_match
          WHERE understat_match.season_code = ${season.seasonCode}
        ), '-infinity'::timestamptz),
        COALESCE((
          SELECT max(team_season.updated_at)
          FROM understat.player_team_seasons team_season
          WHERE team_season.season_code = ${season.seasonCode}
        ), '-infinity'::timestamptz),
        COALESCE((
          SELECT max(match_stats.updated_at)
          FROM understat.player_match_stats match_stats
          INNER JOIN understat.matches understat_match
            ON understat_match.match_id = match_stats.match_id
          WHERE understat_match.season_code = ${season.seasonCode}
        ), '-infinity'::timestamptz)
      ) AS source_updated_at
    )
    UPDATE reporting.player_state_season_refreshes refresh
    SET
      understat_source_updated_at = GREATEST(
        refresh.understat_source_updated_at,
        understat_source.source_updated_at
      ),
      source_updated_at = GREATEST(refresh.source_updated_at, understat_source.source_updated_at)
    FROM understat_source
    WHERE refresh.season_id = ${season.seasonId}::smallint
    RETURNING refresh.source_updated_at, refresh.understat_source_updated_at
  `;
  const row = rows[0];
  if (!row) {
    throw new Error(`Player State source marker update returned no row for ${season.seasonCode}`);
  }
  return row;
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
  const mappings = await withPlayerStateReconciliationTransaction(() =>
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
            SELECT max(understat_match.updated_at)
            FROM understat.matches understat_match
            WHERE understat_match.season_code = season.season_code
          ), '-infinity'::timestamptz),
          COALESCE((
            SELECT max(team_season.updated_at)
            FROM understat.player_team_seasons team_season
            WHERE team_season.season_code = season.season_code
          ), '-infinity'::timestamptz),
          COALESCE((
            SELECT max(match_stats.updated_at)
            FROM understat.player_match_stats match_stats
            INNER JOIN understat.matches understat_match
              ON understat_match.match_id = match_stats.match_id
            WHERE understat_match.season_code = season.season_code
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

  const failures: { season: FplSeasonRef; reason: unknown }[] = [];
  let refreshed = 0;
  for (const season of seasons) {
    try {
      await publishUnderstatPlayerState(season);
      refreshed += 1;
    } catch (reason) {
      failures.push({ season, reason });
    }
  }
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
  return { checked: seasons.length, refreshed };
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
