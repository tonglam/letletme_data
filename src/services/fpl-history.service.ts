import { eq, sql } from 'drizzle-orm';

import { acquireActiveSeasonWriteFence } from '../cache/cache-season';
import { CORE_SNAPSHOT_MUTATION_SCOPES } from '../domain/core-snapshot';
import { fplSeasonArchiveItems, fplSeasonArchives } from '../db/schemas/index.schema';
import { getDb, type DbOrTransaction } from '../db/singleton';
import type { FplSeasonArchiveItem } from '../domain/fpl-history';
import { findCoreSnapshotAuthority } from '../repositories/core-snapshot-authority';
import { createFplHistoryRepository, fplHistoryRepository } from '../repositories/fpl-history';
import { DatabaseError } from '../utils/errors';
import { withMutationConflictGuard } from '../utils/mutation-lock';
import { syncCoreSnapshot } from './core-snapshot.service';
import { syncEventLiveSummary } from './event-live-summaries.service';
import { syncPlayerStatsForEvent } from './player-stats.service';

const FPL_ARCHIVE_LOCK_KEY = 912_883_473;
const EVENT_LIVE_SUMMARY_ARCHIVE_COLUMNS = [
  'id',
  'element_id',
  'element_type',
  'minutes',
  'goals_scored',
  'assists',
  'clean_sheets',
  'goals_conceded',
  'own_goals',
  'penalties_saved',
  'penalties_missed',
  'yellow_cards',
  'red_cards',
  'saves',
  'bonus',
  'bps',
  'total_points',
  'created_at',
  'updated_at',
] as const;
const EVENT_LIVE_SUMMARY_AGGREGATE_QUERY = `
  SELECT
    live.element_id AS id,
    live.element_id AS element_id,
    player.type AS element_type,
    COALESCE(SUM(live.minutes), 0)::integer AS minutes,
    COALESCE(SUM(live.goals_scored), 0)::integer AS goals_scored,
    COALESCE(SUM(live.assists), 0)::integer AS assists,
    COALESCE(SUM(live.clean_sheets), 0)::integer AS clean_sheets,
    COALESCE(SUM(live.goals_conceded), 0)::integer AS goals_conceded,
    COALESCE(SUM(live.own_goals), 0)::integer AS own_goals,
    COALESCE(SUM(live.penalties_saved), 0)::integer AS penalties_saved,
    COALESCE(SUM(live.penalties_missed), 0)::integer AS penalties_missed,
    COALESCE(SUM(live.yellow_cards), 0)::integer AS yellow_cards,
    COALESCE(SUM(live.red_cards), 0)::integer AS red_cards,
    COALESCE(SUM(live.saves), 0)::integer AS saves,
    COALESCE(SUM(live.bonus), 0)::integer AS bonus,
    COALESCE(SUM(live.bps), 0)::integer AS bps,
    COALESCE(SUM(live.total_points), 0)::integer AS total_points,
    now() AS created_at,
    now() AS updated_at
  FROM public.event_lives AS live
  INNER JOIN public.players AS player ON player.id = live.element_id
  GROUP BY live.element_id, player.type
`;
const FPL_ARCHIVE_LIVE_SNAPSHOT_SCOPES = Array.from(
  { length: 38 },
  (_, index) => `live-snapshot:event:${index + 1}`,
);

type ArchiveTableSpec = {
  sourceTable: string;
  archiveTable: string;
  sourceHasSeason: boolean;
};

export const FPL_ARCHIVE_MUTATION_SCOPES = [
  ...CORE_SNAPSHOT_MUTATION_SCOPES,
  'data-core:player-stats',
  'data-core:player-values',
  ...FPL_ARCHIVE_LIVE_SNAPSHOT_SCOPES,
  'event-live-summary:season',
] as const;

