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
import { getDb, type DbOrTransaction } from '../db/singleton';
import type { FplSeasonRef } from '../domain/fpl-season';
import type {
  GroupMode,
  KnockoutMode,
  LeagueType,
  TournamentConfig,
  TournamentSetupPhase,
  TournamentSetupStatus,
  TournamentParticipant,
  TournamentStructurePlan,
} from '../domain/tournament';
import { ConflictError, DatabaseError, ValidationError } from '../utils/errors';
import { logError } from '../utils/logger';
import { withMutationScopes } from '../utils/mutation-scopes';

type TournamentStorage = typeof tournamentsInCompetition.$inferSelect;

export function resolveTournamentEntrySeeds(
  plan: TournamentStructurePlan,
): TournamentParticipant[] {
  const selected = [...plan.selectedParticipants];
  if (selected.some((participant) => Number(participant.id) === plan.adminEntryId)) {
    return selected;
  }
  if (!plan.administratorEntry || Number(plan.administratorEntry.id) !== plan.adminEntryId) {
    throw new ValidationError(
      'The tournament administrator could not be persisted.',
      'TOURNAMENT_ADMIN_ENTRY_UNAVAILABLE',
    );
  }
  return [...selected, plan.administratorEntry];
}

export const isTournamentNameConflict = (error: unknown): boolean => {
  let current = error;
  const visited = new Set<object>();

  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    const record = current as {
      code?: unknown;
      constraint_name?: unknown;
      constraint?: unknown;
      cause?: unknown;
    };
    const constraint = String(record.constraint_name ?? record.constraint ?? '');
    if (record.code === '23505' && constraint === 'tournaments_name_key') return true;
    current = record.cause;
  }

  return false;
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
  /** Lifecycle markers used to fence roster-scoped background work. */
  rosterLastSyncedAt?: string | null;
  setupProgressUpdatedAt?: string | null;
  officialScheduleHash: string | null;
  officialScheduleSyncedAt: string | null;
  officialScheduleLockedAt: string | null;
}

export interface TournamentInfoNameSummary {
  updatedAt: string;
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
  setupAttempt?: number;
  setupMaxAttempts?: number;
  setupNextRetryAt?: string | null;
  setupLastErrorCode?: string | null;
  setupLastErrorAt?: string | null;
  setupProgressIndeterminate?: boolean;
  profilesReadyAt?: string | null;
  insightsReadyAt?: string | null;
}

export type TournamentSetupExecution = Readonly<{
  startedAt: string;
  attempt: number;
}>;

export type TournamentSetupFailureState = Pick<
  TournamentSetupStatusRow,
  'setupAttempt' | 'setupStartedAt' | 'setupStatus' | 'setupProgressUpdatedAt'
>;

export interface TournamentSetupAttemptFailure {
  expectedState?: TournamentSetupFailureState;
  execution?: TournamentSetupExecution;
  attempt: number;
  terminal: boolean;
  errorCode: string;
  nextRetryAt: Date | null;
  startedAt: Date;
  /** Stable ownership marker for a prepared retry across BullMQ attempts. */
  progressMarker?: string;
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
  /** Marker persisted with a newly created setup row before queue admission. */
  setupProgressUpdatedAt?: string | null;
}

export interface StuckTournamentRow {
  id: number;
  setupProgressUpdatedAt: string | null;
  setupStartedAt: string | null;
  setupAttempt: number | null;
  setupCompletedUnits: number;
  setupTotalUnits: number;
  setupWarningCount: number;
  setupError: string | null;
  setupNextRetryAt: string | null;
  setupFinishedAt: string | null;
  setupLastErrorCode: string | null;
  setupLastErrorAt: string | null;
  setupProgressIndeterminate: boolean;
  standingsReadyAt: string | null;
  profilesReadyAt: string | null;
  insightsReadyAt: string | null;
  updatedAt: string;
  state: 'active' | 'inactive' | 'finished';
  rosterMode: 'snapshot' | 'official_sync';
  rosterSyncStatus: 'pending' | 'processing' | 'ready' | 'failed' | null;
  rosterLastSyncedAt: string | null;
  setupStatus: TournamentSetupStatus;
  setupPhase: TournamentSetupPhase;
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
    rosterLastSyncedAt: exactTimestamp(row.rosterLastSyncedAt),
    setupProgressUpdatedAt: exactTimestamp(row.setupProgressUpdatedAt),
    officialScheduleHash: row.officialScheduleHash,
    officialScheduleSyncedAt: exactTimestamp(row.officialScheduleSyncedAt),
    officialScheduleLockedAt: exactTimestamp(row.officialScheduleLockedAt),
  };
}

