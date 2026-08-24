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
import { withMutationScopes } from '../utils/mutation-scopes';
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

type PlayerStateRefreshOptions = Readonly<{
  advanceSourceMarker?: boolean;
  sourceWatermark?: PlayerStateSourceWatermark;
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

type PlayerStateRefreshBase = {
  revision: number;
  playerCount: number;
  understatPlayerCount: number;
  sourceUpdatedAt: string;
  refreshedAt: string;
};

type StaleSeasonRow = {
  season_id: number;
  season_code: string;
};

type PlayerStateSourceMarkerRow = {
  fpl_source_updated_at: Date | string;
  source_updated_at: Date | string;
  understat_source_updated_at: Date | string;
  bridge_source_updated_at: Date | string;
};

type PlayerStateSourceWatermark = Readonly<{
  fplSourceUpdatedAt: Date | string;
  understatSourceUpdatedAt: Date | string;
  bridgeSourceUpdatedAt: Date | string;
  sourceUpdatedAt: Date | string;
}>;

type PlayerStateSourceWatermarkRow = {
  fpl_source_updated_at: Date | string;
  understat_source_updated_at: Date | string;
  bridge_source_updated_at: Date | string;
  source_updated_at: Date | string;
};

function normalizeTimestamp(value: Date | string): Date | string {
  if (value === '-infinity' || value === 'infinity') return value;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '-infinity' : value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date;
}

const iso = (value: Date | string): string => {
  const normalized = normalizeTimestamp(value);
  return typeof normalized === 'string' ? normalized : normalized.toISOString();
};

const PLAYER_STATE_RECONCILIATION_LOCK_KEY = 'understat:player-state:reconciliation';
const PLAYER_STATE_PROJECTION_LOCK_PREFIX = 'reporting:player-state-season:';

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
  options: PlayerStateRefreshOptions = {},
): Promise<PlayerStateSeasonRefresh> {
  if (options.advanceSourceMarker && options.sourceWatermark) {
    return refreshPlayerStateSeasonWithCapturedWatermark(season, options.sourceWatermark);
  }

  if (!options.advanceSourceMarker) {
    return refreshPlayerStateSeasonPreservingMarker(season);
  }

  const base = await runPlayerStateSeasonRefresh(season);
  const sourceMarker = options.advanceSourceMarker
    ? await advancePlayerStateSourceMarker(season)
    : undefined;
  const result = buildPlayerStateSeasonRefresh(base, sourceMarker);
  logPlayerStateSeasonRefresh(season, result);
  return result;
}

async function runPlayerStateSeasonRefresh(season: FplSeasonRef): Promise<PlayerStateRefreshBase> {
  const client = await getDbClient();
  const rows = await client<PlayerStateRefreshRow[]>`
    SELECT revision, player_count, understat_player_count, source_updated_at, refreshed_at
    FROM reporting.refresh_player_state_season(${season.seasonId}::smallint)
  `;
  const row = rows[0];
  if (!row) {
    throw new Error(`Player State refresh returned no metadata for ${season.seasonCode}`);
  }
  return {
    revision: Number(row.revision),
    playerCount: row.player_count,
    understatPlayerCount: row.understat_player_count,
    sourceUpdatedAt: iso(row.source_updated_at),
    refreshedAt: iso(row.refreshed_at),
  };
}

function buildPlayerStateSeasonRefresh(
  base: PlayerStateRefreshBase,
  sourceMarker?: PlayerStateSourceMarkerRow,
): PlayerStateSeasonRefresh {
  return {
    ...base,
    sourceUpdatedAt: iso(sourceMarker?.source_updated_at ?? base.sourceUpdatedAt),
  };
}

function logPlayerStateSeasonRefresh(season: FplSeasonRef, result: PlayerStateSeasonRefresh): void {
  logInfo('Player State season rows refreshed', {
    season: season.seasonCode,
    revision: result.revision,
    playerCount: result.playerCount,
    understatPlayerCount: result.understatPlayerCount,
  });
}