export const FPL_ARCHIVE_TABLES: readonly ArchiveTableSpec[] = [
  { sourceTable: 'events', archiveTable: 'events_history', sourceHasSeason: false },
  { sourceTable: 'teams', archiveTable: 'teams_history', sourceHasSeason: false },
  { sourceTable: 'players', archiveTable: 'players_history', sourceHasSeason: false },
  { sourceTable: 'phases', archiveTable: 'phases_history', sourceHasSeason: false },
  {
    sourceTable: 'event_fixtures',
    archiveTable: 'event_fixtures_history',
    sourceHasSeason: false,
  },
  {
    sourceTable: 'player_stats',
    archiveTable: 'player_stats_history',
    sourceHasSeason: false,
  },
  {
    sourceTable: 'event_lives',
    archiveTable: 'event_lives_history',
    sourceHasSeason: false,
  },
  {
    sourceTable: 'event_live_explains',
    archiveTable: 'event_live_explains_history',
    sourceHasSeason: false,
  },
  {
    sourceTable: 'event_live_summaries',
    archiveTable: 'event_live_summaries_history',
    sourceHasSeason: false,
  },
  {
    sourceTable: 'player_values',
    archiveTable: 'player_values_history',
    sourceHasSeason: false,
  },
  {
    sourceTable: 'player_market_snapshots',
    archiveTable: 'player_market_snapshots_history',
    sourceHasSeason: false,
  },
  {
    sourceTable: 'fpl_player_fixture_stats',
    archiveTable: 'fpl_player_fixture_stats_history',
    sourceHasSeason: true,
  },
] as const;

function assertSeason(season: string): void {
  if (!/^\d{4}$/.test(season)) throw new Error(`Invalid FPL season: ${season}`);
}

function sourceWhere(spec: ArchiveTableSpec, season: string, alias: string): string {
  return spec.sourceHasSeason ? ` WHERE ${alias}.season = '${season}'` : '';
}

function canonicalExpression(spec: ArchiveTableSpec, alias: string): string {
  return spec.sourceHasSeason ? `to_jsonb(${alias})` : `to_jsonb(${alias}) - 'season'`;
}