export const createTournamentInfoRepository = (dbInstance?: DbOrTransaction) => {
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
            updatedAt: sql<string>`${tournamentsInCompetition.updatedAt}::text`,
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
      updates: Array<{
        id: number;
        sourceLeagueName: string;
        leagueId: number;
        leagueType: LeagueType;
        expectedUpdatedAt: string;
      }>,
    ): Promise<number> => {
      if (updates.length === 0) return 0;

      try {
        const persist = async () => {
          const db = await getDbInstance();
          const payload = JSON.stringify(updates);
          const rows = (await db.execute(sql`
            UPDATE ${tournamentsInCompetition} AS tournament
            SET source_league_name = data."sourceLeagueName",
                updated_at = clock_timestamp()
            FROM jsonb_to_recordset(${payload}::jsonb) AS data(
              id int, "sourceLeagueName" text, "leagueId" int,
              "leagueType" text, "expectedUpdatedAt" timestamptz
            )
            WHERE tournament.season_id = ${season.seasonId}
              AND tournament.tournament_id = data.id
              AND tournament.league_id = data."leagueId"
              AND tournament.league_type::text = data."leagueType"
              AND tournament.updated_at = data."expectedUpdatedAt"
            RETURNING tournament.tournament_id
          `)) as unknown as Array<{ tournamentId: number }>;
          return rows.length;
        };
        if (dbInstance) return await persist();
        return await withMutationScopes(
          {
            queueName: 'tournament-sync',
            jobName: 'tournament-info',
            scopes: ['tournament-info:all'],
          },
          persist,
        );
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
          setupAttempt: tournamentsInCompetition.setupAttempt,
          setupMaxAttempts: tournamentsInCompetition.setupMaxAttempts,
          setupNextRetryAt: sql<string | null>`${tournamentsInCompetition.setupNextRetryAt}::text`,
          setupLastErrorCode: tournamentsInCompetition.setupLastErrorCode,
          setupLastErrorAt: sql<string | null>`${tournamentsInCompetition.setupLastErrorAt}::text`,
          setupProgressIndeterminate: tournamentsInCompetition.setupProgressIndeterminate,
          profilesReadyAt: sql<string | null>`${tournamentsInCompetition.profilesReadyAt}::text`,
          insightsReadyAt: sql<string | null>`${tournamentsInCompetition.insightsReadyAt}::text`,
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
      attempt?: number,
    ): Promise<TournamentSetupExecution> => {
      const db = await getDbInstance();
      const safeAttempt = attempt === undefined ? null : Math.max(1, Math.trunc(attempt));
      const rows = await db
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
          setupAttempt:
            safeAttempt === null
              ? sql`${tournamentsInCompetition.setupAttempt} + 1`
              : sql`LEAST(${tournamentsInCompetition.setupMaxAttempts}, ${safeAttempt})`,
          setupNextRetryAt: null,
          setupLastErrorCode: null,
          setupLastErrorAt: null,
          setupProgressIndeterminate: false,
          profilesReadyAt: null,
          insightsReadyAt: null,
          setupStartedAt: sql`GREATEST(clock_timestamp(), COALESCE(
            ${tournamentsInCompetition.setupStartedAt} + interval '1 microsecond', clock_timestamp()
          ))`,
          setupFinishedAt: null,
          standingsReadyAt: null,
          updatedAt: new Date(),
        })
        .where(tournamentScope(season, tournamentId))
        .returning({
          startedAt: sql<string>`${tournamentsInCompetition.setupStartedAt}::text`,
          attempt: tournamentsInCompetition.setupAttempt,
        });
      const execution = rows[0];
      if (!execution) throw new Error(`Tournament ${tournamentId} no longer exists`);
      return execution;
    },

    lockSetupExecution: async (
      season: FplSeasonRef,
      tournamentId: number,
      execution: TournamentSetupExecution,
    ): Promise<boolean> => {
      const db = await getDbInstance();
      const rows = await db
        .select({ id: tournamentsInCompetition.tournamentId })
        .from(tournamentsInCompetition)
        .where(
          and(
            tournamentScope(season, tournamentId),
            eq(tournamentsInCompetition.setupStatus, 'processing'),
            sql`${tournamentsInCompetition.setupNextRetryAt} IS NULL`,
            eq(tournamentsInCompetition.setupAttempt, execution.attempt),
            sql`${tournamentsInCompetition.setupStartedAt} = ${execution.startedAt}::timestamptz`,
          ),
        )
        .for('update');
      return rows.length === 1;
    },

    markSetupRetryQueued: async (
      season: FplSeasonRef,
      tournamentId: number,
      expectedSetupProgressUpdatedAt?: string | null,
    ): Promise<string | null> => {
      const db = await getDbInstance();
      const rows = await db
        .update(tournamentsInCompetition)
        .set({
          setupStatus: 'processing',
          setupError: null,
          setupPhase: 'queued',
          setupCompletedUnits: 0,
          setupTotalUnits: 0,
          // A prepared manual retry is itself the durable queue-admission
          // reservation. If another caller arrives before BullMQ accepts the
          // first delivery, keep that marker so both callers target one
          // deterministic job slot instead of superseding one another.
          setupProgressUpdatedAt: sql`CASE
            WHEN ${tournamentsInCompetition.setupStatus} = 'processing'
              AND ${tournamentsInCompetition.setupPhase} = 'queued'
              AND ${tournamentsInCompetition.setupAttempt} = 0
              AND ${tournamentsInCompetition.setupNextRetryAt} IS NULL
              AND ${tournamentsInCompetition.setupStartedAt} IS NULL
              AND ${tournamentsInCompetition.setupProgressUpdatedAt} IS NOT NULL
              THEN ${tournamentsInCompetition.setupProgressUpdatedAt}
            ELSE clock_timestamp()
          END`,
          setupWarningCount: 0,
          setupAttempt: 0,
          setupNextRetryAt: null,
          setupLastErrorCode: null,
          setupLastErrorAt: null,
          setupProgressIndeterminate: false,
          setupStartedAt: null,
          setupFinishedAt: null,
          standingsReadyAt: null,
          profilesReadyAt: null,
          insightsReadyAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            tournamentScope(season, tournamentId),
            expectedSetupProgressUpdatedAt === undefined
              ? undefined
              : sql`${tournamentsInCompetition.setupProgressUpdatedAt} IS NOT DISTINCT FROM ${expectedSetupProgressUpdatedAt}::timestamptz`,
          ),
        )
        .returning({
          id: tournamentsInCompetition.tournamentId,
          marker: sql<string>`${tournamentsInCompetition.setupProgressUpdatedAt}::text`,
        });
      return rows[0]?.marker ?? null;
    },

    markSetupProgress: async (
      season: FplSeasonRef,
      tournamentId: number,
      phase: TournamentSetupPhase,
      completedUnits: number,
      totalUnits: number,
      progressMarker?: string | null,
      progressIndeterminate = false,
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
          setupProgressIndeterminate: progressIndeterminate,
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
      lastErrorCode?: string | null,
    ): Promise<void> => {
      const db = await getDbInstance();
      await db
        .update(tournamentsInCompetition)
        .set({
          setupStatus: status,
          setupPhase: status,
          setupWarningCount: status === 'ready' ? Math.max(0, warningCount) : 0,
          // Warning text belongs in tournament_setup_issues. A READY row
          // never carries a warning sentence or an upstream exception.
          setupError: status === 'ready' ? null : 'Tournament setup failed.',
          setupNextRetryAt: null,
          setupLastErrorCode: status === 'failed' ? (lastErrorCode ?? 'SETUP_FAILED') : null,
          setupLastErrorAt: status === 'failed' ? new Date() : null,
          setupProgressIndeterminate: false,
          setupProgressUpdatedAt:
            progressMarker !== undefined ? sql`${progressMarker}::timestamptz` : new Date(),
          setupFinishedAt: sql`GREATEST(clock_timestamp(), ${tournamentsInCompetition.setupStartedAt})`,
          updatedAt: new Date(),
        })
        .where(tournamentScope(season, tournamentId));
    },

    markSetupResultIfUnchanged: async (
      season: FplSeasonRef,
      tournamentId: number,
      status: 'ready' | 'failed',
      error: string | null | undefined,
      expectedProgressMarker: string | null,
      warningCount = status === 'ready' && error ? 1 : 0,
      lastErrorCode?: string | null,
    ): Promise<boolean> => {
      const db = await getDbInstance();
      const rows = await db
        .update(tournamentsInCompetition)
        .set({
          setupStatus: status,
          setupPhase: status,
          setupWarningCount: status === 'ready' ? Math.max(0, warningCount) : 0,
          setupError: status === 'ready' ? null : 'Tournament setup failed.',
          setupNextRetryAt: null,
          setupLastErrorCode: status === 'failed' ? (lastErrorCode ?? 'SETUP_FAILED') : null,
          setupLastErrorAt: status === 'failed' ? new Date() : null,
          setupProgressIndeterminate: false,
          // Keep the owner marker unchanged while settling the enqueue error.
          setupProgressUpdatedAt: sql`${expectedProgressMarker}::timestamptz`,
          setupFinishedAt: sql`GREATEST(clock_timestamp(), ${tournamentsInCompetition.setupStartedAt})`,
          updatedAt: new Date(),
        })
        .where(
          and(
            tournamentScope(season, tournamentId),
            inArray(tournamentsInCompetition.setupStatus, ['pending', 'processing']),
            eq(tournamentsInCompetition.setupPhase, 'queued'),
            sql`${tournamentsInCompetition.setupFinishedAt} IS NULL`,
            sql`${tournamentsInCompetition.setupProgressUpdatedAt} IS NOT DISTINCT FROM ${expectedProgressMarker}::timestamptz`,
          ),
        )
        .returning({ tournamentId: tournamentsInCompetition.tournamentId });
      return rows.length === 1;
    },

    markSetupAttemptFailure: async (
      season: FplSeasonRef,
      tournamentId: number,
      failure: TournamentSetupAttemptFailure,
    ): Promise<boolean> => {
      const db = await getDbInstance();
      const now = new Date();
      const attempt = Math.max(1, Math.trunc(failure.attempt));
      const rows = await db
        .update(tournamentsInCompetition)
        .set({
          setupStatus: failure.terminal ? 'failed' : 'processing',
          setupPhase: failure.terminal ? 'failed' : 'queued',
          setupCompletedUnits: 0,
          setupTotalUnits: 0,
          setupWarningCount: 0,
          setupError: failure.terminal ? 'Tournament setup failed.' : null,
          setupNextRetryAt: failure.terminal ? null : failure.nextRetryAt,
          setupAttempt: sql`LEAST(${tournamentsInCompetition.setupMaxAttempts}, ${attempt})`,
          setupLastErrorCode: failure.errorCode,
          setupLastErrorAt: now,
          setupProgressIndeterminate: false,
          setupProgressUpdatedAt:
            failure.progressMarker !== undefined
              ? sql`${failure.progressMarker}::timestamptz`
              : now,
          setupStartedAt: sql`COALESCE(
            ${tournamentsInCompetition.setupStartedAt},
            ${failure.startedAt.toISOString()}::timestamptz
          )`,
          setupFinishedAt: failure.terminal
            ? sql`GREATEST(clock_timestamp(), ${tournamentsInCompetition.setupStartedAt}, ${failure.startedAt.toISOString()}::timestamptz)`
            : null,
          standingsReadyAt: null,
          profilesReadyAt: null,
          insightsReadyAt: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            tournamentScope(season, tournamentId),
            failure.progressMarker === undefined
              ? undefined
              : sql`${tournamentsInCompetition.setupProgressUpdatedAt} IS NOT DISTINCT FROM ${failure.progressMarker}::timestamptz`,
            inArray(tournamentsInCompetition.setupStatus, ['pending', 'processing']),
            sql`${tournamentsInCompetition.setupFinishedAt} IS NULL`,
            failure.execution
              ? and(
                  eq(tournamentsInCompetition.setupAttempt, failure.execution.attempt),
                  sql`${tournamentsInCompetition.setupNextRetryAt} IS NULL`,
                  sql`${tournamentsInCompetition.setupStartedAt} = ${failure.execution.startedAt}::timestamptz`,
                )
              : failure.expectedState
                ? and(
                    eq(
                      tournamentsInCompetition.setupAttempt,
                      failure.expectedState.setupAttempt ?? 0,
                    ),
                    eq(tournamentsInCompetition.setupStatus, failure.expectedState.setupStatus),
                    sql`${tournamentsInCompetition.setupStartedAt} IS NOT DISTINCT FROM ${failure.expectedState.setupStartedAt}::timestamptz`,
                    sql`${tournamentsInCompetition.setupProgressUpdatedAt} IS NOT DISTINCT FROM ${failure.expectedState.setupProgressUpdatedAt}::timestamptz`,
                    failure.terminal
                      ? lte(tournamentsInCompetition.setupAttempt, attempt)
                      : lt(tournamentsInCompetition.setupAttempt, attempt),
                  )
                : sql`false`,
          ),
        )
        .returning({ tournamentId: tournamentsInCompetition.tournamentId });
      return rows.length === 1;
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
          setupStartedAt: sql<string | null>`${tournamentsInCompetition.setupStartedAt}::text`,
          setupAttempt: tournamentsInCompetition.setupAttempt,
          setupCompletedUnits: tournamentsInCompetition.setupCompletedUnits,
          setupTotalUnits: tournamentsInCompetition.setupTotalUnits,
          setupWarningCount: tournamentsInCompetition.setupWarningCount,
          setupError: tournamentsInCompetition.setupError,
          setupNextRetryAt: sql<string | null>`${tournamentsInCompetition.setupNextRetryAt}::text`,
          setupFinishedAt: sql<string | null>`${tournamentsInCompetition.setupFinishedAt}::text`,
          setupLastErrorCode: tournamentsInCompetition.setupLastErrorCode,
          setupLastErrorAt: sql<string | null>`${tournamentsInCompetition.setupLastErrorAt}::text`,
          setupProgressIndeterminate: tournamentsInCompetition.setupProgressIndeterminate,
          standingsReadyAt: sql<string | null>`${tournamentsInCompetition.standingsReadyAt}::text`,
          profilesReadyAt: sql<string | null>`${tournamentsInCompetition.profilesReadyAt}::text`,
          insightsReadyAt: sql<string | null>`${tournamentsInCompetition.insightsReadyAt}::text`,
          updatedAt: sql<string>`${tournamentsInCompetition.updatedAt}::text`,
          state: tournamentsInCompetition.state,
          rosterMode: tournamentsInCompetition.rosterMode,
          rosterSyncStatus: tournamentsInCompetition.rosterSyncStatus,
          rosterLastSyncedAt: sql<
            string | null
          >`${tournamentsInCompetition.rosterLastSyncedAt}::text`,
          setupStatus: tournamentsInCompetition.setupStatus,
          setupPhase: tournamentsInCompetition.setupPhase,
        })
        .from(tournamentsInCompetition)
        .where(
          and(
            eq(tournamentsInCompetition.seasonId, season.seasonId),
            inArray(tournamentsInCompetition.setupStatus, ['pending', 'processing']),
            lt(
              sql`GREATEST(
                COALESCE(
                  ${tournamentsInCompetition.setupProgressUpdatedAt},
                  ${tournamentsInCompetition.setupStartedAt},
                  '-infinity'::timestamptz
                ),
                ${tournamentsInCompetition.updatedAt}
              )`,
              cutoff,
            ),
          ),
        );
      return rows;
    },

    findReadyWithWarnings: async (season: FplSeasonRef): Promise<number[]> => {
      const db = await getDbInstance();
      const rows = await db
        .select({ id: tournamentsInCompetition.tournamentId })
        .from(tournamentsInCompetition)
        .where(
          and(
            eq(tournamentsInCompetition.seasonId, season.seasonId),
            eq(tournamentsInCompetition.setupStatus, 'ready'),
            sql`${tournamentsInCompetition.setupWarningCount} > 0`,
          ),
        );
      return rows.map((row) => row.id);
    },

    markStuckSetupQueuedIfUnchanged: async (
      season: FplSeasonRef,
      tournamentId: number,
      expectedProgressUpdatedAt: string | null,
      expectedSetupStartedAt: string | null,
      expectedSetupAttempt: number | null,
    ): Promise<string | null> => {
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
          // A watchdog replay is part of the same setup lifecycle. Preserve
          // the attempt counter so a lost/delayed BullMQ job cannot reset the
          // three-attempt terminal gate on every watchdog tick.
          // Recovery diagnostics are kept in structured error-code columns;
          // setup_error is reserved for a terminal blocking error.
          setupError: null,
          setupLastErrorCode: sql`COALESCE(
            ${tournamentsInCompetition.setupLastErrorCode},
            'STUCK_SETUP_RECOVERY'
          )`,
          setupLastErrorAt: now,
          setupNextRetryAt: now,
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
            sql`${tournamentsInCompetition.setupStartedAt} IS NOT DISTINCT FROM ${expectedSetupStartedAt}::timestamptz`,
            sql`${tournamentsInCompetition.setupAttempt} IS NOT DISTINCT FROM ${expectedSetupAttempt}`,
          ),
        )
        .returning({
          tournamentId: tournamentsInCompetition.tournamentId,
          marker: sql<string>`${tournamentsInCompetition.setupProgressUpdatedAt}::text`,
        });
      return rows[0]?.marker ?? null;
    },

    markStuckOfficialResumeQueuedIfUnchanged: async (
      season: FplSeasonRef,
      tournamentId: number,
      expectedProgressUpdatedAt: string,
      expectedSetupStartedAt: string | null,
      expectedSetupAttempt: number | null,
    ): Promise<string | null> => {
      const db = await getDbInstance();
      const now = new Date();
      const rows = await db
        .update(tournamentsInCompetition)
        .set({
          // Preserve the authoritative resume marker. The follow-up roster
          // or setup enqueue carries this same marker into its admission
          // fence after the short CAS transaction commits.
          setupStatus: 'pending',
          setupPhase: 'queued',
          setupCompletedUnits: 0,
          setupTotalUnits: 0,
          setupWarningCount: 0,
          setupError: null,
          setupNextRetryAt: now,
          setupStartedAt: null,
          setupFinishedAt: null,
          standingsReadyAt: null,
          profilesReadyAt: null,
          insightsReadyAt: null,
          setupProgressIndeterminate: false,
          updatedAt: now,
        })
        .where(
          and(
            tournamentScope(season, tournamentId),
            eq(tournamentsInCompetition.state, 'inactive'),
            eq(tournamentsInCompetition.rosterMode, 'official_sync'),
            inArray(tournamentsInCompetition.rosterSyncStatus, ['processing', 'failed']),
            inArray(tournamentsInCompetition.setupStatus, ['pending', 'processing']),
            sql`COALESCE(
              ${tournamentsInCompetition.setupProgressUpdatedAt},
              ${tournamentsInCompetition.setupStartedAt}
            ) IS NOT DISTINCT FROM ${expectedProgressUpdatedAt}::timestamptz`,
            sql`${tournamentsInCompetition.setupStartedAt} IS NOT DISTINCT FROM ${expectedSetupStartedAt}::timestamptz`,
            sql`${tournamentsInCompetition.setupAttempt} IS NOT DISTINCT FROM ${expectedSetupAttempt}`,
          ),
        )
        .returning({
          recoveryUpdatedAt: sql<string>`${tournamentsInCompetition.updatedAt}::text`,
        });
      return rows[0]?.recoveryUpdatedAt ?? null;
    },

    restoreStuckSetupAfterEnqueueFailure: async (
      season: FplSeasonRef,
      tournamentId: number,
      recoveryProgressUpdatedAt: string,
      previousProgressUpdatedAt: string | null,
      previousUpdatedAt: string,
    ): Promise<boolean> => {
      const db = await getDbInstance();
      const now = new Date();
      const rows = await db
        .update(tournamentsInCompetition)
        .set({
          // Keep the row discoverable by the next watchdog pass. Restoring the
          // pre-recovery marker makes the original age visible again while the
          // queue admission is retried.
          setupStatus: 'pending',
          setupPhase: 'queued',
          setupNextRetryAt: now,
          setupProgressUpdatedAt:
            previousProgressUpdatedAt === null
              ? null
              : sql`${previousProgressUpdatedAt}::timestamptz`,
          setupLastErrorCode: 'STUCK_SETUP_QUEUE_ENQUEUE_FAILED',
          setupLastErrorAt: now,
          setupError: null,
          // The row is still undelivered. Keep its pre-recovery activity time
          // so the next watchdog pass can retry immediately instead of waiting
          // for a fresh stuck cutoff after a definitive queue failure.
          updatedAt: sql`${previousUpdatedAt}::timestamptz`,
        })
        .where(
          and(
            tournamentScope(season, tournamentId),
            eq(tournamentsInCompetition.setupStatus, 'pending'),
            eq(tournamentsInCompetition.setupPhase, 'queued'),
            sql`${tournamentsInCompetition.setupProgressUpdatedAt} IS NOT DISTINCT FROM ${recoveryProgressUpdatedAt}::timestamptz`,
          ),
        )
        .returning({ tournamentId: tournamentsInCompetition.tournamentId });
      return rows.length === 1;
    },

    restoreStuckOfficialResumeAfterEnqueueFailure: async (
      season: FplSeasonRef,
      tournamentId: number,
      recoveryUpdatedAt: string,
      previous: StuckTournamentRow,
    ): Promise<boolean> => {
      const db = await getDbInstance();
      const rows = await db
        .update(tournamentsInCompetition)
        .set({
          // Restore the exact stale execution that the official-resume CAS
          // displaced. The recovery timestamp is the CAS identity; a worker
          // or newer handoff changing any execution field makes this a no-op.
          setupStatus: previous.setupStatus,
          setupPhase: previous.setupPhase,
          setupCompletedUnits: previous.setupCompletedUnits,
          setupTotalUnits: previous.setupTotalUnits,
          setupWarningCount: previous.setupWarningCount,
          setupError: previous.setupError,
          setupNextRetryAt:
            previous.setupNextRetryAt === null
              ? null
              : sql`${previous.setupNextRetryAt}::timestamptz`,
          setupFinishedAt:
            previous.setupFinishedAt === null
              ? null
              : sql`${previous.setupFinishedAt}::timestamptz`,
          setupLastErrorCode: previous.setupLastErrorCode,
          setupLastErrorAt:
            previous.setupLastErrorAt === null
              ? null
              : sql`${previous.setupLastErrorAt}::timestamptz`,
          setupProgressIndeterminate: previous.setupProgressIndeterminate,
          setupProgressUpdatedAt:
            previous.setupProgressUpdatedAt === null
              ? null
              : sql`${previous.setupProgressUpdatedAt}::timestamptz`,
          setupStartedAt:
            previous.setupStartedAt === null ? null : sql`${previous.setupStartedAt}::timestamptz`,
          setupAttempt: previous.setupAttempt ?? 0,
          standingsReadyAt:
            previous.standingsReadyAt === null
              ? null
              : sql`${previous.standingsReadyAt}::timestamptz`,
          profilesReadyAt:
            previous.profilesReadyAt === null
              ? null
              : sql`${previous.profilesReadyAt}::timestamptz`,
          insightsReadyAt:
            previous.insightsReadyAt === null
              ? null
              : sql`${previous.insightsReadyAt}::timestamptz`,
          // Preserve the pre-CAS age for immediate watchdog eligibility.
          updatedAt: sql`${previous.updatedAt}::timestamptz`,
        })
        .where(
          and(
            tournamentScope(season, tournamentId),
            eq(tournamentsInCompetition.setupStatus, 'pending'),
            eq(tournamentsInCompetition.setupPhase, 'queued'),
            sql`${tournamentsInCompetition.setupProgressUpdatedAt} IS NOT DISTINCT FROM ${previous.setupProgressUpdatedAt}::timestamptz`,
            sql`${tournamentsInCompetition.setupStartedAt} IS NULL`,
            sql`${tournamentsInCompetition.setupAttempt} IS NOT DISTINCT FROM ${previous.setupAttempt}`,
            sql`${tournamentsInCompetition.updatedAt} = ${recoveryUpdatedAt}::timestamptz`,
          ),
        )
        .returning({ tournamentId: tournamentsInCompetition.tournamentId });
      return rows.length === 1;
    },

    createTournamentWithEntries: async (
      season: FplSeasonRef,
      plan: TournamentStructurePlan,
    ): Promise<TournamentCreatedRow> => {
      const entrySeeds = resolveTournamentEntrySeeds(plan);
      try {
        const db = await getDbInstance();
        return await db.transaction(async (tx) => {
          if (entrySeeds.length > 0) {
            await tx
              .insert(entriesInCompetition)
              .values(
                entrySeeds.map((participant) => ({
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
              setupProgressUpdatedAt: sql<
                string | null
              >`${tournamentsInCompetition.setupProgressUpdatedAt}::text`,
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
