import { and, desc, eq, getTableColumns, inArray, sql } from 'drizzle-orm';

import {
  liveLifecycleStatusInOps,
  managerEventScoreSnapshotsInFpl,
  managerLiveTournamentCoverageInFpl,
} from '../db/schemas/live-window.schema';
import { getDb, type DbOrTransaction } from '../db/singleton';
import type { FplSeasonRef } from '../domain/fpl-season';
import { tournamentRosterRevision } from '../domain/manager-live-coverage';

export type LiveLifecycleStatusRow = typeof liveLifecycleStatusInOps.$inferSelect;

export type LiveLifecycleStatusInput = {
  eventId: number;
  state: string;
  observedAt: Date;
  lastChangedAt: Date;
  nextRefreshAt: Date | null;
  generation: number | null;
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
          generation: input.generation,
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
            generation: sql`excluded.generation`,
            publicationId: sql`excluded.publication_id`,
            sourceCheckedAt: sql`excluded.source_checked_at`,
            updatedAt: sql`excluded.updated_at`,
          },
          // A late completion from an older lifecycle tick must never roll
          // back a newer state or reset its quiet-revision clock. Bull
          // single-flight prevents normal overlap; this database fence also
          // protects against legacy/duplicate jobs and multiple workers.
          where: sql`excluded.observed_at >= ${liveLifecycleStatusInOps.observedAt}`,
        });
    },
  };
};

export const liveLifecycleStatusRepository = createLiveLifecycleStatusRepository();

export type ManagerScoreScope =
  | { scopeType: 'ENTRY'; scopeId: 0 }
  | { scopeType: 'CLASSIC_LEAGUE'; scopeId: number };

export type ManagerLiveTournamentCoverageState = 'WARMING' | 'COMPLETE' | 'PARTIAL' | 'UNAVAILABLE';

export type ManagerLiveTournamentCoverageInput = {
  seasonId: number;
  eventId: number;
  tournamentId: number;
  rosterRevision: string;
  expectedEntries: number;
  resolvedEntries: number;
  fullyFetchedAt: Date | null;
  managerRevision: string | null;
  error: string | null;
  state: ManagerLiveTournamentCoverageState;
  updatedAt?: Date;
};

export type ManagerLiveTournamentCoverageRow =
  typeof managerLiveTournamentCoverageInFpl.$inferSelect;