async function withPlayerStateProjectionSavepoint<T>(operation: () => Promise<T>): Promise<T> {
  if (!databaseTransactionStorage.getStore()) return operation();
  return withDatabaseSavepoint(operation);
}

async function withPlayerStateProjectionTransaction<T>(
  season: FplSeasonRef,
  operation: () => Promise<T>,
): Promise<T> {
  const operationWithLock = async (): Promise<T> => {
    const client = await getDbClient();
    await client`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`${PLAYER_STATE_PROJECTION_LOCK_PREFIX}${season.seasonId}`}, 0)
      )
    `;
    return operation();
  };

  if (databaseTransactionStorage.getStore()) {
    return withDatabaseSavepoint(operationWithLock);
  }

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
    return runInDatabaseTransaction(transaction, operationWithLock, drizzleTransaction);
  })) as T;
}

async function readPlayerStateSourceMarker(
  season: FplSeasonRef,
): Promise<PlayerStateSourceMarkerRow | null> {
  const client = await getDbClient();
  const rows = await client<PlayerStateSourceMarkerRow[]>`
    SELECT
      fpl_source_updated_at::text AS fpl_source_updated_at,
      source_updated_at::text AS source_updated_at,
      understat_source_updated_at::text AS understat_source_updated_at,
      bridge_source_updated_at::text AS bridge_source_updated_at
    FROM reporting.player_state_season_refreshes
    WHERE season_id = ${season.seasonId}::smallint
  `;
  const row = rows[0];
  if (!row) return null;
  return row;
}

async function restorePlayerStateSourceMarker(
  season: FplSeasonRef,
  previousMarker: PlayerStateSourceMarkerRow | null,
): Promise<PlayerStateSourceMarkerRow> {
  const marker = previousMarker ?? {
    fpl_source_updated_at: '-infinity',
    source_updated_at: '-infinity',
    understat_source_updated_at: '-infinity',
    bridge_source_updated_at: '-infinity',
  };
  const client = await getDbClient();
  const rows = await client<PlayerStateSourceMarkerRow[]>`
    UPDATE reporting.player_state_season_refreshes
    SET
      fpl_source_updated_at = ${marker.fpl_source_updated_at}::timestamptz,
      source_updated_at = ${marker.source_updated_at}::timestamptz,
      understat_source_updated_at = ${marker.understat_source_updated_at}::timestamptz,
      bridge_source_updated_at = ${marker.bridge_source_updated_at}::timestamptz
    WHERE season_id = ${season.seasonId}::smallint
    RETURNING
      fpl_source_updated_at,
      source_updated_at,
      understat_source_updated_at,
      bridge_source_updated_at
  `;
  const row = rows[0];
  if (!row) {
    throw new Error(`Player State source marker restore returned no row for ${season.seasonCode}`);
  }
  return row;
}

async function refreshPlayerStateSeasonWithCapturedWatermark(
  season: FplSeasonRef,
  watermark: PlayerStateSourceWatermark,
): Promise<PlayerStateSeasonRefresh> {
  return withPlayerStateProjectionTransaction(season, async () => {
    // The stored procedure derives marker columns from its own later snapshot.
    // Keep the pre-projection marker as a floor, then restore the captured
    // reconciliation watermark after the procedure returns so a concurrent
    // FPL write cannot be mistaken for data consumed by this reconciliation.
    const previousMarker = await readPlayerStateSourceMarker(season);
    const base = await runPlayerStateSeasonRefresh(season);
    const sourceMarker = await advancePlayerStateSourceMarker(season, watermark, previousMarker);
    const result = buildPlayerStateSeasonRefresh(base, sourceMarker);
    logPlayerStateSeasonRefresh(season, result);
    return result;
  });
}

