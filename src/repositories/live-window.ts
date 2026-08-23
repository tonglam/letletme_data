import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import {
  liveLifecycleStatusInOps,
  managerEventScoreSnapshotsInFpl,
} from '../db/schemas/live-window.schema';
import { getDb, type DbOrTransaction } from '../db/singleton';
import type { FplSeasonRef } from '../domain/fpl-season';

export type LiveLifecycleStatusRow = typeof liveLifecycleStatusInOps.$inferSelect;

export type LiveLifecycleStatusInput = {
  eventId: number;
  state: string;
  observedAt: Date;
  lastChangedAt: Date;
  nextRefreshAt: Date | null;
  liveRevision: string | null;
  publicationId: string | null;
  sourceCheckedAt: Date | null;
};

export const createLiveLifecycleStatusRepository = (dbInstance?: DbOrTransaction) => {
  const getDbInstance = async () => dbInstance ?? (await getDb());

  return {
    findByEventId: async (
      season: FplSeasonRef,
      eventId: number,
    ): Promise<LiveLifecycleStatusRow | null> => {
      const db = await getDbInstance();
      const [row] = await db
        .select()
        .from(liveLifecycleStatusInOps)
        .where(
          and(
            eq(liveLifecycleStatusInOps.seasonId, season.seasonId),
            eq(liveLifecycleStatusInOps.eventId, eventId),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    findLatest: async (season: FplSeasonRef): Promise<LiveLifecycleStatusRow | null> => {
      const db = await getDbInstance();
      const [row] = await db
        .select()
        .from(liveLifecycleStatusInOps)
        .where(eq(liveLifecycleStatusInOps.seasonId, season.seasonId))
        .orderBy(desc(liveLifecycleStatusInOps.observedAt))
        .limit(1);
      return row ?? null;
    },

    upsert: async (season: FplSeasonRef, input: LiveLifecycleStatusInput): Promise<void> => {
      const db = await getDbInstance();
      await db
        .insert(liveLifecycleStatusInOps)
        .values({
          seasonId: season.seasonId,
          eventId: input.eventId,
          state: input.state,
          observedAt: input.observedAt,
          lastChangedAt: input.lastChangedAt,
          nextRefreshAt: input.nextRefreshAt,
          liveRevision: input.liveRevision,
          publicationId: input.publicationId,
          sourceCheckedAt: input.sourceCheckedAt,
          updatedAt: input.observedAt,
        })
        .onConflictDoUpdate({
          target: [liveLifecycleStatusInOps.seasonId, liveLifecycleStatusInOps.eventId],
          set: {
            state: sql`excluded.state`,
            observedAt: sql`excluded.observed_at`,
            lastChangedAt: sql`excluded.last_changed_at`,
            nextRefreshAt: sql`excluded.next_refresh_at`,
            liveRevision: sql`excluded.live_revision`,
            publicationId: sql`excluded.publication_id`,
            sourceCheckedAt: sql`excluded.source_checked_at`,
            updatedAt: sql`excluded.updated_at`,
          },
        });
    },
  };
};

export const liveLifecycleStatusRepository = createLiveLifecycleStatusRepository();

export type ManagerScoreScope =
  | { scopeType: 'ENTRY'; scopeId: 0 }
  | { scopeType: 'CLASSIC_LEAGUE'; scopeId: number };

export type ManagerScoreCheckpoint = {
  entryId: number;
  eventPoints: number | null;
  netEventPoints: number | null;
  totalPoints: number | null;
  totalScope: 'OVERALL' | 'CLASSIC_PHASE';
  eventRank: number | null;
  overallRank: number | null;
  leagueRank: number | null;
  source: 'FPL_ENTRY_SUMMARY' | 'FPL_CLASSIC_STANDINGS' | 'FPL_FINAL_RESULT';
  transferCost: number | null;
  eventPointSemantics: 'GROSS' | 'NET' | 'ZERO_COST_EQUIVALENT' | 'UNKNOWN';
  contentRevision: string;
  checkedAt: Date;
  upstreamUpdatedAt: Date | null;
};

export const createManagerScoreCheckpointRepository = (dbInstance?: DbOrTransaction) => {
  const getDbInstance = async () => dbInstance ?? (await getDb());

  return {
    findByScopeAndEntryIds: async (
      season: FplSeasonRef,
      eventId: number,
      scope: ManagerScoreScope,
      entryIds: readonly number[],
    ) => {
      if (entryIds.length === 0) return [];
      const db = await getDbInstance();
      return db
        .select()
        .from(managerEventScoreSnapshotsInFpl)
        .where(
          and(
            eq(managerEventScoreSnapshotsInFpl.seasonId, season.seasonId),
            eq(managerEventScoreSnapshotsInFpl.eventId, eventId),
            eq(managerEventScoreSnapshotsInFpl.scopeType, scope.scopeType),
            eq(managerEventScoreSnapshotsInFpl.scopeId, scope.scopeId),
            inArray(managerEventScoreSnapshotsInFpl.entryId, Array.from(new Set(entryIds))),
          ),
        );
    },

    findCoverageByEvent: async (season: FplSeasonRef, eventId: number) => {
      const db = await getDbInstance();
      const [row] = await db
        .select({
          checkpointRows: sql<number>`count(*)::int`,
          scopes: sql<number>`count(distinct (${managerEventScoreSnapshotsInFpl.scopeType} || ':' || ${managerEventScoreSnapshotsInFpl.scopeId}))::int`,
          latestCheckedAt: sql<Date | null>`max(${managerEventScoreSnapshotsInFpl.checkedAt})`,
        })
        .from(managerEventScoreSnapshotsInFpl)
        .where(
          and(
            eq(managerEventScoreSnapshotsInFpl.seasonId, season.seasonId),
            eq(managerEventScoreSnapshotsInFpl.eventId, eventId),
          ),
        );
      return {
        checkpointRows: row?.checkpointRows ?? 0,
        scopes: row?.scopes ?? 0,
        latestCheckedAt: row?.latestCheckedAt ?? null,
      };
    },

    upsertBatch: async (
      season: FplSeasonRef,
      eventId: number,
      scope: ManagerScoreScope,
      rows: readonly ManagerScoreCheckpoint[],
    ): Promise<void> => {
      if (rows.length === 0) return;
      const db = await getDbInstance();
      await db
        .insert(managerEventScoreSnapshotsInFpl)
        .values(
          rows.map((row) => ({
            seasonId: season.seasonId,
            eventId,
            scopeType: scope.scopeType,
            scopeId: scope.scopeId,
            entryId: row.entryId,
            eventPoints: row.eventPoints,
            netEventPoints: row.netEventPoints,
            totalPoints: row.totalPoints,
            totalScope: row.totalScope,
            eventRank: row.eventRank,
            overallRank: row.overallRank,
            leagueRank: row.leagueRank,
            source: row.source,
            transferCost: row.transferCost,
            eventPointSemantics: row.eventPointSemantics,
            contentRevision: row.contentRevision,
            checkedAt: row.checkedAt,
            upstreamUpdatedAt: row.upstreamUpdatedAt,
            updatedAt: row.checkedAt,
          })),
        )
        .onConflictDoUpdate({
          target: [
            managerEventScoreSnapshotsInFpl.seasonId,
            managerEventScoreSnapshotsInFpl.eventId,
            managerEventScoreSnapshotsInFpl.scopeType,
            managerEventScoreSnapshotsInFpl.scopeId,
            managerEventScoreSnapshotsInFpl.entryId,
          ],
          set: {
            eventPoints: sql`excluded.event_points`,
            netEventPoints: sql`excluded.net_event_points`,
            totalPoints: sql`excluded.total_points`,
            totalScope: sql`excluded.total_scope`,
            eventRank: sql`excluded.event_rank`,
            overallRank: sql`excluded.overall_rank`,
            leagueRank: sql`excluded.league_rank`,
            source: sql`excluded.source`,
            transferCost: sql`excluded.transfer_cost`,
            eventPointSemantics: sql`excluded.event_point_semantics`,
            contentRevision: sql`excluded.content_revision`,
            checkedAt: sql`excluded.checked_at`,
            upstreamUpdatedAt: sql`excluded.upstream_updated_at`,
            updatedAt: sql`excluded.updated_at`,
          },
          setWhere: sql`
            (
              ${managerEventScoreSnapshotsInFpl.source} = 'FPL_ENTRY_SUMMARY'
              AND excluded.source IN ('FPL_CLASSIC_STANDINGS', 'FPL_FINAL_RESULT')
            )
            OR (
              ${managerEventScoreSnapshotsInFpl.source} = 'FPL_CLASSIC_STANDINGS'
              AND excluded.source = 'FPL_FINAL_RESULT'
            )
            OR (
              ${managerEventScoreSnapshotsInFpl.source} = excluded.source
              AND (
                (
                  ${managerEventScoreSnapshotsInFpl.source} <> 'FPL_CLASSIC_STANDINGS'
                  AND ${managerEventScoreSnapshotsInFpl.checkedAt} <= excluded.checked_at
                )
                OR (
                  ${managerEventScoreSnapshotsInFpl.source} = 'FPL_CLASSIC_STANDINGS'
                  AND (
                    (
                      ${managerEventScoreSnapshotsInFpl.upstreamUpdatedAt} IS NULL
                      AND excluded.upstream_updated_at IS NOT NULL
                    )
                    OR (
                      ${managerEventScoreSnapshotsInFpl.upstreamUpdatedAt} IS NOT NULL
                      AND excluded.upstream_updated_at IS NOT NULL
                      AND ${managerEventScoreSnapshotsInFpl.upstreamUpdatedAt}
                        < excluded.upstream_updated_at
                    )
                    OR (
                      ${managerEventScoreSnapshotsInFpl.upstreamUpdatedAt}
                        IS NOT DISTINCT FROM excluded.upstream_updated_at
                      AND ${managerEventScoreSnapshotsInFpl.checkedAt} <= excluded.checked_at
                    )
                  )
                )
              )
            )
          `,
        });
    },
  };
};

export const managerScoreCheckpointRepository = createManagerScoreCheckpointRepository();
