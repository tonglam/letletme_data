import { getDbClient } from '../db/singleton';
import { ConflictError, DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

export interface TournamentManagementRecord {
  id: number;
  name: string;
  creator: string;
  adminEntryId: number;
  totalTeamNum: number;
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
