import {
  and,
  eq,
  getTableColumns,
  gte,
  inArray,
  isNotNull,
  lt,
  lte,
  ne,
  or,
  sql,
} from 'drizzle-orm';

import {
  entriesInCompetition,
  tournamentEntriesInCompetition,
  tournamentsInCompetition,
} from '../db/schemas/index.schema';
import { getDb, type DbHandle } from '../db/singleton';
import type { FplSeasonRef } from '../domain/fpl-season';
import type {
  GroupMode,
  KnockoutMode,
  LeagueType,
  TournamentConfig,
  TournamentSetupPhase,
  TournamentSetupStatus,
  TournamentStructurePlan,
} from '../domain/tournament';
import { ConflictError, DatabaseError } from '../utils/errors';
import { logError } from '../utils/logger';

type TournamentStorage = typeof tournamentsInCompetition.$inferSelect;

export const isTournamentNameConflict = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const record = error as { code?: unknown; constraint_name?: unknown; constraint?: unknown };
  const constraint = String(record.constraint_name ?? record.constraint ?? '');
  return record.code === '23505' && constraint === 'tournaments_name_key';
};

export interface TournamentInfoSummary {
  id: number;
  seasonId: number;
  seasonCode: string;
  leagueId: number;
  leagueType: LeagueType;
  rosterMode: 'snapshot' | 'official_sync';
  totalTeamNum: number;
  groupMode: GroupMode;
  groupStartedEventId: number | null;
  groupEndedEventId: number | null;
  groupQualifyNum: number | null;
  knockoutMode: KnockoutMode;
  knockoutTeamNum: number | null;
  knockoutEventNum: number | null;
  knockoutStartedEventId: number | null;
  knockoutEndedEventId: number | null;
  knockoutPlayAgainstNum: number | null;
  state: 'active' | 'inactive' | 'finished';
  standingsReadyAt: string | null;
  officialScheduleHash: string | null;
  officialScheduleSyncedAt: string | null;
  officialScheduleLockedAt: string | null;
}

export interface TournamentInfoNameSummary {
  id: number;
  name: string;
  sourceLeagueName: string | null;
  leagueId: number;
  leagueType: LeagueType;
}

export interface TournamentSetupStatusRow {
  createdAt: string;
  setupStatus: TournamentSetupStatus;
  setupError: string | null;
  setupPhase: TournamentSetupPhase;
  setupCompletedUnits: number;
  setupTotalUnits: number;
  setupProgressUpdatedAt: string | null;
  standingsReadyAt: string | null;
  setupWarningCount: number;
  setupStartedAt: string | null;
  setupFinishedAt: string | null;
}

export interface TournamentCreatedRow {
  id: number;
  seasonId: number;
  name: string;
  creator: string;
  adminEntryId: number;
  leagueId: number;
  totalTeamNum: number;
  createdAt?: string;
  previewPayloadFingerprint?: string | null;
}

export interface StuckTournamentRow {
  id: number;
  setupProgressUpdatedAt: string | null;
}

function exactTimestamp(value: Date | string | null): string | null {
  return value instanceof Date ? value.toISOString() : value;
}

function mapTournamentInfo(
  row: Omit<TournamentStorage, 'standingsReadyAt'> & {
    standingsReadyAt: Date | string | null;
  },
  season: FplSeasonRef,
): TournamentInfoSummary {
  return {
    id: row.tournamentId,
    seasonId: row.seasonId,
    seasonCode: season.seasonCode,
    leagueId: row.leagueId,
    leagueType: row.leagueType,
    rosterMode: row.rosterMode,
    totalTeamNum: row.totalTeamNum,
    groupMode: row.groupMode ?? 'no_group',
    groupStartedEventId: row.groupStartedEventId,
    groupEndedEventId: row.groupEndedEventId,
    groupQualifyNum: row.groupQualifyNum,
    knockoutMode: row.knockoutMode ?? 'no_knockout',
    knockoutTeamNum: row.knockoutTeamNum,
    knockoutEventNum: row.knockoutEventNum,
    knockoutStartedEventId: row.knockoutStartedEventId,
    knockoutEndedEventId: row.knockoutEndedEventId,
    knockoutPlayAgainstNum: row.knockoutPlayAgainstNum,
    state: row.state,
    standingsReadyAt: exactTimestamp(row.standingsReadyAt),
    officialScheduleHash: row.officialScheduleHash,
    officialScheduleSyncedAt: exactTimestamp(row.officialScheduleSyncedAt),
    officialScheduleLockedAt: exactTimestamp(row.officialScheduleLockedAt),
  };
}

