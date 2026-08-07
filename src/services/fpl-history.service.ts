import { eq, sql } from 'drizzle-orm';

import { acquireActiveSeasonWriteFence } from '../cache/cache-season';
import { fplSeasonArchiveItems, fplSeasonArchives } from '../db/schemas/index.schema';
import { getDb, type DbOrTransaction } from '../db/singleton';
import type { FplSeasonArchiveItem } from '../domain/fpl-history';
import { findCoreSnapshotAuthority } from '../repositories/core-snapshot-authority';
import { createFplHistoryRepository, fplHistoryRepository } from '../repositories/fpl-history';
import { DatabaseError } from '../utils/errors';
import { withMutationConflictGuard } from '../utils/mutation-lock';
import { syncCoreSnapshot } from './core-snapshot.service';
import { syncPlayerStatsForEvent } from './player-stats.service';

const FPL_ARCHIVE_LOCK_KEY = 912_883_473;

type ArchiveTableSpec = {
  sourceTable: string;
  archiveTable: string;
  sourceHasSeason: boolean;
};

export const FPL_ARCHIVE_TABLES: readonly ArchiveTableSpec[] = [
  { sourceTable: 'events', archiveTable: 'fpl_event_history', sourceHasSeason: false },
  { sourceTable: 'teams', archiveTable: 'fpl_team_history', sourceHasSeason: false },
  { sourceTable: 'players', archiveTable: 'fpl_player_history', sourceHasSeason: false },
  { sourceTable: 'phases', archiveTable: 'fpl_phase_history', sourceHasSeason: false },
  {
    sourceTable: 'event_fixtures',
    archiveTable: 'fpl_event_fixture_history',
    sourceHasSeason: false,
  },
  {
    sourceTable: 'player_stats',
    archiveTable: 'fpl_player_stat_history',
    sourceHasSeason: false,
  },
  {
    sourceTable: 'event_lives',
    archiveTable: 'fpl_event_live_history',
    sourceHasSeason: false,
  },
  {
    sourceTable: 'event_live_explains',
    archiveTable: 'fpl_event_live_explain_history',
    sourceHasSeason: false,
  },
  {
    sourceTable: 'event_live_summaries',
    archiveTable: 'fpl_event_live_summary_history',
    sourceHasSeason: false,
  },
  {
    sourceTable: 'player_values',
    archiveTable: 'fpl_player_value_history',
    sourceHasSeason: false,
  },
  {
    sourceTable: 'player_market_snapshots',
    archiveTable: 'fpl_player_market_snapshot_history',
    sourceHasSeason: false,
  },
  {
    sourceTable: 'fpl_player_fixture_stats',
    archiveTable: 'fpl_player_fixture_stat_history',
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
  const copySql = spec.sourceHasSeason
    ? `INSERT INTO public.${spec.archiveTable} SELECT source.* FROM public.${spec.sourceTable} source WHERE source.season = '${season}' ON CONFLICT DO NOTHING`
    : `INSERT INTO public.${spec.archiveTable} SELECT '${season}'::text, source.* FROM public.${spec.sourceTable} source ON CONFLICT DO NOTHING`;
  await tx.execute(sql.raw(copySql));

  const sourceJson = spec.sourceHasSeason ? 'to_jsonb(source)' : 'to_jsonb(source)';
  const archiveJson = canonicalExpression(spec, 'archive');
  const sourceFilter = sourceWhere(spec, season, 'source');
  const archiveFilter = ` WHERE archive.season = '${season}'`;
  const rows = await tx.execute<{ sourceCount: number; archiveCount: number; checksum: string }>(
    sql.raw(`
      SELECT
        (SELECT count(*)::int FROM public.${spec.sourceTable} source${sourceFilter}) AS "sourceCount",
        (SELECT count(*)::int FROM public.${spec.archiveTable} archive${archiveFilter}) AS "archiveCount",
        (SELECT md5(COALESCE(string_agg(${sourceJson}::text, '' ORDER BY source.id), ''))
           FROM public.${spec.sourceTable} source${sourceFilter}) AS checksum
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
          (SELECT ${sourceJson} FROM public.${spec.sourceTable} source${sourceFilter})
          EXCEPT
          (SELECT ${archiveJson} FROM public.${spec.archiveTable} archive${archiveFilter})
        )
        AND NOT EXISTS (
          (SELECT ${archiveJson} FROM public.${spec.archiveTable} archive${archiveFilter})
          EXCEPT
          (SELECT ${sourceJson} FROM public.${spec.sourceTable} source${sourceFilter})
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
  if (existing?.status === 'sealed') return archiveFplSeason(season);
  if (existing?.status === 'unavailable') return archiveFplSeason(season);

  const core = await syncCoreSnapshot();
  if (core.season !== season) {
    throw new DatabaseError(
      `Final core snapshot belongs to ${core.season}, not requested archive ${season}`,
      'FPL_SEASON_ARCHIVE_AUTHORITY_MISMATCH',
    );
  }

  return withMutationConflictGuard(
    {
      queueName: 'data-sync',
      jobName: 'fpl-season-archive',
      required: true,
      scopes: [
        'data-core:events',
        'data-core:teams',
        'data-core:players',
        'data-core:phases',
        'data-core:fixtures',
        'data-core:player-stats',
        'data-core:player-values',
        'event-live-summary:season',
      ],
    },
    async () => {
      await syncPlayerStatsForEvent(38);
      return archiveFplSeason(season);
    },
  );
}