async function refreshPlayerStateSeasonPreservingMarker(
  season: FplSeasonRef,
): Promise<PlayerStateSeasonRefresh> {
  return withPlayerStateProjectionTransaction(season, async () => {
    // Projection-only callers cannot prove that provider reconciliation ran.
    // Keep their read-model refresh useful, but do not let the stored procedure
    // advance a marker that a failed bridge reconciliation still needs.
    const previousMarker = await readPlayerStateSourceMarker(season);
    const base = await runPlayerStateSeasonRefresh(season);
    const sourceMarker = await restorePlayerStateSourceMarker(season, previousMarker);
    const result = buildPlayerStateSeasonRefresh(base, previousMarker ? sourceMarker : undefined);
    logPlayerStateSeasonRefresh(season, result);
    return result;
  });
}

/**
 * Provider reconciliation mutates shared bridge rows. Keep an unscoped repair
 * atomic as well as protecting resource mutations with a savepoint, otherwise
 * a statement failure can leave an earlier quarantine or confirmation behind.
 */
async function withPlayerStateReconciliationTransaction<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const operationWithLock = async (): Promise<T> => {
    const client = await getDbClient();
    // confirmedSeasons is shared by every season's entity-link upsert. A
    // season-local loop or mutation scope is not enough when an API repair,
    // hourly repair, and Understat worker run in separate transactions.
    await client`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${PLAYER_STATE_RECONCILIATION_LOCK_KEY}, 0)
      )
    `;
    return operation();
  };

  if (databaseTransactionStorage.getStore()) {
    return withDatabaseSavepoint(operationWithLock);
  }

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
    return runInDatabaseTransaction(transaction, operationWithLock, drizzleTransaction);
  })) as T;
}

/**
 * Capture the source watermark before provider reconciliation starts.  FPL
 * live writers use different mutation scopes, so a fixture-stat commit can
 * race the bridge read.  Advancing the marker from this snapshot leaves that
 * later commit selected for the next repair pass instead of silently treating
 * it as consumed.
 */
async function readPlayerStateSourceWatermark(
  season: FplSeasonRef,
): Promise<PlayerStateSourceWatermark> {
  const client = await getDbClient();
  const rows = await client<PlayerStateSourceWatermarkRow[]>`
    WITH fpl_source AS (
      SELECT GREATEST(
        COALESCE((
          SELECT max(player.updated_at)
          FROM fpl.players player
          WHERE player.season_id = ${season.seasonId}::smallint
        ), '-infinity'::timestamptz),
        COALESCE((
          SELECT max(summary.source_updated_at)
          FROM reporting.player_season_summary_rows summary
          WHERE summary.season_id = ${season.seasonId}::smallint
        ), '-infinity'::timestamptz),
        COALESCE((
          SELECT max(fixture.updated_at)
          FROM fpl.fixtures fixture
          WHERE fixture.season_id = ${season.seasonId}::smallint
        ), '-infinity'::timestamptz),
        COALESCE((
          SELECT max(fixture_stat.updated_at)
          FROM fpl.player_fixture_stats fixture_stat
          WHERE fixture_stat.season_id = ${season.seasonId}::smallint
        ), '-infinity'::timestamptz)
      ) AS source_updated_at
    ),
    understat_source AS (
      SELECT GREATEST(
        COALESCE((
          SELECT max(metrics.updated_at)
          FROM understat.player_seasons metrics
          WHERE metrics.season_code = ${season.seasonCode}
        ), '-infinity'::timestamptz),
        COALESCE((
          SELECT max(player.updated_at)
          FROM understat.players player
          WHERE player.first_seen_season <= ${season.seasonCode}
            AND player.last_seen_season >= ${season.seasonCode}
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
    ),
    bridge_source AS (
      SELECT GREATEST(
        COALESCE((
          SELECT max(team_link.updated_at)
          FROM bridge.entity_links team_link
          WHERE team_link.entity_type = 'team'
            AND team_link.left_provider = 'understat'
            AND team_link.right_provider = 'fpl'
            AND (
              team_link.first_seen_season IS NULL
              OR team_link.first_seen_season <= ${season.seasonCode}
            )
            AND (
              team_link.last_seen_season IS NULL
              OR team_link.last_seen_season >= ${season.seasonCode}
            )
        ), '-infinity'::timestamptz),
        COALESCE((
          SELECT max(player_link.updated_at)
          FROM bridge.entity_links player_link
          WHERE player_link.entity_type = 'player'
            AND player_link.left_provider = 'understat'
            AND player_link.right_provider = 'fpl'
        ), '-infinity'::timestamptz),
        COALESCE((
          SELECT max(match_link.updated_at)
          FROM bridge.match_links match_link
          WHERE match_link.season_code = ${season.seasonCode}
            AND match_link.left_provider = 'understat'
            AND match_link.right_provider = 'fpl'
        ), '-infinity'::timestamptz)
      ) AS source_updated_at
    )
    SELECT
      fpl_source.source_updated_at::text AS fpl_source_updated_at,
      understat_source.source_updated_at::text AS understat_source_updated_at,
      bridge_source.source_updated_at::text AS bridge_source_updated_at,
      GREATEST(
        fpl_source.source_updated_at,
        understat_source.source_updated_at,
        bridge_source.source_updated_at
      )::text AS source_updated_at
    FROM fpl_source, understat_source, bridge_source
  `;
  const row = rows[0];
  if (!row) {
    throw new Error(`Player State source watermark returned no row for ${season.seasonCode}`);
  }
  return {
    fplSourceUpdatedAt: row.fpl_source_updated_at,
    understatSourceUpdatedAt: row.understat_source_updated_at,
    bridgeSourceUpdatedAt: row.bridge_source_updated_at,
    sourceUpdatedAt: row.source_updated_at,
  };
}

