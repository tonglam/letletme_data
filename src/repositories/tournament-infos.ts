import { and, eq, gte, inArray, isNotNull, lt, lte, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import { tournamentInfos, type DbTournamentInfo } from '../db/schemas/index.schema';
import { getDb, getDbClient } from '../db/singleton';
import type {
  GroupMode,
  KnockoutMode,
  LeagueType,
  TournamentConfig,
  TournamentRosterMode,
  TournamentSetupPhase,
  TournamentSetupStatus,
  TournamentStructurePlan,
} from '../domain/tournament';
import { ConflictError, DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

type DatabaseInstance = PostgresJsDatabase<Record<string, never>>;

export const isTournamentNameConflict = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false;
  const record = error as { code?: unknown; constraint_name?: unknown; constraint?: unknown };
  const constraint = String(record.constraint_name ?? record.constraint ?? '');
  return record.code === '23505' && constraint === 'unique_tournament_name';
};

export interface TournamentInfoSummary {
  id: number;
  leagueId: number;
  leagueType: LeagueType;
  totalTeamNum: number;
  groupMode: GroupMode;
  groupStartedEventId: number | null;
  groupEndedEventId: number | null;
  groupQualifyNum: number | null;
  knockoutMode: KnockoutMode;
  knockoutStartedEventId: number | null;
  knockoutEndedEventId: number | null;
  state: 'active' | 'inactive' | 'finished';
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
  name: string;
  creator: string;
  adminEntryId: number;
  leagueId: number;
  totalTeamNum: number;
}

export interface StuckTournamentRow {
  id: number;
  setupProgressUpdatedAt: string | null;
}

export interface OfficialSyncTournamentRow {
  id: number;
  adminEntryId: number;
  leagueId: number;
  leagueType: LeagueType;
  rosterMode: TournamentRosterMode;
  state: 'active' | 'inactive' | 'finished';
}

function mapTournamentInfo(row: DbTournamentInfo): TournamentInfoSummary {
  return {
    id: row.id,
    leagueId: row.leagueId,
    leagueType: row.leagueType,
    totalTeamNum: row.totalTeamNum,
    groupMode: row.groupMode,
    groupStartedEventId: row.groupStartedEventId,
    groupEndedEventId: row.groupEndedEventId,
    groupQualifyNum: row.groupQualifyNum,
    knockoutMode: row.knockoutMode,
    knockoutStartedEventId: row.knockoutStartedEventId,
    knockoutEndedEventId: row.knockoutEndedEventId,
    state: row.state,
  };
}

export const createTournamentInfoRepository = (dbInstance?: DatabaseInstance) => {
  const getDbInstance = async () => dbInstance || (await getDb());

  return {
    findAllNames: async (): Promise<TournamentInfoNameSummary[]> => {
      try {
        const db = await getDbInstance();
        const rows = await db
          .select({
            id: tournamentInfos.id,
            name: tournamentInfos.name,
            sourceLeagueName: tournamentInfos.sourceLeagueName,
            leagueId: tournamentInfos.leagueId,
            leagueType: tournamentInfos.leagueType,
          })
          .from(tournamentInfos);
        logInfo('Retrieved tournament info names', { count: rows.length });
        return rows as TournamentInfoNameSummary[];
      } catch (error) {
        logError('Failed to retrieve tournament info names', error);
        throw new DatabaseError(
          'Failed to retrieve tournament info names',
          'TOURNAMENT_INFO_FIND_ALL_ERROR',
          error as Error,
        );
      }
    },

    updateSourceLeagueNames: async (
      updates: Array<{ id: number; sourceLeagueName: string }>,
    ): Promise<number> => {
      if (updates.length === 0) {
        return 0;
      }

      try {
        const client = await getDbClient();
        const ids = updates.map((u) => u.id);
        const names = updates.map((u) => u.sourceLeagueName);

        await client`
          update tournament_infos as ti
          set source_league_name = data.source_league_name,
              updated_at = now()
          from (
            select unnest(${ids}::int[]) as id,
                   unnest(${names}::text[]) as source_league_name
          ) as data
          where ti.id = data.id
        `;

        logInfo('Updated tournament source league names', { count: updates.length });
        return updates.length;
      } catch (error) {
        logError('Failed to update tournament source league names', error, {
          count: updates.length,
        });
        throw new DatabaseError(
          'Failed to update tournament source league names',
          'TOURNAMENT_INFO_UPDATE_ERROR',
          error as Error,
        );
      }
    },

    findById: async (id: number): Promise<TournamentInfoSummary | null> => {
      try {
        const db = await getDbInstance();
        const rows = await db
          .select()
          .from(tournamentInfos)
          .where(eq(tournamentInfos.id, id))
          .limit(1);

        if (rows.length === 0) {
          logInfo('Tournament info not found', { id });
          return null;
        }

        return mapTournamentInfo(rows[0]);
      } catch (error) {
        logError('Failed to retrieve tournament info by id', error, { id });
        throw new DatabaseError(
          'Failed to retrieve tournament info by id',
          'TOURNAMENT_INFO_FIND_BY_ID_ERROR',
          error as Error,
        );
      }
    },

    findActive: async (): Promise<TournamentInfoSummary[]> => {
      try {
        const db = await getDbInstance();
        const rows = await db
          .select()
          .from(tournamentInfos)
          .where(
            and(eq(tournamentInfos.state, 'active'), isNotNull(tournamentInfos.standingsReadyAt)),
          );
        const result = rows.map(mapTournamentInfo);
        logInfo('Retrieved active tournament infos', { count: result.length });
        return result;
      } catch (error) {
        logError('Failed to retrieve active tournament infos', error);
        throw new DatabaseError(
          'Failed to retrieve active tournament infos',
          'TOURNAMENT_INFO_FIND_ACTIVE_ERROR',
          error as Error,
        );
      }
    },

    findPointsRaceByEvent: async (eventId: number): Promise<TournamentInfoSummary[]> => {
      try {
        const db = await getDbInstance();
        const rows = await db
          .select()
          .from(tournamentInfos)
          .where(
            and(
              eq(tournamentInfos.state, 'active'),
              isNotNull(tournamentInfos.standingsReadyAt),
              eq(tournamentInfos.groupMode, 'points_races'),
              lte(tournamentInfos.groupStartedEventId, eventId),
              gte(tournamentInfos.groupEndedEventId, eventId),
            ),
          );
        const result = rows.map(mapTournamentInfo);
        logInfo('Retrieved points race tournaments', { eventId, count: result.length });
        return result;
      } catch (error) {
        logError('Failed to retrieve points race tournaments', error, { eventId });
        throw new DatabaseError(
          'Failed to retrieve points race tournaments',
          'TOURNAMENT_INFO_POINTS_RACE_ERROR',
          error as Error,
        );
      }
    },

    findBattleRaceByEvent: async (eventId: number): Promise<TournamentInfoSummary[]> => {
      try {
        const db = await getDbInstance();
        const rows = await db
          .select()
          .from(tournamentInfos)
          .where(
            and(
              eq(tournamentInfos.state, 'active'),
              isNotNull(tournamentInfos.standingsReadyAt),
              eq(tournamentInfos.groupMode, 'battle_races'),
              lte(tournamentInfos.groupStartedEventId, eventId),
              gte(tournamentInfos.groupEndedEventId, eventId),
            ),
          );
        const result = rows.map(mapTournamentInfo);
        logInfo('Retrieved battle race tournaments', { eventId, count: result.length });
        return result;
      } catch (error) {
        logError('Failed to retrieve battle race tournaments', error, { eventId });
        throw new DatabaseError(
          'Failed to retrieve battle race tournaments',
          'TOURNAMENT_INFO_BATTLE_RACE_ERROR',
          error as Error,
        );
      }
    },

    findKnockoutByEvent: async (eventId: number): Promise<TournamentInfoSummary[]> => {
      try {
        const db = await getDbInstance();
        const rows = await db
          .select()
          .from(tournamentInfos)
          .where(
            and(
              eq(tournamentInfos.state, 'active'),
              isNotNull(tournamentInfos.standingsReadyAt),
              sql`${tournamentInfos.knockoutMode} <> 'no_knockout'`,
              lte(tournamentInfos.knockoutStartedEventId, eventId),
              gte(tournamentInfos.knockoutEndedEventId, eventId),
            ),
          );
        const result = rows.map(mapTournamentInfo);
        logInfo('Retrieved knockout tournaments', { eventId, count: result.length });
        return result;
      } catch (error) {
        logError('Failed to retrieve knockout tournaments', error, { eventId });
        throw new DatabaseError(
          'Failed to retrieve knockout tournaments',
          'TOURNAMENT_INFO_KNOCKOUT_ERROR',
          error as Error,
        );
      }
    },

    checkNameExists: async (name: string): Promise<boolean> => {
      try {
        const client = await getDbClient();
        const rows = await client<{ exists: boolean }[]>`
          select exists(
            select 1 from tournament_infos where name = ${name}
          ) as exists
        `;
        return rows[0]?.exists === true;
      } catch (error) {
        logError('Failed to check tournament name existence', error, { name });
        throw new DatabaseError(
          'Failed to check tournament name existence',
          'TOURNAMENT_INFO_NAME_CHECK_ERROR',
          error as Error,
        );
      }
    },

    findSetupConfig: async (tournamentId: number): Promise<TournamentConfig | null> => {
      try {
        const client = await getDbClient();
        const rows = await client<TournamentConfig[]>`
          select
            id,
            total_team_num as "totalTeamNum",
            group_mode as "groupMode",
            group_num as "groupNum",
            group_started_event_id as "groupStartedEventId",
            group_ended_event_id as "groupEndedEventId",
            group_qualify_num as "groupQualifyNum",
            knockout_mode as "knockoutMode",
            knockout_team_num as "knockoutTeamNum",
            knockout_event_num as "knockoutEventNum",
            knockout_started_event_id as "knockoutStartedEventId",
            knockout_ended_event_id as "knockoutEndedEventId",
            knockout_play_against_num as "knockoutPlayAgainstNum"
          from tournament_infos
          where id = ${tournamentId}
          limit 1
        `;
        return rows[0] ?? null;
      } catch (error) {
        logError('Failed to find tournament setup config', error, { tournamentId });
        throw new DatabaseError(
          'Failed to find tournament setup config',
          'TOURNAMENT_INFO_FIND_CONFIG_ERROR',
          error as Error,
        );
      }
    },

    findSetupStatus: async (tournamentId: number): Promise<TournamentSetupStatusRow | null> => {
      try {
        const client = await getDbClient();
        const rows = await client<
          {
            created_at: string;
            setup_status: TournamentSetupStatus;
            setup_error: string | null;
            setup_phase: TournamentSetupPhase;
            setup_completed_units: number;
            setup_total_units: number;
            setup_progress_updated_at: string | null;
            standings_ready_at: string | null;
            setup_warning_count: number;
            setup_started_at: string | null;
            setup_finished_at: string | null;
          }[]
        >`
          select
            created_at::text,
            setup_status,
            setup_error,
            setup_phase,
            setup_completed_units,
            setup_total_units,
            setup_progress_updated_at::text,
            standings_ready_at::text,
            setup_warning_count,
            setup_started_at::text,
            setup_finished_at::text
          from tournament_infos
          where id = ${tournamentId}
          limit 1
        `;

        if (rows.length === 0) {
          return null;
        }
        return {
          createdAt: rows[0].created_at,
          setupStatus: rows[0].setup_status,
          setupError: rows[0].setup_error,
          setupPhase: rows[0].setup_phase,
          setupCompletedUnits: rows[0].setup_completed_units,
          setupTotalUnits: rows[0].setup_total_units,
          setupProgressUpdatedAt: rows[0].setup_progress_updated_at,
          standingsReadyAt: rows[0].standings_ready_at,
          setupWarningCount: rows[0].setup_warning_count,
          setupStartedAt: rows[0].setup_started_at,
          setupFinishedAt: rows[0].setup_finished_at,
        };
      } catch (error) {
        logError('Failed to find tournament setup status', error, { tournamentId });
        throw new DatabaseError(
          'Failed to find tournament setup status',
          'TOURNAMENT_INFO_FIND_STATUS_ERROR',
          error as Error,
        );
      }
    },

    markSetupProcessing: async (tournamentId: number): Promise<void> => {
      try {
        const db = await getDbInstance();
        await db
          .update(tournamentInfos)
          .set({
            setupStatus: 'processing',
            setupError: null,
            setupPhase: 'syncing_entries',
            setupCompletedUnits: 0,
            setupTotalUnits: 0,
            setupProgressUpdatedAt: new Date(),
            setupWarningCount: 0,
            setupStartedAt: new Date(),
            setupFinishedAt: null,
            standingsReadyAt: null,
            updatedAt: new Date(),
          })
          .where(eq(tournamentInfos.id, tournamentId));
      } catch (error) {
        logError('Failed to mark tournament setup processing', error, { tournamentId });
        throw new DatabaseError(
          'Failed to mark tournament setup processing',
          'TOURNAMENT_INFO_MARK_PROCESSING_ERROR',
          error as Error,
        );
      }
    },

    markSetupRetryQueued: async (tournamentId: number): Promise<void> => {
      try {
        const db = await getDbInstance();
        await db
          .update(tournamentInfos)
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
          .where(eq(tournamentInfos.id, tournamentId));
      } catch (error) {
        logError('Failed to queue tournament setup retry', error, { tournamentId });
        throw new DatabaseError(
          'Failed to queue tournament setup retry',
          'TOURNAMENT_INFO_MARK_RETRY_QUEUED_ERROR',
          error as Error,
        );
      }
    },

    markSetupProgress: async (
      tournamentId: number,
      phase: TournamentSetupPhase,
      completedUnits: number,
      totalUnits: number,
    ): Promise<void> => {
      try {
        const db = await getDbInstance();
        const safeTotal = Math.max(0, Math.trunc(totalUnits));
        const safeCompleted = Math.min(safeTotal, Math.max(0, Math.trunc(completedUnits)));
        await db
          .update(tournamentInfos)
          .set({
            setupPhase: phase,
            setupCompletedUnits: safeCompleted,
            setupTotalUnits: safeTotal,
            setupProgressUpdatedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(tournamentInfos.id, tournamentId));
      } catch (error) {
        logError('Failed to update tournament setup progress', error, {
          tournamentId,
          phase,
          completedUnits,
          totalUnits,
        });
        throw new DatabaseError(
          'Failed to update tournament setup progress',
          'TOURNAMENT_INFO_MARK_PROGRESS_ERROR',
          error as Error,
        );
      }
    },

    markStandingsReady: async (tournamentId: number): Promise<void> => {
      try {
        const db = await getDbInstance();
        await db
          .update(tournamentInfos)
          .set({
            standingsReadyAt: sql`COALESCE(${tournamentInfos.standingsReadyAt}, now())`,
            setupProgressUpdatedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(tournamentInfos.id, tournamentId));
      } catch (error) {
        logError('Failed to publish tournament standings readiness', error, { tournamentId });
        throw new DatabaseError(
          'Failed to publish tournament standings readiness',
          'TOURNAMENT_INFO_MARK_STANDINGS_READY_ERROR',
          error as Error,
        );
      }
    },

    markSetupResult: async (
      tournamentId: number,
      status: 'ready' | 'failed',
      error?: string | null,
      warningCount = status === 'ready' && error ? 1 : 0,
    ): Promise<void> => {
      try {
        const db = await getDbInstance();
        await db
          .update(tournamentInfos)
          .set({
            setupStatus: status,
            setupPhase: status,
            setupWarningCount: status === 'ready' ? Math.max(0, warningCount) : 0,
            setupError: error ?? null,
            setupProgressUpdatedAt: new Date(),
            setupFinishedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(tournamentInfos.id, tournamentId));
      } catch (err) {
        logError('Failed to mark tournament setup result', err, { tournamentId, status });
        throw new DatabaseError(
          'Failed to mark tournament setup result',
          'TOURNAMENT_INFO_MARK_RESULT_ERROR',
          err as Error,
        );
      }
    },

    findStuckProcessing: async (cutoffMinutes: number): Promise<StuckTournamentRow[]> => {
      try {
        const db = await getDbInstance();
        // This predicate wraps timestamp columns in a raw COALESCE expression,
        // so Drizzle cannot infer the encoder for a JavaScript Date. Bind a
        // portable ISO value and let PostgreSQL infer timestamptz from the
        // comparison instead of handing postgres.js an untyped Date.
        const cutoff = new Date(Date.now() - cutoffMinutes * 60_000).toISOString();
        const rows = await db
          .select({
            id: tournamentInfos.id,
            // Keep PostgreSQL's full timestamp precision for the watchdog's
            // compare-and-swap. Converting through JavaScript Date would trim
            // microseconds and make a genuinely stale row impossible to match.
            setupProgressUpdatedAt: sql<string | null>`COALESCE(
              ${tournamentInfos.setupProgressUpdatedAt},
              ${tournamentInfos.setupStartedAt}
            )::text`,
          })
          .from(tournamentInfos)
          .where(
            and(
              inArray(tournamentInfos.setupStatus, ['pending', 'processing']),
              lt(
                sql`COALESCE(
                  ${tournamentInfos.setupProgressUpdatedAt},
                  ${tournamentInfos.setupStartedAt}
                )`,
                cutoff,
              ),
            ),
          );
        return rows.map((row) => ({
          id: row.id,
          setupProgressUpdatedAt: row.setupProgressUpdatedAt,
        }));
      } catch (error) {
        logError('Failed to find stuck processing tournaments', error, { cutoffMinutes });
        throw new DatabaseError(
          'Failed to find stuck processing tournaments',
          'TOURNAMENT_INFO_FIND_STUCK_ERROR',
          error as Error,
        );
      }
    },

    markStuckSetupFailedIfUnchanged: async (
      tournamentId: number,
      expectedProgressUpdatedAt: string | null,
      internalError: string,
    ): Promise<boolean> => {
      try {
        const db = await getDbInstance();
        const now = new Date();
        const rows = await db
          .update(tournamentInfos)
          .set({
            setupStatus: 'failed',
            setupPhase: 'failed',
            setupWarningCount: 0,
            setupError: internalError,
            setupProgressUpdatedAt: now,
            setupFinishedAt: now,
            updatedAt: now,
          })
          .where(
            and(
              eq(tournamentInfos.id, tournamentId),
              inArray(tournamentInfos.setupStatus, ['pending', 'processing']),
              sql`COALESCE(
                ${tournamentInfos.setupProgressUpdatedAt},
                ${tournamentInfos.setupStartedAt}
              ) IS NOT DISTINCT FROM ${expectedProgressUpdatedAt}::timestamptz`,
            ),
          )
          .returning({ id: tournamentInfos.id });
        return rows.length === 1;
      } catch (error) {
        logError('Failed to conditionally mark stuck tournament setup', error, {
          tournamentId,
          expectedProgressUpdatedAt,
        });
        throw new DatabaseError(
          'Failed to conditionally mark stuck tournament setup',
          'TOURNAMENT_INFO_MARK_STUCK_ERROR',
          error as Error,
        );
      }
    },

    createTournamentWithEntries: async (
      plan: TournamentStructurePlan,
    ): Promise<TournamentCreatedRow> => {
      try {
        const client = await getDbClient();
        return await client.begin(async (tx) => {
          // Insert stub rows for participants we have never synced, but NEVER
          // overwrite an existing entry: overall_rank/overall_points belong to
          // the FPL detail sync, and resetting them to league-standings values
          // (or 0) used to poison knockout seeding and rank displays (C5/FP-08).
          await tx`
            insert into entry_infos ${tx(
              plan.selectedParticipants.map((participant) => ({
                id: Number(participant.id),
                entry_name: participant.team,
                player_name: participant.manager,
                overall_rank: participant.overallRank || null,
                overall_points: participant.totalPoints || 0,
              })),
              'id',
              'entry_name',
              'player_name',
              'overall_rank',
              'overall_points',
            )}
            on conflict (id) do nothing
          `;

          const insertedTournament = await tx<
            {
              id: number;
              name: string;
              creator: string;
              admin_entry_id: number;
              league_id: number;
              total_team_num: number;
            }[]
          >`
            insert into tournament_infos (
              name,
              creator,
              admin_entry_id,
              league_id,
              league_type,
              source_league_name,
              roster_mode,
              roster_sync_status,
              roster_last_synced_at,
              total_team_num,
              tournament_mode,
              group_mode,
              group_team_num,
              group_num,
              group_started_event_id,
              group_ended_event_id,
              group_auto_averages,
              group_rounds,
              group_play_against_num,
              group_qualify_num,
              knockout_mode,
              knockout_team_num,
              knockout_rounds,
              knockout_event_num,
              knockout_started_event_id,
              knockout_ended_event_id,
              knockout_play_against_num,
              state,
              setup_status,
              setup_phase,
              setup_progress_updated_at,
              updated_at
            ) values (
              ${plan.tournamentName},
              ${plan.creator},
              ${plan.adminEntryId},
              ${plan.leagueId},
              ${plan.leagueType},
              ${plan.sourceLeagueName ?? null},
              ${plan.rosterMode ?? 'snapshot'},
              ${plan.rosterMode === 'official_sync' ? 'ready' : null},
              ${plan.rosterMode === 'official_sync' ? new Date().toISOString() : null},
              ${plan.selectedParticipants.length},
              ${'normal'},
              ${plan.groupMode},
              ${plan.groupTeamNum},
              ${plan.groupNum},
              ${plan.groupStartedEventId},
              ${plan.groupEndedEventId},
              ${false},
              ${plan.groupRounds},
              ${null},
              ${plan.groupQualifyNum},
              ${plan.knockoutMode},
              ${plan.knockoutTeamNum},
              ${plan.knockoutRounds},
              ${plan.knockoutEventNum},
              ${plan.knockoutStartedEventId},
              ${plan.knockoutEndedEventId},
              ${plan.knockoutPlayAgainstNum},
              ${'active'},
              ${'pending'},
              ${'queued'},
              now(),
              now()
            )
            returning id, name, creator, admin_entry_id, league_id, total_team_num
          `;

          const inserted = insertedTournament[0];
          if (!inserted) {
            throw new DatabaseError(
              'Tournament insert did not return an ID.',
              'TOURNAMENT_INFO_INSERT_MISSING_ID',
            );
          }

          await tx`
            insert into tournament_entries ${tx(
              plan.selectedParticipants.map((participant) => ({
                tournament_id: inserted.id,
                league_id: plan.leagueId,
                entry_id: Number(participant.id),
              })),
              'tournament_id',
              'league_id',
              'entry_id',
            )}
            on conflict (tournament_id, league_id, entry_id) do nothing
          `;

          return {
            id: inserted.id,
            name: inserted.name,
            creator: inserted.creator,
            adminEntryId: inserted.admin_entry_id,
            leagueId: inserted.league_id,
            totalTeamNum: inserted.total_team_num,
          };
        });
      } catch (error) {
        if (isTournamentNameConflict(error)) {
          throw new ConflictError('Tournament name already exists.', 'TOURNAMENT_NAME_EXISTS');
        }
        if (error instanceof DatabaseError) {
          throw error;
        }
        logError('Failed to create tournament with entries', error, {
          name: plan.tournamentName,
        });
        throw new DatabaseError(
          'Failed to create tournament with entries',
          'TOURNAMENT_INFO_CREATE_ERROR',
          error as Error,
        );
      }
    },
  };
};

export const tournamentInfoRepository = createTournamentInfoRepository();