export type ManagerScoreCheckpoint = {
  entryId: number;
  eventPoints: number | null;
  netEventPoints: number | null;
  totalPoints: number | null;
  totalScope: 'OVERALL' | 'CLASSIC_PHASE';
  eventRank: number | null;
  overallRank: number | null;
  leagueRank: number | null;
  source: 'FPL_EVENT_LIVE' | 'FPL_ENTRY_SUMMARY' | 'FPL_CLASSIC_STANDINGS' | 'FPL_FINAL_RESULT';
  transferCost: number | null;
  eventPointSemantics: 'GROSS' | 'NET' | 'ZERO_COST_EQUIVALENT' | 'UNKNOWN';
  contentRevision: string;
  checkedAt: Date;
  upstreamUpdatedAt: Date | null;
  // Classic rows use the existing internal updated_at column as durable
  // ordering evidence for the last accepted positive OR fetch. Standings and
  // unusable Summary responses leave it unchanged.
  overallRankPublicationStartedAt?: string | null;
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
        .select({
          ...getTableColumns(managerEventScoreSnapshotsInFpl),
          overallRankPublicationStartedAtExact: sql<string>`to_char(
            ${managerEventScoreSnapshotsInFpl.updatedAt} AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          )`,
        })
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
    ): Promise<number> => {
      if (rows.length === 0) return 0;
      const db = await getDbInstance();
      const acceptedRows = await db
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
            updatedAt:
              scope.scopeType === 'CLASSIC_LEAGUE'
                ? row.overallRankPublicationStartedAt
                  ? sql`${row.overallRankPublicationStartedAt}::timestamptz`
                  : new Date(0)
                : row.checkedAt,
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
            updatedAt:
              scope.scopeType === 'CLASSIC_LEAGUE'
                ? sql`greatest(${managerEventScoreSnapshotsInFpl.updatedAt}, excluded.updated_at)`
                : sql`excluded.updated_at`,
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
                      ${managerEventScoreSnapshotsInFpl.upstreamUpdatedAt} IS NOT NULL
                      AND excluded.upstream_updated_at IS NOT NULL
                      AND ${managerEventScoreSnapshotsInFpl.upstreamUpdatedAt}
                        < excluded.upstream_updated_at
                    )
                    OR (
                      (
                        ${managerEventScoreSnapshotsInFpl.upstreamUpdatedAt} IS NULL
                        OR excluded.upstream_updated_at IS NULL
                        OR ${managerEventScoreSnapshotsInFpl.upstreamUpdatedAt}
                          = excluded.upstream_updated_at
                      )
                      AND ${managerEventScoreSnapshotsInFpl.checkedAt} <= excluded.checked_at
                    )
                    OR excluded.updated_at > ${managerEventScoreSnapshotsInFpl.updatedAt}
                  )
                )
            )
            )
          `,
        })
        .returning({ entryId: managerEventScoreSnapshotsInFpl.entryId });
      return acceptedRows.length;
    },
  };
};

export const createManagerLiveTournamentCoverageRepository = (dbInstance?: DbOrTransaction) => {
  const getDbInstance = async () => dbInstance ?? (await getDb());

  return {
    findByTournamentAndEvent: async (
      season: FplSeasonRef,
      eventId: number,
      tournamentId: number,
    ): Promise<ManagerLiveTournamentCoverageRow | null> => {
      const db = await getDbInstance();
      const [row] = await db
        .select()
        .from(managerLiveTournamentCoverageInFpl)
        .where(
          and(
            eq(managerLiveTournamentCoverageInFpl.seasonId, season.seasonId),
            eq(managerLiveTournamentCoverageInFpl.eventId, eventId),
            eq(managerLiveTournamentCoverageInFpl.tournamentId, tournamentId),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    upsert: async (input: ManagerLiveTournamentCoverageInput): Promise<boolean> => {
      const db = await getDbInstance();
      const updatedAt = input.updatedAt ?? new Date();
      return db.transaction(async (tx) => {
        // Roster publication and tournament deletion both take FOR UPDATE on
        // the parent tournament row. Holding FOR SHARE through the roster
        // reread and coverage upsert serializes those mutations with this
        // writer and prevents a deleted tournament from being recreated.
        const tournamentRows = await tx.execute<{ present: number }>(sql`
          SELECT 1 AS present
          FROM competition.tournaments
          WHERE season_id = ${input.seasonId}
            AND tournament_id = ${input.tournamentId}
          FOR SHARE
        `);
        if (tournamentRows.length === 0) return false;

        const rosterRows = await tx.execute<{ entryId: number }>(sql`
          SELECT entry_id AS "entryId"
          FROM competition.tournament_entries
          WHERE season_id = ${input.seasonId}
            AND tournament_id = ${input.tournamentId}
          ORDER BY entry_id
          FOR SHARE
        `);
        // A worker can spend minutes fetching a roster. Recheck the
        // authoritative generation immediately before publication so a late
        // result from roster A cannot overwrite the newer roster B state.
        if (
          tournamentRosterRevision(rosterRows.map((row) => row.entryId)) !== input.rosterRevision
        ) {
          return false;
        }

        await tx
          .insert(managerLiveTournamentCoverageInFpl)
          .values({
            seasonId: input.seasonId,
            eventId: input.eventId,
            tournamentId: input.tournamentId,
            rosterRevision: input.rosterRevision,
            expectedEntries: input.expectedEntries,
            resolvedEntries: input.resolvedEntries,
            fullyFetchedAt: input.fullyFetchedAt,
            managerRevision: input.managerRevision,
            error: input.error,
            state: input.state,
            updatedAt,
          })
          .onConflictDoUpdate({
            target: [
              managerLiveTournamentCoverageInFpl.seasonId,
              managerLiveTournamentCoverageInFpl.eventId,
              managerLiveTournamentCoverageInFpl.tournamentId,
            ],
            set: {
              rosterRevision: sql`excluded.roster_revision`,
              expectedEntries: sql`excluded.expected_entries`,
              resolvedEntries: sql`excluded.resolved_entries`,
              fullyFetchedAt: sql`excluded.fully_fetched_at`,
              managerRevision: sql`excluded.manager_revision`,
              error: sql`excluded.error`,
              state: sql`excluded.state`,
              updatedAt: sql`excluded.updated_at`,
            },
            // Coverage is a monotonic publication. If two workers read the
            // same baseline concurrently, a slower write must not overwrite
            // a COMPLETE row or reduce partial progress for the same roster.
            setWhere: sql`
              NOT (
                (
                  ${managerLiveTournamentCoverageInFpl.rosterRevision} = excluded.roster_revision
                  AND ${managerLiveTournamentCoverageInFpl.expectedEntries} = excluded.expected_entries
                  AND excluded.resolved_entries < ${managerLiveTournamentCoverageInFpl.resolvedEntries}
                )
                OR (
                  ${managerLiveTournamentCoverageInFpl.state} = 'COMPLETE'
                  AND ${managerLiveTournamentCoverageInFpl.rosterRevision} = excluded.roster_revision
                  AND ${managerLiveTournamentCoverageInFpl.expectedEntries} = excluded.expected_entries
                  AND (
                    excluded.state <> 'COMPLETE'
                    OR excluded.updated_at < ${managerLiveTournamentCoverageInFpl.updatedAt}
                  )
                )
              )
            `,
          });
        return true;
      });
    },
  };
};

export const managerLiveTournamentCoverageRepository =
  createManagerLiveTournamentCoverageRepository();

export const managerScoreCheckpointRepository = createManagerScoreCheckpointRepository();
