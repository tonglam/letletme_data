import { getDbClient } from '../db/singleton';
import type {
  GroupMode,
  KnockoutMode,
  LeagueType,
  TournamentRosterMode,
} from '../domain/tournament';
import { ConflictError, DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

export interface TournamentManagementRecord {
  id: number;
  name: string;
  creator: string;
  adminEntryId: number;
  totalTeamNum: number;
  leagueType: LeagueType;
  groupMode: GroupMode;
  groupNum: number | null;
  knockoutMode: KnockoutMode;
  rosterMode: TournamentRosterMode;
  state: 'active' | 'inactive' | 'finished';
  createdAt: string;
  updatedAt: string;
}

export type TournamentDeleteResult =
  | { status: 'deleted'; tournament: TournamentManagementRecord }
  | { status: 'not_found' }
  | { status: 'forbidden' };

type TournamentManagementDatabaseRow = {
  id: number;
  name: string;
  creator: string;
  admin_entry_id: number;
  total_team_num: number;
  league_type: LeagueType;
  group_mode: GroupMode;
  group_num: number | null;
  knockout_mode: KnockoutMode;
  roster_mode: TournamentRosterMode;
  state: 'active' | 'inactive' | 'finished';
  created_at: string;
  updated_at: string;
};

function mapRecord(row: TournamentManagementDatabaseRow): TournamentManagementRecord {
  return {
    id: row.id,
    name: row.name,
    creator: row.creator,
    adminEntryId: row.admin_entry_id,
    totalTeamNum: row.total_team_num,
    leagueType: row.league_type,
    groupMode: row.group_mode,
    groupNum: row.group_num,
    knockoutMode: row.knockout_mode,
    rosterMode: row.roster_mode,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === '23505');
}

export const createTournamentManagementRepository = () => ({
  findById: async (tournamentId: number): Promise<TournamentManagementRecord | null> => {
    try {
      const client = await getDbClient();
      const rows = await client<TournamentManagementDatabaseRow[]>`
        select
          id,
          name,
          creator,
          admin_entry_id,
          total_team_num,
          league_type,
          group_mode,
          group_num,
          knockout_mode,
          roster_mode,
          state,
          created_at::text,
          updated_at::text
        from tournament_infos
        where id = ${tournamentId}
        limit 1
      `;
      return rows[0] ? mapRecord(rows[0]) : null;
    } catch (error) {
      logError('Failed to retrieve tournament management record', error, { tournamentId });
      throw new DatabaseError(
        'Failed to retrieve tournament.',
        'TOURNAMENT_MANAGEMENT_FIND_ERROR',
        error as Error,
      );
    }
  },

  checkNameExistsExcluding: async (name: string, tournamentId: number): Promise<boolean> => {
    try {
      const client = await getDbClient();
      const rows = await client<{ exists: boolean }[]>`
        select exists(
          select 1
          from tournament_infos
          where name = ${name} and id <> ${tournamentId}
        ) as exists
      `;
      return rows[0]?.exists === true;
    } catch (error) {
      logError('Failed to check tournament management name', error, { tournamentId });
      throw new DatabaseError(
        'Failed to check tournament name.',
        'TOURNAMENT_MANAGEMENT_NAME_CHECK_ERROR',
        error as Error,
      );
    }
  },

  updateNameOwned: async (
    tournamentId: number,
    adminEntryId: number,
    name: string,
  ): Promise<TournamentManagementRecord | null> => {
    try {
      const client = await getDbClient();
      const rows = await client<TournamentManagementDatabaseRow[]>`
        update tournament_infos
        set name = ${name}, updated_at = now()
        where id = ${tournamentId} and admin_entry_id = ${adminEntryId}
        returning
          id,
          name,
          creator,
          admin_entry_id,
          total_team_num,
          league_type,
          group_mode,
          group_num,
          knockout_mode,
          roster_mode,
          state,
          created_at::text,
          updated_at::text
      `;
      if (!rows[0]) return null;
      logInfo('Updated tournament name', { tournamentId, adminEntryId });
      return mapRecord(rows[0]);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError('Tournament name already exists.', 'TOURNAMENT_NAME_EXISTS');
      }
      logError('Failed to update tournament name', error, { tournamentId, adminEntryId });
      throw new DatabaseError(
        'Failed to update tournament.',
        'TOURNAMENT_MANAGEMENT_UPDATE_ERROR',
        error as Error,
      );
    }
  },

  updateStateOwned: async (
    tournamentId: number,
    adminEntryId: number,
    state: 'active' | 'inactive',
  ): Promise<TournamentManagementRecord | null> => {
    try {
      const client = await getDbClient();
      const rows = await client<TournamentManagementDatabaseRow[]>`
        update tournament_infos
        set state = ${state}, updated_at = now()
        where id = ${tournamentId}
          and admin_entry_id = ${adminEntryId}
          and state <> 'finished'
        returning
          id,
          name,
          creator,
          admin_entry_id,
          total_team_num,
          league_type,
          group_mode,
          group_num,
          knockout_mode,
          roster_mode,
          state,
          created_at::text,
          updated_at::text
      `;
      return rows[0] ? mapRecord(rows[0]) : null;
    } catch (error) {
      logError('Failed to update tournament state', error, { tournamentId, adminEntryId, state });
      throw new DatabaseError(
        'Failed to update tournament state.',
        'TOURNAMENT_MANAGEMENT_STATE_ERROR',
        error as Error,
      );
    }
  },

  updateRosterModeOwned: async (
    tournamentId: number,
    adminEntryId: number,
    rosterMode: TournamentRosterMode,
  ): Promise<TournamentManagementRecord | null> => {
    try {
      const client = await getDbClient();
      const rows = await client<TournamentManagementDatabaseRow[]>`
        update tournament_infos
        set roster_mode = ${rosterMode},
            roster_sync_status = case
              when ${rosterMode} = 'official_sync' then 'pending'::tournament_setup_status
              else null
            end,
            roster_sync_error = null,
            updated_at = now()
        where id = ${tournamentId} and admin_entry_id = ${adminEntryId}
        returning
          id,
          name,
          creator,
          admin_entry_id,
          total_team_num,
          league_type,
          group_mode,
          group_num,
          knockout_mode,
          roster_mode,
          state,
          created_at::text,
          updated_at::text
      `;
      return rows[0] ? mapRecord(rows[0]) : null;
    } catch (error) {
      logError('Failed to update tournament roster mode', error, {
        tournamentId,
        adminEntryId,
        rosterMode,
      });
      throw new DatabaseError(
        'Failed to update tournament roster mode.',
        'TOURNAMENT_MANAGEMENT_ROSTER_MODE_ERROR',
        error as Error,
      );
    }
  },

  deleteOwned: async (
    tournamentId: number,
    adminEntryId: number,
  ): Promise<TournamentDeleteResult> => {
    try {
      const client = await getDbClient();
      const result = await client.begin(async (tx) => {
        const rows = await tx<TournamentManagementDatabaseRow[]>`
          select
            id,
            name,
            creator,
            admin_entry_id,
            total_team_num,
            league_type,
            group_mode,
            group_num,
            knockout_mode,
            roster_mode,
            state,
            created_at::text,
            updated_at::text
          from tournament_infos
          where id = ${tournamentId}
          for update
        `;
        const row = rows[0];
        if (!row) return { status: 'not_found' } as const;
        if (row.admin_entry_id !== adminEntryId) return { status: 'forbidden' } as const;

        await tx`delete from tournament_selection_stats where tournament_id = ${tournamentId}`;
        await tx`delete from tournament_knockout_results where tournament_id = ${tournamentId}`;
        await tx`delete from tournament_knockouts where tournament_id = ${tournamentId}`;
        await tx`delete from tournament_battle_group_results where tournament_id = ${tournamentId}`;
        await tx`delete from tournament_points_group_results where tournament_id = ${tournamentId}`;
        await tx`delete from tournament_groups where tournament_id = ${tournamentId}`;
        await tx`delete from tournament_entries where tournament_id = ${tournamentId}`;
        await tx`delete from tournament_infos where id = ${tournamentId}`;

        return { status: 'deleted', tournament: mapRecord(row) } as const;
      });
      if (result.status === 'deleted') {
        logInfo('Deleted tournament and related data', { tournamentId, adminEntryId });
      }
      return result;
    } catch (error) {
      logError('Failed to delete tournament', error, { tournamentId, adminEntryId });
      throw new DatabaseError(
        'Failed to delete tournament.',
        'TOURNAMENT_MANAGEMENT_DELETE_ERROR',
        error as Error,
      );
    }
  },
});

export const tournamentManagementRepository = createTournamentManagementRepository();
