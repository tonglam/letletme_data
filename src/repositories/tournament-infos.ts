import { and, eq, gte, lt, lte, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

import { tournamentInfos, type DbTournamentInfo } from '../db/schemas/index.schema';
import { getDb, getDbClient } from '../db/singleton';
import type {
  GroupMode,
  KnockoutMode,
  LeagueType,
  TournamentConfig,
  TournamentSetupStatus,
  TournamentStructurePlan,
} from '../domain/tournament';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

type DatabaseInstance = PostgresJsDatabase<Record<string, never>>;

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
  leagueId: number;
  leagueType: LeagueType;
}

export interface TournamentSetupStatusRow {
  setupStatus: TournamentSetupStatus;
  setupError: string | null;
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
  setupStartedAt: string | null;
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

    updateNames: async (updates: Array<{ id: number; name: string }>): Promise<number> => {
      if (updates.length === 0) {
        return 0;
      }

      try {
        const client = await getDbClient();
        const ids = updates.map((u) => u.id);
        const names = updates.map((u) => u.name);

        await client`
          update tournament_infos as ti
          set name = data.new_name,
              updated_at = now()
          from (
            select unnest(${ids}::int[]) as id,
                   unnest(${names}::text[]) as new_name
          ) as data
          where ti.id = data.id
        `;

        logInfo('Updated tournament info names', { count: updates.length });
        return updates.length;
      } catch (error) {
        logError('Failed to update tournament info names', error, { count: updates.length });
        throw new DatabaseError(
          'Failed to update tournament info names',
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
          .where(eq(tournamentInfos.state, 'active'));
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
            setup_status: TournamentSetupStatus;
            setup_error: string | null;
            setup_started_at: string | null;
            setup_finished_at: string | null;
          }[]
        >`
          select
            setup_status,
            setup_error,
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
          setupStatus: rows[0].setup_status,
          setupError: rows[0].setup_error,
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
            setupStartedAt: new Date(),
            setupFinishedAt: null,
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

    markSetupResult: async (
      tournamentId: number,
      status: 'ready' | 'failed',
      error?: string | null,
    ): Promise<void> => {
      try {
        const db = await getDbInstance();
        await db
          .update(tournamentInfos)
          .set({
            setupStatus: status,
            setupError: error ?? null,
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
        const cutoff = new Date(Date.now() - cutoffMinutes * 60_000);
        const rows = await db
          .select({
            id: tournamentInfos.id,
            setupStartedAt: tournamentInfos.setupStartedAt,
          })
          .from(tournamentInfos)
          .where(
            and(
              eq(tournamentInfos.setupStatus, 'processing'),
              lt(tournamentInfos.setupStartedAt, cutoff),
            ),
          );
        return rows.map((row) => ({
          id: row.id,
          setupStartedAt: row.setupStartedAt ? row.setupStartedAt.toISOString() : null,
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
              updated_at
            ) values (
              ${plan.tournamentName},
              ${plan.creator},
              ${plan.adminEntryId},
              ${plan.leagueId},
              ${plan.leagueType},
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