export const createTournamentInfoRepository = (dbInstance?: DbHandle) => {
  const getDbInstance = async () => dbInstance ?? (await getDb());
  const tournamentScope = (season: FplSeasonRef, tournamentId: number) =>
    and(
      eq(tournamentsInCompetition.seasonId, season.seasonId),
      eq(tournamentsInCompetition.tournamentId, tournamentId),
    );

  return {
    findAllNames: async (season: FplSeasonRef): Promise<TournamentInfoNameSummary[]> => {
      try {
        const db = await getDbInstance();
        const rows = await db
          .select({
            id: tournamentsInCompetition.tournamentId,
            name: tournamentsInCompetition.name,
            sourceLeagueName: tournamentsInCompetition.sourceLeagueName,
            leagueId: tournamentsInCompetition.leagueId,
            leagueType: tournamentsInCompetition.leagueType,
          })
          .from(tournamentsInCompetition)
          .where(eq(tournamentsInCompetition.seasonId, season.seasonId));
        return rows;
      } catch (error) {
        logError('Failed to retrieve tournament info names', error, {
          season: season.seasonCode,
        });
        throw new DatabaseError(
          'Failed to retrieve tournament info names',
          'TOURNAMENT_INFO_FIND_ALL_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },

    updateSourceLeagueNames: async (
      season: FplSeasonRef,
      updates: Array<{ id: number; sourceLeagueName: string }>,
    ): Promise<number> => {
      if (updates.length === 0) return 0;

      try {
        const db = await getDbInstance();
        const payload = JSON.stringify(updates);
        const rows = (await db.execute(sql`
          UPDATE ${tournamentsInCompetition} AS tournament
          SET source_league_name = data.source_league_name,
              updated_at = clock_timestamp()
          FROM jsonb_to_recordset(${payload}::jsonb) AS data(
            id int,
            source_league_name text
          )
          WHERE tournament.season_id = ${season.seasonId}
            AND tournament.tournament_id = data.id
          RETURNING tournament.tournament_id
        `)) as unknown as Array<{ tournamentId: number }>;
        return rows.length;
      } catch (error) {
        logError('Failed to update tournament source league names', error, {
          season: season.seasonCode,
          count: updates.length,
        });
        throw new DatabaseError(
          'Failed to update tournament source league names',
          'TOURNAMENT_INFO_UPDATE_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },

    findById: async (
      season: FplSeasonRef,
      tournamentId: number,
    ): Promise<TournamentInfoSummary | null> => {
      try {
        const db = await getDbInstance();
        const rows = await db
          .select()
          .from(tournamentsInCompetition)
          .where(tournamentScope(season, tournamentId))
          .limit(1);
        return rows[0] ? mapTournamentInfo(rows[0], season) : null;
      } catch (error) {
        logError('Failed to retrieve tournament info by id', error, {
          season: season.seasonCode,
          tournamentId,
        });
        throw new DatabaseError(
          'Failed to retrieve tournament info by id',
          'TOURNAMENT_INFO_FIND_BY_ID_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },

    findActive: async (season: FplSeasonRef): Promise<TournamentInfoSummary[]> => {
      try {
        const db = await getDbInstance();
        const rows = await db
          .select({
            ...getTableColumns(tournamentsInCompetition),
            standingsReadyAt: sql<string>`${tournamentsInCompetition.standingsReadyAt}::text`,
          })
          .from(tournamentsInCompetition)
          .where(
            and(
              eq(tournamentsInCompetition.seasonId, season.seasonId),
              eq(tournamentsInCompetition.state, 'active'),
              isNotNull(tournamentsInCompetition.standingsReadyAt),
            ),
          );
        return rows.map((row) => mapTournamentInfo(row, season));
      } catch (error) {
        logError('Failed to retrieve active tournament infos', error, {
          season: season.seasonCode,
        });
        throw new DatabaseError(
          'Failed to retrieve active tournament infos',
          'TOURNAMENT_INFO_FIND_ACTIVE_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },

    findPointsRaceByEvent: async (
      season: FplSeasonRef,
      eventId: number,
    ): Promise<TournamentInfoSummary[]> => {
      const db = await getDbInstance();
      const rows = await db
        .select()
        .from(tournamentsInCompetition)
        .where(
          and(
            eq(tournamentsInCompetition.seasonId, season.seasonId),
            eq(tournamentsInCompetition.state, 'active'),
            isNotNull(tournamentsInCompetition.standingsReadyAt),
            eq(tournamentsInCompetition.groupMode, 'points_races'),
            lte(tournamentsInCompetition.groupStartedEventId, eventId),
            gte(tournamentsInCompetition.groupEndedEventId, eventId),
          ),
        );
      return rows.map((row) => mapTournamentInfo(row, season));
    },

    findBattleRaceByEvent: async (
      season: FplSeasonRef,
      eventId: number,
    ): Promise<TournamentInfoSummary[]> => {
      const db = await getDbInstance();
      const rows = await db
        .select()
        .from(tournamentsInCompetition)
        .where(
          and(
            eq(tournamentsInCompetition.seasonId, season.seasonId),
            eq(tournamentsInCompetition.state, 'active'),
            isNotNull(tournamentsInCompetition.standingsReadyAt),
            eq(tournamentsInCompetition.groupMode, 'battle_races'),
            or(
              and(
                lte(tournamentsInCompetition.groupStartedEventId, eventId),
                gte(tournamentsInCompetition.groupEndedEventId, eventId),
              ),
              and(
                eq(tournamentsInCompetition.leagueType, 'h2h'),
                eq(tournamentsInCompetition.rosterMode, 'official_sync'),
                lte(tournamentsInCompetition.knockoutStartedEventId, eventId),
                gte(tournamentsInCompetition.knockoutEndedEventId, eventId),
              ),
            ),
          ),
        );
      return rows.map((row) => mapTournamentInfo(row, season));
    },

    findKnockoutByEvent: async (
      season: FplSeasonRef,
      eventId: number,
    ): Promise<TournamentInfoSummary[]> => {
      const db = await getDbInstance();
      const rows = await db
        .select()
        .from(tournamentsInCompetition)
        .where(
          and(
            eq(tournamentsInCompetition.seasonId, season.seasonId),
            eq(tournamentsInCompetition.state, 'active'),
            isNotNull(tournamentsInCompetition.standingsReadyAt),
            ne(tournamentsInCompetition.knockoutMode, 'no_knockout'),
            sql`NOT (${tournamentsInCompetition.leagueType} = 'h2h' AND ${tournamentsInCompetition.rosterMode} = 'official_sync')`,
            lte(tournamentsInCompetition.knockoutStartedEventId, eventId),
            gte(tournamentsInCompetition.knockoutEndedEventId, eventId),
          ),
        );
      return rows.map((row) => mapTournamentInfo(row, season));
    },

    checkNameExists: async (season: FplSeasonRef, name: string): Promise<boolean> => {
      try {
        const db = await getDbInstance();
        const rows = await db
          .select({ tournamentId: tournamentsInCompetition.tournamentId })
          .from(tournamentsInCompetition)
          .where(
            and(
              eq(tournamentsInCompetition.seasonId, season.seasonId),
              eq(tournamentsInCompetition.name, name),
            ),
          )
          .limit(1);
        return rows.length === 1;
      } catch (error) {
        logError('Failed to check tournament name existence', error, {
          season: season.seasonCode,
          name,
        });
        throw new DatabaseError(
          'Failed to check tournament name existence',
          'TOURNAMENT_INFO_NAME_CHECK_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },

    findCreatedByIdentity: async (
      season: FplSeasonRef,
      input: { name: string; adminEntryId: number; leagueId: number },
    ): Promise<TournamentCreatedRow | null> => {
      const db = await getDbInstance();
      const rows = await db
        .select({
          id: tournamentsInCompetition.tournamentId,
          seasonId: tournamentsInCompetition.seasonId,
          name: tournamentsInCompetition.name,
          creator: tournamentsInCompetition.creator,
          adminEntryId: tournamentsInCompetition.adminEntryId,
          leagueId: tournamentsInCompetition.leagueId,
          totalTeamNum: tournamentsInCompetition.totalTeamNum,
          createdAt: sql<string>`${tournamentsInCompetition.createdAt}::text`,
          previewPayloadFingerprint: tournamentsInCompetition.previewPayloadFingerprint,
        })
        .from(tournamentsInCompetition)
        .where(
          and(
            eq(tournamentsInCompetition.seasonId, season.seasonId),
            eq(tournamentsInCompetition.name, input.name),
            eq(tournamentsInCompetition.adminEntryId, input.adminEntryId),
            eq(tournamentsInCompetition.leagueId, input.leagueId),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },

    findSetupConfig: async (
      season: FplSeasonRef,
      tournamentId: number,
    ): Promise<TournamentConfig | null> => {
      const db = await getDbInstance();
      const rows = await db
        .select({
          id: tournamentsInCompetition.tournamentId,
          leagueId: tournamentsInCompetition.leagueId,
          leagueType: tournamentsInCompetition.leagueType,
          rosterMode: tournamentsInCompetition.rosterMode,
          totalTeamNum: tournamentsInCompetition.totalTeamNum,
          groupMode: tournamentsInCompetition.groupMode,
          groupNum: tournamentsInCompetition.groupNum,
          groupStartedEventId: tournamentsInCompetition.groupStartedEventId,
          groupEndedEventId: tournamentsInCompetition.groupEndedEventId,
          groupQualifyNum: tournamentsInCompetition.groupQualifyNum,
          knockoutMode: tournamentsInCompetition.knockoutMode,
          knockoutTeamNum: tournamentsInCompetition.knockoutTeamNum,
          knockoutEventNum: tournamentsInCompetition.knockoutEventNum,
          knockoutStartedEventId: tournamentsInCompetition.knockoutStartedEventId,
          knockoutEndedEventId: tournamentsInCompetition.knockoutEndedEventId,
          knockoutPlayAgainstNum: tournamentsInCompetition.knockoutPlayAgainstNum,
        })
        .from(tournamentsInCompetition)
        .where(tournamentScope(season, tournamentId))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      return {
        ...row,
        groupMode: row.groupMode ?? 'no_group',
        knockoutMode: row.knockoutMode ?? 'no_knockout',
      };
    },

    findSetupStatus: async (
      season: FplSeasonRef,
      tournamentId: number,
    ): Promise<TournamentSetupStatusRow | null> => {
      const db = await getDbInstance();
      const rows = await db
        .select({
          createdAt: sql<string>`${tournamentsInCompetition.createdAt}::text`,
          setupStatus: tournamentsInCompetition.setupStatus,
          setupError: tournamentsInCompetition.setupError,
          setupPhase: tournamentsInCompetition.setupPhase,
          setupCompletedUnits: tournamentsInCompetition.setupCompletedUnits,
          setupTotalUnits: tournamentsInCompetition.setupTotalUnits,
          setupProgressUpdatedAt: sql<
            string | null
          >`${tournamentsInCompetition.setupProgressUpdatedAt}::text`,
          standingsReadyAt: sql<string | null>`${tournamentsInCompetition.standingsReadyAt}::text`,
          setupWarningCount: tournamentsInCompetition.setupWarningCount,
          setupStartedAt: sql<string | null>`${tournamentsInCompetition.setupStartedAt}::text`,
          setupFinishedAt: sql<string | null>`${tournamentsInCompetition.setupFinishedAt}::text`,
        })
        .from(tournamentsInCompetition)
        .where(tournamentScope(season, tournamentId))
        .limit(1);
      return rows[0] ?? null;
    },

    markSetupProcessing: async (
      season: FplSeasonRef,
      tournamentId: number,
      progressMarker?: string | null,
    ): Promise<void> => {
      const db = await getDbInstance();
      await db
        .update(tournamentsInCompetition)
        .set({
          setupStatus: 'processing',
          setupError: null,
          setupPhase: 'syncing_entries',
          setupCompletedUnits: 0,
          setupTotalUnits: 0,
          setupProgressUpdatedAt:
            progressMarker !== undefined ? sql`${progressMarker}::timestamptz` : new Date(),
          setupWarningCount: 0,
          setupStartedAt: new Date(),
          setupFinishedAt: null,
          standingsReadyAt: null,
          updatedAt: new Date(),
        })
        .where(tournamentScope(season, tournamentId));
    },

    markSetupRetryQueued: async (season: FplSeasonRef, tournamentId: number): Promise<void> => {
      const db = await getDbInstance();
      await db
        .update(tournamentsInCompetition)
        .set({
          setupStatus: 'pending',
          setupError: null,
          setupPhase: 'queued',
          setupCompletedUnits: 0,
          setupTotalUnits: 0,
          setupProgressUpdatedAt: new Date(),
          setupWarningCount: 0,
          setupStartedAt: null,
          setupFinishedAt: null,
          standingsReadyAt: null,
          updatedAt: new Date(),
        })
        .where(tournamentScope(season, tournamentId));
    },

    markSetupProgress: async (
      season: FplSeasonRef,
      tournamentId: number,
      phase: TournamentSetupPhase,
      completedUnits: number,
      totalUnits: number,
      progressMarker?: string | null,
    ): Promise<void> => {
      const safeTotal = Math.max(0, Math.trunc(totalUnits));
      const safeCompleted = Math.min(safeTotal, Math.max(0, Math.trunc(completedUnits)));
      const db = await getDbInstance();
      await db
        .update(tournamentsInCompetition)
        .set({
          setupPhase: phase,
          setupCompletedUnits: safeCompleted,
          setupTotalUnits: safeTotal,
          setupProgressUpdatedAt:
            progressMarker !== undefined ? sql`${progressMarker}::timestamptz` : new Date(),
          updatedAt: new Date(),
        })
        .where(tournamentScope(season, tournamentId));
    },

    markStandingsReady: async (
      season: FplSeasonRef,
      tournamentId: number,
      progressMarker?: string | null,
    ): Promise<void> => {
      const db = await getDbInstance();
      const rows = await db
        .update(tournamentsInCompetition)
        .set({
          standingsReadyAt: sql`COALESCE(${tournamentsInCompetition.standingsReadyAt}, clock_timestamp())`,
          setupProgressUpdatedAt:
            progressMarker !== undefined ? sql`${progressMarker}::timestamptz` : new Date(),
          updatedAt: new Date(),
        })
        .where(tournamentScope(season, tournamentId))
        .returning({ tournamentId: tournamentsInCompetition.tournamentId });
      if (rows.length !== 1) throw new Error(`Tournament ${tournamentId} no longer exists`);
    },

    markSetupResult: async (
      season: FplSeasonRef,
      tournamentId: number,
      status: 'ready' | 'failed',
      error?: string | null,
      warningCount = status === 'ready' && error ? 1 : 0,
      progressMarker?: string | null,
    ): Promise<void> => {
      const db = await getDbInstance();
      await db
        .update(tournamentsInCompetition)
        .set({
          setupStatus: status,
          setupPhase: status,
          setupWarningCount: status === 'ready' ? Math.max(0, warningCount) : 0,
          setupError: error ?? null,
          setupProgressUpdatedAt:
            progressMarker !== undefined ? sql`${progressMarker}::timestamptz` : new Date(),
          setupFinishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(tournamentScope(season, tournamentId));
    },

    findStuckProcessing: async (
      season: FplSeasonRef,
      cutoffMinutes: number,
    ): Promise<StuckTournamentRow[]> => {
      const db = await getDbInstance();
      const cutoff = new Date(Date.now() - cutoffMinutes * 60_000).toISOString();
      const rows = await db
        .select({
          id: tournamentsInCompetition.tournamentId,
          setupProgressUpdatedAt: sql<string | null>`COALESCE(
            ${tournamentsInCompetition.setupProgressUpdatedAt},
            ${tournamentsInCompetition.setupStartedAt}
          )::text`,
        })
        .from(tournamentsInCompetition)
        .where(
          and(
            eq(tournamentsInCompetition.seasonId, season.seasonId),
            inArray(tournamentsInCompetition.setupStatus, ['pending', 'processing']),
            lt(
              sql`COALESCE(
                ${tournamentsInCompetition.setupProgressUpdatedAt},
                ${tournamentsInCompetition.setupStartedAt}
              )`,
              cutoff,
            ),
          ),
        );
      return rows;
    },

    markStuckSetupQueuedIfUnchanged: async (
      season: FplSeasonRef,
      tournamentId: number,
      expectedProgressUpdatedAt: string | null,
      internalError: string,
    ): Promise<boolean> => {
      const db = await getDbInstance();
      const now = new Date();
      const rows = await db
        .update(tournamentsInCompetition)
        .set({
          setupStatus: 'pending',
          setupPhase: 'queued',
          setupCompletedUnits: 0,
          setupTotalUnits: 0,
          setupWarningCount: 0,
          setupError: internalError,
          setupProgressUpdatedAt: now,
          setupStartedAt: null,
          setupFinishedAt: null,
          updatedAt: now,
        })
        .where(
          and(
            tournamentScope(season, tournamentId),
            inArray(tournamentsInCompetition.setupStatus, ['pending', 'processing']),
            sql`COALESCE(
              ${tournamentsInCompetition.setupProgressUpdatedAt},
              ${tournamentsInCompetition.setupStartedAt}
            ) IS NOT DISTINCT FROM ${expectedProgressUpdatedAt}::timestamptz`,
          ),
        )
        .returning({ tournamentId: tournamentsInCompetition.tournamentId });
      return rows.length === 1;
    },

    createTournamentWithEntries: async (
      season: FplSeasonRef,
      plan: TournamentStructurePlan,
    ): Promise<TournamentCreatedRow> => {
      try {
        const db = await getDbInstance();
        return await db.transaction(async (tx) => {
          if (plan.selectedParticipants.length > 0) {
            await tx
              .insert(entriesInCompetition)
              .values(
                plan.selectedParticipants.map((participant) => ({
                  seasonId: season.seasonId,
                  entryId: Number(participant.id),
                  entryName: participant.team,
                  playerName: participant.manager,
                  overallRank: participant.overallRank || null,
                  overallPoints: participant.totalPoints || 0,
                  usedEntryNames: [participant.team],
                })),
              )
              .onConflictDoNothing({
                target: [entriesInCompetition.seasonId, entriesInCompetition.entryId],
              });
          }

          const insertedTournament = await tx
            .insert(tournamentsInCompetition)
            .values({
              seasonId: season.seasonId,
              name: plan.tournamentName,
              creator: plan.creator,
              adminEntryId: plan.adminEntryId,
              leagueId: plan.leagueId,
              leagueType: plan.leagueType,
              sourceLeagueName: plan.sourceLeagueName ?? null,
              rosterMode: plan.rosterMode ?? 'snapshot',
              rosterSyncStatus: plan.rosterMode === 'official_sync' ? 'ready' : null,
              rosterLastSyncedAt: plan.rosterMode === 'official_sync' ? new Date() : null,
              totalTeamNum: plan.selectedParticipants.length,
              tournamentMode: 'normal',
              groupMode: plan.groupMode,
              groupTeamNum: plan.groupTeamNum,
              groupNum: plan.groupNum,
              groupStartedEventId: plan.groupStartedEventId,
              groupEndedEventId: plan.groupEndedEventId,
              groupAutoAverages: plan.groupAutoAverages,
              groupRounds: plan.groupRounds,
              groupPlayAgainstNum: null,
              groupQualifyNum: plan.groupQualifyNum,
              knockoutMode: plan.knockoutMode,
              knockoutTeamNum: plan.knockoutTeamNum,
              knockoutRounds: plan.knockoutRounds,
              knockoutEventNum: plan.knockoutEventNum,
              knockoutStartedEventId: plan.knockoutStartedEventId,
              knockoutEndedEventId: plan.knockoutEndedEventId,
              knockoutPlayAgainstNum: plan.knockoutPlayAgainstNum,
              state: 'active',
              setupStatus: 'pending',
              setupPhase: 'queued',
              setupProgressUpdatedAt: new Date(),
              previewPayloadFingerprint: plan.previewPayloadFingerprint ?? null,
            })
            .returning({
              id: tournamentsInCompetition.tournamentId,
              seasonId: tournamentsInCompetition.seasonId,
              name: tournamentsInCompetition.name,
              creator: tournamentsInCompetition.creator,
              adminEntryId: tournamentsInCompetition.adminEntryId,
              leagueId: tournamentsInCompetition.leagueId,
              totalTeamNum: tournamentsInCompetition.totalTeamNum,
              previewPayloadFingerprint: tournamentsInCompetition.previewPayloadFingerprint,
            });
          const inserted = insertedTournament[0];
          if (!inserted) {
            throw new DatabaseError(
              'Tournament insert did not return an ID.',
              'TOURNAMENT_INFO_INSERT_MISSING_ID',
            );
          }

          if (plan.selectedParticipants.length > 0) {
            await tx.insert(tournamentEntriesInCompetition).values(
              plan.selectedParticipants.map((participant) => ({
                tournamentId: inserted.id,
                seasonId: season.seasonId,
                leagueId: plan.leagueId,
                entryId: Number(participant.id),
              })),
            );
          }
          return inserted;
        });
      } catch (error) {
        if (isTournamentNameConflict(error)) {
          throw new ConflictError('Tournament name already exists.', 'TOURNAMENT_NAME_EXISTS');
        }
        if (error instanceof DatabaseError) throw error;
        logError('Failed to create tournament with entries', error, {
          season: season.seasonCode,
          name: plan.tournamentName,
        });
        throw new DatabaseError(
          'Failed to create tournament with entries',
          'TOURNAMENT_INFO_CREATE_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },
  };
};

export const tournamentInfoRepository = createTournamentInfoRepository();
