import { getDbClient } from '../db/singleton';
import type { FplSeasonRef } from '../domain/fpl-season';
import type {
  GroupMode,
  KnockoutMode,
  LeagueType,
  TournamentRosterMode,
  TournamentSetupPhase,
  TournamentSetupStatus,
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
  rosterSyncStatus?: 'pending' | 'processing' | 'ready' | 'failed' | null;
  rosterSyncError?: string | null;
  setupStatus?: TournamentSetupStatus;
  setupPhase?: TournamentSetupPhase;
  setupError?: string | null;
  setupProgressUpdatedAt?: string | null;
  state: 'active' | 'inactive' | 'finished';
  createdAt: string;
  updatedAt: string;
}

export type TournamentDeleteResult =
  | { status: 'deleted'; tournament: TournamentManagementRecord }
  | { status: 'not_found' }
  | { status: 'forbidden' };

type TournamentManagementDatabaseRow = TournamentManagementRecord;

function normalize(row: TournamentManagementDatabaseRow | undefined) {
  if (!row) return null;
  return {
    ...row,
    groupMode: row.groupMode ?? 'no_group',
    knockoutMode: row.knockoutMode ?? 'no_knockout',
  } satisfies TournamentManagementRecord;
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === '23505');
}

export const createTournamentManagementRepository = () => ({
  findById: async (
    season: FplSeasonRef,
    tournamentId: number,
  ): Promise<TournamentManagementRecord | null> => {
    try {
      const client = await getDbClient();
      const rows = await client<TournamentManagementDatabaseRow[]>`
        SELECT
          tournament_id AS id,
          name,
          creator,
          admin_entry_id AS "adminEntryId",
          total_team_num AS "totalTeamNum",
          league_type AS "leagueType",
          group_mode AS "groupMode",
          group_num AS "groupNum",
          knockout_mode AS "knockoutMode",
          roster_mode AS "rosterMode",
          roster_sync_status AS "rosterSyncStatus",
          roster_sync_error AS "rosterSyncError",
          setup_status AS "setupStatus",
          setup_phase AS "setupPhase",
          setup_error AS "setupError",
          setup_progress_updated_at::text AS "setupProgressUpdatedAt",
          state,
          created_at::text AS "createdAt",
          updated_at::text AS "updatedAt"
        FROM competition.tournaments
        WHERE season_id = ${season.seasonId}
          AND tournament_id = ${tournamentId}
        LIMIT 1
      `;
      return normalize(rows[0]);
    } catch (error) {
      logError('Failed to retrieve tournament management record', error, { tournamentId });
      throw new DatabaseError(
        'Failed to retrieve tournament.',
        'TOURNAMENT_MANAGEMENT_FIND_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  },

  checkNameExistsExcluding: async (
    season: FplSeasonRef,
    name: string,
    tournamentId: number,
  ): Promise<boolean> => {
    try {
      const client = await getDbClient();
      const rows = await client<Array<{ exists: boolean }>>`
        SELECT EXISTS(
          SELECT 1
          FROM competition.tournaments
          WHERE season_id = ${season.seasonId}
            AND name = ${name}
            AND tournament_id <> ${tournamentId}
        ) AS exists
      `;
      return rows[0]?.exists === true;
    } catch (error) {
      logError('Failed to check tournament management name', error, { tournamentId });
      throw new DatabaseError(
        'Failed to check tournament name.',
        'TOURNAMENT_MANAGEMENT_NAME_CHECK_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  },

  updateNameOwned: async (
    season: FplSeasonRef,
    tournamentId: number,
    adminEntryId: number,
    name: string,
  ): Promise<TournamentManagementRecord | null> => {
    try {
      const client = await getDbClient();
      const rows = await client<TournamentManagementDatabaseRow[]>`
        UPDATE competition.tournaments
        SET name = ${name}, updated_at = now()
        WHERE season_id = ${season.seasonId}
          AND tournament_id = ${tournamentId}
          AND admin_entry_id = ${adminEntryId}
        RETURNING
          tournament_id AS id,
          name,
          creator,
          admin_entry_id AS "adminEntryId",
          total_team_num AS "totalTeamNum",
          league_type AS "leagueType",
          group_mode AS "groupMode",
          group_num AS "groupNum",
          knockout_mode AS "knockoutMode",
          roster_mode AS "rosterMode",
          roster_sync_status AS "rosterSyncStatus",
          roster_sync_error AS "rosterSyncError",
          state,
          created_at::text AS "createdAt",
          updated_at::text AS "updatedAt"
      `;
      const record = normalize(rows[0]);
      if (record) logInfo('Updated tournament name', { tournamentId, adminEntryId });
      return record;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError('Tournament name already exists.', 'TOURNAMENT_NAME_EXISTS');
      }
      logError('Failed to update tournament name', error, { tournamentId, adminEntryId });
      throw new DatabaseError(
        'Failed to update tournament.',
        'TOURNAMENT_MANAGEMENT_UPDATE_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  },

  updateStateOwned: async (
    season: FplSeasonRef,
    tournamentId: number,
    adminEntryId: number,
    state: 'active' | 'inactive',
    options?: { settleResume?: boolean },
  ): Promise<TournamentManagementRecord | null> => {
    try {
      const client = await getDbClient();
      const rows = await client<TournamentManagementDatabaseRow[]>`
        UPDATE competition.tournaments
        SET state = ${state},
            roster_sync_status = CASE
              WHEN ${state} = 'inactive'
                AND (
                  roster_sync_status IN ('pending', 'processing')
                  OR (
                    ${options?.settleResume === true}
                    AND roster_sync_status = 'failed'
                    AND (
                      setup_status IN ('pending', 'processing')
                      OR (setup_status = 'failed' AND setup_error IS NOT NULL)
                    )
                  )
                )
                THEN 'ready'::competition.tournament_setup_status
              ELSE roster_sync_status
            END,
            roster_sync_error = CASE
              WHEN ${state} = 'inactive'
                AND (
                  roster_sync_status IN ('pending', 'processing')
                  OR (
                    ${options?.settleResume === true}
                    AND roster_sync_status = 'failed'
                    AND (
                      setup_status IN ('pending', 'processing')
                      OR (setup_status = 'failed' AND setup_error IS NOT NULL)
                    )
                  )
                )
                THEN NULL
              ELSE roster_sync_error
            END,
            setup_status = CASE
              WHEN ${state} = 'inactive'
                AND roster_sync_status IN ('processing', 'failed')
                AND (
                  setup_status IN ('pending', 'processing')
                  OR (
                    ${options?.settleResume === true}
                    AND setup_status = 'failed'
                    AND setup_error IS NOT NULL
                  )
                )
                THEN 'ready'::competition.tournament_setup_status
              ELSE setup_status
            END,
            setup_phase = CASE
              WHEN ${state} = 'inactive'
                AND roster_sync_status IN ('processing', 'failed')
                AND (
                  setup_status IN ('pending', 'processing')
                  OR (
                    ${options?.settleResume === true}
                    AND setup_status = 'failed'
                    AND setup_error IS NOT NULL
                  )
                )
                THEN 'ready'::competition.tournament_setup_phase
              ELSE setup_phase
            END,
            setup_error = CASE
              WHEN ${state} = 'inactive'
                AND roster_sync_status IN ('processing', 'failed')
                AND (
                  setup_status IN ('pending', 'processing')
                  OR (
                    ${options?.settleResume === true}
                    AND setup_status = 'failed'
                    AND setup_error IS NOT NULL
                  )
                )
                THEN NULL
              ELSE setup_error
            END,
            setup_progress_updated_at = CASE
              WHEN ${state} = 'inactive'
                AND roster_sync_status IN ('processing', 'failed')
                AND (
                  setup_status IN ('pending', 'processing')
                  OR (setup_status = 'failed' AND setup_error IS NOT NULL)
                )
                THEN now()
              ELSE setup_progress_updated_at
            END,
            updated_at = now()
        WHERE season_id = ${season.seasonId}
          AND tournament_id = ${tournamentId}
          AND admin_entry_id = ${adminEntryId}
          AND state <> 'finished'
        RETURNING
          tournament_id AS id,
          name,
          creator,
          admin_entry_id AS "adminEntryId",
          total_team_num AS "totalTeamNum",
          league_type AS "leagueType",
          group_mode AS "groupMode",
          group_num AS "groupNum",
          knockout_mode AS "knockoutMode",
          roster_mode AS "rosterMode",
          state,
          created_at::text AS "createdAt",
          updated_at::text AS "updatedAt"
      `;
      return normalize(rows[0]);
    } catch (error) {
      logError('Failed to update tournament state', error, { tournamentId, adminEntryId, state });
      throw new DatabaseError(
        'Failed to update tournament state.',
        'TOURNAMENT_MANAGEMENT_STATE_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  },

  updateRosterModeOwned: async (
    season: FplSeasonRef,
    tournamentId: number,
    adminEntryId: number,
    rosterMode: TournamentRosterMode,
  ): Promise<TournamentManagementRecord | null> => {
    try {
      const client = await getDbClient();
      const rows = await client<TournamentManagementDatabaseRow[]>`
        UPDATE competition.tournaments
        SET roster_mode = ${rosterMode},
            roster_sync_status = CASE
              WHEN ${rosterMode} = 'official_sync'
                THEN 'pending'::competition.tournament_setup_status
              ELSE NULL
            END,
            roster_sync_error = NULL,
            updated_at = now()
        WHERE season_id = ${season.seasonId}
          AND tournament_id = ${tournamentId}
          AND admin_entry_id = ${adminEntryId}
        RETURNING
          tournament_id AS id,
          name,
          creator,
          admin_entry_id AS "adminEntryId",
          total_team_num AS "totalTeamNum",
          league_type AS "leagueType",
          group_mode AS "groupMode",
          group_num AS "groupNum",
          knockout_mode AS "knockoutMode",
          roster_mode AS "rosterMode",
          state,
          created_at::text AS "createdAt",
          updated_at::text AS "updatedAt"
      `;
      return normalize(rows[0]);
    } catch (error) {
      logError('Failed to update tournament roster mode', error, {
        tournamentId,
        adminEntryId,
        rosterMode,
      });
      throw new DatabaseError(
        'Failed to update tournament roster mode.',
        'TOURNAMENT_MANAGEMENT_ROSTER_MODE_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  },

  deleteOwned: async (
    season: FplSeasonRef,
    tournamentId: number,
    adminEntryId: number,
  ): Promise<TournamentDeleteResult> => {
    try {
      const client = await getDbClient();
      const result = await client.begin(async (tx) => {
        const rows = await tx<TournamentManagementDatabaseRow[]>`
          SELECT
            tournament_id AS id,
            name,
            creator,
            admin_entry_id AS "adminEntryId",
            total_team_num AS "totalTeamNum",
            league_type AS "leagueType",
            group_mode AS "groupMode",
            group_num AS "groupNum",
            knockout_mode AS "knockoutMode",
            roster_mode AS "rosterMode",
            state,
            created_at::text AS "createdAt",
            updated_at::text AS "updatedAt"
          FROM competition.tournaments
          WHERE season_id = ${season.seasonId}
            AND tournament_id = ${tournamentId}
          FOR UPDATE
        `;
        const row = normalize(rows[0]);
        if (!row) return { status: 'not_found' } as const;
        if (row.adminEntryId !== adminEntryId) return { status: 'forbidden' } as const;

        await tx`
          DELETE FROM competition.tournament_knockout_results
          WHERE season_id = ${season.seasonId} AND tournament_id = ${tournamentId}
        `;
        await tx`
          DELETE FROM competition.tournament_knockouts
          WHERE season_id = ${season.seasonId} AND tournament_id = ${tournamentId}
        `;
        await tx`
          DELETE FROM competition.tournament_battle_group_results
          WHERE season_id = ${season.seasonId} AND tournament_id = ${tournamentId}
        `;
        await tx`
          DELETE FROM competition.tournament_points_group_results
          WHERE season_id = ${season.seasonId} AND tournament_id = ${tournamentId}
        `;
        await tx`
          DELETE FROM competition.tournament_groups
          WHERE season_id = ${season.seasonId} AND tournament_id = ${tournamentId}
        `;
        await tx`
          DELETE FROM competition.tournament_entries
          WHERE season_id = ${season.seasonId} AND tournament_id = ${tournamentId}
        `;
        await tx`
          DELETE FROM competition.tournaments
          WHERE season_id = ${season.seasonId} AND tournament_id = ${tournamentId}
        `;

        return { status: 'deleted', tournament: row } as const;
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
        error instanceof Error ? error : undefined,
      );
    }
  },
});

export const tournamentManagementRepository = createTournamentManagementRepository();