async function copyAndVerifyTable(
  tx: DbOrTransaction,
  season: string,
  spec: ArchiveTableSpec,
): Promise<FplSeasonArchiveItem> {
  const isEventLiveSummary = spec.sourceTable === 'event_live_summaries';
  const eventLiveSummaryColumns = EVENT_LIVE_SUMMARY_ARCHIVE_COLUMNS.join(', ');
  const eventLiveSummarySourceColumns = EVENT_LIVE_SUMMARY_ARCHIVE_COLUMNS.map(
    (column) => `source.${column}`,
  ).join(', ');
  const sourceFrom = isEventLiveSummary
    ? `( ${EVENT_LIVE_SUMMARY_AGGREGATE_QUERY} ) AS source`
    : `public.${spec.sourceTable} source`;
  // A building archive may contain a preseason seed (notably teams_2627).
  // Rebuild the season slice transactionally before verifying the canonical
  // source set; sealed seasons return before reaching this function.
  await tx.execute(sql.raw(`DELETE FROM public.${spec.archiveTable} WHERE season = '${season}'`));
  const copySql = isEventLiveSummary
    ? `INSERT INTO public.${spec.archiveTable} (season, ${eventLiveSummaryColumns})
       SELECT '${season}'::text, ${eventLiveSummarySourceColumns}
       FROM ${sourceFrom} ON CONFLICT DO NOTHING`
    : spec.sourceHasSeason
      ? `INSERT INTO public.${spec.archiveTable} SELECT source.* FROM public.${spec.sourceTable} source WHERE source.season = '${season}' ON CONFLICT DO NOTHING`
      : `INSERT INTO public.${spec.archiveTable} SELECT '${season}'::text, source.* FROM public.${spec.sourceTable} source ON CONFLICT DO NOTHING`;
  await tx.execute(sql.raw(copySql));

  const sourceJson = isEventLiveSummary
    ? String.raw`(to_jsonb(source) - 'created_at' - 'updated_at')`
    : 'to_jsonb(source)';
  const archiveJson = isEventLiveSummary
    ? String.raw`(to_jsonb(archive) - 'season' - 'created_at' - 'updated_at')`
    : canonicalExpression(spec, 'archive');
  const sourceFilter = isEventLiveSummary ? '' : sourceWhere(spec, season, 'source');
  const archiveFilter = ` WHERE archive.season = '${season}'`;
  const rows = await tx.execute<{ sourceCount: number; archiveCount: number; checksum: string }>(
    sql.raw(`
      SELECT
        (SELECT count(*)::int FROM ${sourceFrom}${sourceFilter}) AS "sourceCount",
        (SELECT count(*)::int FROM public.${spec.archiveTable} archive${archiveFilter}) AS "archiveCount",
        (SELECT md5(COALESCE(string_agg(${sourceJson}::text, '' ORDER BY source.id), ''))
           FROM ${sourceFrom}${sourceFilter}) AS checksum
    `),
  );
  const counts = rows[0];
  if (!counts || Number(counts.sourceCount) !== Number(counts.archiveCount)) {
    throw new Error(
      `FPL archive row-count mismatch for ${spec.sourceTable}: source=${counts?.sourceCount ?? 0} archive=${counts?.archiveCount ?? 0}`,
    );
  }
  const equality = await tx.execute<{ identical: boolean }>(
    sql.raw(`
      SELECT
        NOT EXISTS (
          (SELECT ${sourceJson} FROM ${sourceFrom}${sourceFilter})
          EXCEPT
          (SELECT ${archiveJson} FROM public.${spec.archiveTable} archive${archiveFilter})
        )
        AND NOT EXISTS (
          (SELECT ${archiveJson} FROM public.${spec.archiveTable} archive${archiveFilter})
          EXCEPT
          (SELECT ${sourceJson} FROM ${sourceFrom}${sourceFilter})
        ) AS identical
    `),
  );
  if (equality[0]?.identical !== true) {
    throw new Error(`FPL archive set mismatch for ${spec.sourceTable}`);
  }

  const verifiedAt = new Date();
  const item: FplSeasonArchiveItem = {
    season,
    sourceTable: spec.sourceTable,
    archiveTable: spec.archiveTable,
    rowCount: Number(counts.sourceCount),
    canonicalChecksum: counts.checksum,
    verifiedAt,
  };
  await tx
    .insert(fplSeasonArchiveItems)
    .values(item)
    .onConflictDoUpdate({
      target: [fplSeasonArchiveItems.season, fplSeasonArchiveItems.sourceTable],
      set: {
        archiveTable: sql`excluded.archive_table`,
        rowCount: sql`excluded.row_count`,
        canonicalChecksum: sql`excluded.canonical_checksum`,
        verifiedAt: sql`excluded.verified_at`,
        updatedAt: sql`NOW()`,
      },
    });
  return item;
}

export interface FplArchiveResult {
  season: string;
  status: 'sealed';
  noOp: boolean;
  items: FplSeasonArchiveItem[];
}