function sourceTimestampMicros(value: Date | string): number {
  if (value === '-infinity') return Number.NEGATIVE_INFINITY;
  if (value === 'infinity') return Number.POSITIVE_INFINITY;
  const text = value instanceof Date ? value.toISOString() : value;
  const millis = Date.parse(text);
  if (Number.isNaN(millis)) return Number.NEGATIVE_INFINITY;
  const fraction = text.match(/\.(\d+)(?=(?:Z|[+-]\d{2}(?::?\d{2})?)$)/)?.[1] ?? '';
  const micros = Number(fraction.padEnd(6, '0').slice(0, 6));
  return Math.floor(millis / 1_000) * 1_000_000 + micros;
}

function maxSourceTimestamp(...values: Array<Date | string>): Date | string {
  return values.reduce((latest, value) =>
    sourceTimestampMicros(value) > sourceTimestampMicros(latest) ? value : latest,
  );
}

/** Persist only the source watermark consumed by the preceding reconciliation. */
async function advancePlayerStateSourceMarker(
  season: FplSeasonRef,
  watermark?: PlayerStateSourceWatermark,
  previousMarker?: PlayerStateSourceMarkerRow | null,
): Promise<PlayerStateSourceMarkerRow> {
  const captured = watermark ?? (await readPlayerStateSourceWatermark(season));
  const markerFloor = watermark
    ? {
        fpl: previousMarker?.fpl_source_updated_at ?? '-infinity',
        understat: previousMarker?.understat_source_updated_at ?? '-infinity',
        bridge: previousMarker?.bridge_source_updated_at ?? '-infinity',
        source: previousMarker?.source_updated_at ?? '-infinity',
      }
    : null;
  const client = await getDbClient();
  const rows = await client<PlayerStateSourceMarkerRow[]>`
    UPDATE reporting.player_state_season_refreshes refresh
    SET
      fpl_source_updated_at = GREATEST(
        COALESCE(
          ${markerFloor?.fpl ?? null}::timestamptz,
          refresh.fpl_source_updated_at
        ),
        ${captured.fplSourceUpdatedAt}::timestamptz
      ),
      understat_source_updated_at = GREATEST(
        COALESCE(
          ${markerFloor?.understat ?? null}::timestamptz,
          refresh.understat_source_updated_at
        ),
        ${captured.understatSourceUpdatedAt}::timestamptz
      ),
      bridge_source_updated_at = GREATEST(
        COALESCE(
          ${markerFloor?.bridge ?? null}::timestamptz,
          refresh.bridge_source_updated_at
        ),
        ${captured.bridgeSourceUpdatedAt}::timestamptz
      ),
      source_updated_at = GREATEST(
        COALESCE(
          ${markerFloor?.source ?? null}::timestamptz,
          refresh.source_updated_at
        ),
        ${captured.sourceUpdatedAt}::timestamptz
      )
    WHERE refresh.season_id = ${season.seasonId}::smallint
    RETURNING
      refresh.fpl_source_updated_at,
      refresh.source_updated_at,
      refresh.understat_source_updated_at,
      refresh.bridge_source_updated_at
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
  options: PlayerStateRefreshOptions = {},
): Promise<PlayerStateSeasonRefresh> {
  if (options.advanceSourceMarker && options.sourceWatermark) {
    return refreshPlayerStateSeason(season, options);
  }
  return withPlayerStateProjectionSavepoint(() => refreshPlayerStateSeason(season, options));
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
  const { mappings, watermark } = await withPlayerStateReconciliationTransaction(async () => {
    const capturedWatermark = await readPlayerStateSourceWatermark(season);
    const mappings = await reconcileProviderMappings(season.seasonCode);
    // Reconciliation itself upserts pending/ambiguous links. Include that
    // committed bridge revision, while retaining the pre-read FPL/Understat
    // values so a concurrent canonical write remains stale for repair.
    const postReconciliationWatermark = await readPlayerStateSourceWatermark(season);
    return {
      mappings,
      watermark: {
        ...capturedWatermark,
        bridgeSourceUpdatedAt: postReconciliationWatermark.bridgeSourceUpdatedAt,
        sourceUpdatedAt: maxSourceTimestamp(
          capturedWatermark.fplSourceUpdatedAt,
          capturedWatermark.understatSourceUpdatedAt,
          postReconciliationWatermark.bridgeSourceUpdatedAt,
        ),
      },
    };
  });
  const refresh = await refreshPlayerStateSeasonSafely(season, {
    advanceSourceMarker: true,
    sourceWatermark: watermark,
  });
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

async function publishUnderstatPlayerStateForRepair(
  season: FplSeasonRef,
): Promise<Awaited<ReturnType<typeof publishUnderstatPlayerState>>> {
  return withMutationScopes(
    {
      queueName: 'bridge',
      jobName: 'player-state-repair',
      scopes: ['understat:reference:all'],
    },
    () => publishUnderstatPlayerState(season),
  );
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
            SELECT max(player.updated_at)
            FROM understat.players player
            WHERE player.first_seen_season <= season.season_code
              AND player.last_seen_season >= season.season_code
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
            SELECT max(fixture.updated_at)
            FROM fpl.fixtures fixture
            WHERE fixture.season_id = season.season_id
          ), '-infinity'::timestamptz),
          COALESCE((
            SELECT max(fixture_stat.updated_at)
            FROM fpl.player_fixture_stats fixture_stat
            WHERE fixture_stat.season_id = season.season_id
          ), '-infinity'::timestamptz),
          COALESCE((
            SELECT max(team_link.updated_at)
            FROM bridge.entity_links team_link
            WHERE team_link.entity_type = 'team'
              AND team_link.left_provider = 'understat'
              AND team_link.right_provider = 'fpl'
              AND (
                team_link.first_seen_season IS NULL
                OR team_link.first_seen_season <= season.season_code
              )
              AND (
                team_link.last_seen_season IS NULL
                OR team_link.last_seen_season >= season.season_code
              )
          ), '-infinity'::timestamptz),
          COALESCE((
            SELECT max(match_link.updated_at)
            FROM bridge.match_links match_link
            WHERE match_link.season_code = season.season_code
              AND match_link.left_provider = 'understat'
              AND match_link.right_provider = 'fpl'
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
      await publishUnderstatPlayerStateForRepair(season);
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