export async function archiveFplSeason(season: string): Promise<FplArchiveResult> {
  assertSeason(season);
  const existing = await fplHistoryRepository.findArchive(season);
  if (existing?.status === 'sealed') {
    return {
      season,
      status: 'sealed',
      noOp: true,
      items: await fplHistoryRepository.findItems(season),
    };
  }
  if (existing?.status === 'unavailable') {
    throw new DatabaseError(
      existing.reason ?? 'FPL season data is unavailable',
      'FPL_SEASON_UNAVAILABLE',
    );
  }
  await fplHistoryRepository.markPending(season);

  const eligibility = await fplHistoryRepository.checkEligibility();
  if (!eligibility.eligible) {
    const message = `FPL season ${season} is not archive-ready: ${eligibility.reason}`;
    await fplHistoryRepository.markFailed(season, message);
    throw new DatabaseError(message, 'FPL_SEASON_ARCHIVE_NOT_READY');
  }

  const db = await getDb();
  try {
    return await db.transaction(
      async (tx) => {
        await acquireActiveSeasonWriteFence(tx);
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${FPL_ARCHIVE_LOCK_KEY})`);
        const authority = await findCoreSnapshotAuthority(tx, { lock: true });
        if (!authority || authority.season !== season) {
          throw new DatabaseError(
            `FPL archive ${season} does not own the current core snapshot`,
            'FPL_SEASON_ARCHIVE_AUTHORITY_MISMATCH',
          );
        }
        const [locked] = await tx
          .select()
          .from(fplSeasonArchives)
          .where(eq(fplSeasonArchives.season, season))
          .for('update')
          .limit(1);
        if (locked?.status === 'sealed') {
          return {
            season,
            status: 'sealed',
            noOp: true,
            items: await createFplHistoryRepository(tx).findItems(season),
          };
        }
        if (locked?.status === 'unavailable') {
          throw new DatabaseError(
            locked.reason ?? 'FPL season data is unavailable',
            'FPL_SEASON_UNAVAILABLE',
          );
        }
        await tx
          .update(fplSeasonArchives)
          .set({
            status: 'building',
            sourceCoreRevision: `${authority.revision}:${authority.publicationId}`,
            startedAt: new Date(),
            completedAt: null,
            errorSummary: null,
            updatedAt: new Date(),
          })
          .where(eq(fplSeasonArchives.season, season));
        await tx.delete(fplSeasonArchiveItems).where(eq(fplSeasonArchiveItems.season, season));

        const items: FplSeasonArchiveItem[] = [];
        for (const spec of FPL_ARCHIVE_TABLES) {
          items.push(await copyAndVerifyTable(tx, season, spec));
        }
        await tx
          .update(fplSeasonArchives)
          .set({ status: 'sealed', completedAt: new Date(), updatedAt: new Date() })
          .where(eq(fplSeasonArchives.season, season));
        return { season, status: 'sealed', noOp: false, items };
      },
      { isolationLevel: 'repeatable read' },
    );
  } catch (error) {
    await fplHistoryRepository.markFailed(
      season,
      error instanceof Error ? error.message : String(error),
    );
    throw error;
  }
}

export async function getFplArchiveStatus(season: string) {
  assertSeason(season);
  const [archive, items, authority] = await Promise.all([
    fplHistoryRepository.findArchive(season),
    fplHistoryRepository.findItems(season),
    findCoreSnapshotAuthority(),
  ]);
  const eligibility =
    authority?.season === season ? await fplHistoryRepository.checkEligibility() : null;
  return { season, archive, items, eligibility };
}

export async function prepareAndArchiveFplSeason(season: string): Promise<FplArchiveResult> {
  assertSeason(season);
  const existing = await fplHistoryRepository.findArchive(season);
  if (existing?.status === 'unavailable') return archiveFplSeason(season);

  return withMutationConflictGuard(
    {
      queueName: 'data-sync',
      jobName: 'fpl-season-archive',
      required: true,
      // The worker intentionally does not add an outer guard for this job.
      // Hold every event's live writer scope from the final refresh through
      // the archive transaction so no newer live facts can be copied after
      // the summary has been prepared.
      scopes: [...FPL_ARCHIVE_MUTATION_SCOPES],
    },
    async () => {
      const core = await syncCoreSnapshot(undefined, { mutationScopesAlreadyHeld: true });
      if (core.season !== season) {
        throw new DatabaseError(
          `Final core snapshot belongs to ${core.season}, not requested archive ${season}`,
          'FPL_SEASON_ARCHIVE_AUTHORITY_MISMATCH',
        );
      }

      await syncPlayerStatsForEvent(38);
      await syncEventLiveSummary();
      return archiveFplSeason(season);
    },
  );
}
