import { getDbClient } from '../db/singleton';
import type { FplSeasonRef } from '../domain/fpl-season';
import type {
  LeagueType,
  TournamentConfig,
  TournamentFinalizationTarget,
  TournamentParticipant,
  TournamentRosterMode,
  TournamentSetupPhase,
  TournamentSetupStatus,
} from '../domain/tournament';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

export type TournamentRosterRecord = TournamentConfig & {
  adminEntryId: number;
  leagueId: number;
  leagueType: LeagueType;
  rosterMode: TournamentRosterMode;
  state: 'active' | 'inactive' | 'finished';
  rosterSyncStatus: TournamentSetupStatus | null;
  setupStatus: TournamentSetupStatus;
  setupPhase: TournamentSetupPhase;
  standingsReadyAt: string | null;
  setupProgressUpdatedAt: string | null;
  officialScheduleLockedAt: string | null;
};

type RosterRow = TournamentRosterRecord;

export type RosterPublicationResult = {
  changed: boolean;
  participantCount: number;
  automaticallyPaused: boolean;
  skipped: boolean;
};

function normalizeRoster(row: RosterRow | undefined): TournamentRosterRecord | null {
  if (!row) return null;
  return {
    ...row,
    groupMode: row.groupMode ?? 'no_group',
    knockoutMode: row.knockoutMode ?? 'no_knockout',
  };
}

function uniqueParticipantIds(participants: TournamentParticipant[]): number[] {
  const ids = participants.map((participant) => Number(participant.id));
  if (ids.some((id) => !Number.isInteger(id) || id <= 0) || new Set(ids).size !== ids.length) {
    throw new Error('Authoritative tournament roster contains invalid or duplicate entry IDs');
  }
  return ids;
}

export const tournamentRosterRepository = {
  findById: async (
    season: FplSeasonRef,
    tournamentId: number,
  ): Promise<TournamentRosterRecord | null> => {
    try {
      const client = await getDbClient();
      const rows = await client<RosterRow[]>`
        SELECT
          tournament_id AS id,
          admin_entry_id AS "adminEntryId",
          league_id AS "leagueId",
          league_type AS "leagueType",
          roster_mode AS "rosterMode",
          state,
          roster_sync_status AS "rosterSyncStatus",
          setup_status AS "setupStatus",
          setup_phase AS "setupPhase",
          standings_ready_at::text AS "standingsReadyAt",
          setup_progress_updated_at::text AS "setupProgressUpdatedAt",
          official_schedule_locked_at::text AS "officialScheduleLockedAt",
          total_team_num AS "totalTeamNum",
          group_mode AS "groupMode",
          group_num AS "groupNum",
          group_started_event_id AS "groupStartedEventId",
          group_ended_event_id AS "groupEndedEventId",
          group_qualify_num AS "groupQualifyNum",
          knockout_mode AS "knockoutMode",
          knockout_team_num AS "knockoutTeamNum",
          knockout_event_num AS "knockoutEventNum",
          knockout_started_event_id AS "knockoutStartedEventId",
          knockout_ended_event_id AS "knockoutEndedEventId",
          knockout_play_against_num AS "knockoutPlayAgainstNum"
        FROM competition.tournaments
        WHERE season_id = ${season.seasonId}
          AND tournament_id = ${tournamentId}
        LIMIT 1
      `;
      return normalizeRoster(rows[0]);
    } catch (error) {
      logError('Failed to load tournament roster record', error, {
        season: season.seasonCode,
        tournamentId,
      });
      throw new DatabaseError(
        'Failed to load tournament roster.',
        'TOURNAMENT_ROSTER_FIND_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  },

  findActiveOfficialSync: async (season: FplSeasonRef): Promise<TournamentRosterRecord[]> => {
    try {
      const client = await getDbClient();
      const rows = await client<RosterRow[]>`
        SELECT
          tournament_id AS id,
          admin_entry_id AS "adminEntryId",
          league_id AS "leagueId",
          league_type AS "leagueType",
          roster_mode AS "rosterMode",
          state,
          standings_ready_at::text AS "standingsReadyAt",
          setup_progress_updated_at::text AS "setupProgressUpdatedAt",
          official_schedule_locked_at::text AS "officialScheduleLockedAt",
          total_team_num AS "totalTeamNum",
          group_mode AS "groupMode",
          group_num AS "groupNum",
          group_started_event_id AS "groupStartedEventId",
          group_ended_event_id AS "groupEndedEventId",
          group_qualify_num AS "groupQualifyNum",
          knockout_mode AS "knockoutMode",
          knockout_team_num AS "knockoutTeamNum",
          knockout_event_num AS "knockoutEventNum",
          knockout_started_event_id AS "knockoutStartedEventId",
          knockout_ended_event_id AS "knockoutEndedEventId",
          knockout_play_against_num AS "knockoutPlayAgainstNum"
        FROM competition.tournaments
        WHERE season_id = ${season.seasonId}
          AND state = 'active'
          AND roster_mode = 'official_sync'
        ORDER BY tournament_id
      `;
      return rows.map((row) => normalizeRoster(row)!);
    } catch (error) {
      logError('Failed to load official-sync tournaments', error, {
        season: season.seasonCode,
      });
      throw new DatabaseError(
        'Failed to load official-sync tournaments.',
        'TOURNAMENT_ROSTER_FIND_ACTIVE_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  },

  findEntryIds: async (season: FplSeasonRef, tournamentId: number): Promise<number[]> => {
    try {
      const client = await getDbClient();
      const rows = await client<Array<{ entryId: number }>>`
        SELECT entry_id AS "entryId"
        FROM competition.tournament_entries
        WHERE season_id = ${season.seasonId}
          AND tournament_id = ${tournamentId}
        ORDER BY entry_id
      `;
      return rows.map((row) => Number(row.entryId));
    } catch (error) {
      logError('Failed to load tournament roster entry IDs', error, { tournamentId });
      throw new DatabaseError(
        'Failed to load tournament roster entries.',
        'TOURNAMENT_ROSTER_FIND_ENTRIES_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  },

  hasResultRows: async (season: FplSeasonRef, tournamentId: number): Promise<boolean> => {
    try {
      const client = await getDbClient();
      const rows = await client<Array<{ exists: boolean }>>`
        SELECT EXISTS (
          SELECT 1
          FROM competition.tournament_battle_group_results
          WHERE season_id = ${season.seasonId} AND tournament_id = ${tournamentId}
          UNION ALL
          SELECT 1
          FROM competition.tournament_knockout_results
          WHERE season_id = ${season.seasonId} AND tournament_id = ${tournamentId}
          UNION ALL
          SELECT 1
          FROM competition.tournament_points_group_results
          WHERE season_id = ${season.seasonId} AND tournament_id = ${tournamentId}
        ) AS exists
      `;
      return rows[0]?.exists === true;
    } catch (error) {
      logError('Failed to inspect tournament roster result rows', error, { tournamentId });
      throw new DatabaseError(
        'Failed to inspect tournament roster results.',
        'TOURNAMENT_ROSTER_RESULTS_INSPECT_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  },

  markSyncProcessing: async (season: FplSeasonRef, tournamentId: number): Promise<void> => {
    const client = await getDbClient();
    await client`
      UPDATE competition.tournaments
      SET roster_sync_status = 'processing',
          roster_sync_error = NULL,
          -- Invalidate a queued resume marker from an older reconciliation.
          setup_progress_updated_at = now(),
          updated_at = now()
      WHERE season_id = ${season.seasonId} AND tournament_id = ${tournamentId}
    `;
  },

  markSyncProcessingIfMarker: async (
    season: FplSeasonRef,
    tournamentId: number,
    expectedMarker: string | null,
  ): Promise<boolean> => {
    const client = await getDbClient();
    const rows = await client<{ tournamentId: number }[]>`
      UPDATE competition.tournaments
      SET roster_sync_status = 'processing',
          roster_sync_error = NULL,
          updated_at = now()
      WHERE season_id = ${season.seasonId}
        AND tournament_id = ${tournamentId}
        AND state <> 'finished'
        AND (
          (${expectedMarker}::timestamptz IS NULL AND setup_progress_updated_at IS NULL)
          OR setup_progress_updated_at::text = ${expectedMarker}
        )
      RETURNING tournament_id AS "tournamentId"
    `;
    return rows.length === 1;
  },

  markSyncFailed: async (
    season: FplSeasonRef,
    tournamentId: number,
    internalError: string,
  ): Promise<void> => {
    const client = await getDbClient();
    await client`
      UPDATE competition.tournaments
      SET roster_sync_status = 'failed',
          roster_sync_error = ${internalError},
          updated_at = now()
      WHERE season_id = ${season.seasonId} AND tournament_id = ${tournamentId}
    `;
  },

  markSyncReady: async (
    season: FplSeasonRef,
    tournamentId: number,
    sourceLeagueName: string | null,
  ): Promise<void> => {
    const client = await getDbClient();
    await client`
      UPDATE competition.tournaments
      SET roster_sync_status = 'ready',
          roster_sync_error = NULL,
          roster_last_synced_at = now(),
          source_league_name = coalesce(${sourceLeagueName}, source_league_name),
          updated_at = now()
      WHERE season_id = ${season.seasonId} AND tournament_id = ${tournamentId}
    `;
  },

  markSyncCanceled: async (season: FplSeasonRef, tournamentId: number): Promise<void> => {
    const client = await getDbClient();
    await client`
      UPDATE competition.tournaments
      SET roster_sync_status = 'ready',
          roster_sync_error = NULL,
          setup_status = CASE
            WHEN roster_sync_status = 'processing' AND setup_status = 'pending'
              THEN 'ready'::competition.tournament_setup_status
            ELSE setup_status
          END,
          setup_phase = CASE
            WHEN roster_sync_status = 'processing' AND setup_status = 'pending'
              THEN 'ready'::competition.tournament_setup_phase
            ELSE setup_phase
          END,
          updated_at = now()
      WHERE season_id = ${season.seasonId}
        AND tournament_id = ${tournamentId}
        AND state IN ('inactive', 'finished')
        AND roster_sync_status IN ('pending', 'processing')
    `;
  },

  markResumeProcessing: async (season: FplSeasonRef, tournamentId: number): Promise<void> => {
    await tournamentRosterRepository.markResumeProcessingWithMarker(season, tournamentId);
  },

  markResumeProcessingWithMarker: async (
    season: FplSeasonRef,
    tournamentId: number,
  ): Promise<string> => {
    const client = await getDbClient();
    const rows = await client<{ marker: string }[]>`
      UPDATE competition.tournaments
      SET roster_sync_status = 'processing',
          roster_sync_error = NULL,
          setup_status = 'pending',
          setup_phase = 'queued',
          setup_error = NULL,
          setup_warning_count = 0,
          setup_completed_units = 0,
          setup_total_units = 0,
          setup_attempt = 0,
          setup_next_retry_at = NULL,
          setup_last_error_code = NULL,
          setup_last_error_at = NULL,
          setup_progress_indeterminate = false,
          setup_progress_updated_at = now(),
          standings_ready_at = NULL,
          profiles_ready_at = NULL,
          insights_ready_at = NULL,
          updated_at = now()
      WHERE season_id = ${season.seasonId}
        AND tournament_id = ${tournamentId}
        AND state = 'inactive'
      RETURNING setup_progress_updated_at::text AS marker
    `;
    if (rows.length !== 1 || !rows[0]?.marker) {
      throw new DatabaseError('Tournament resume marker was not written.', 'TOURNAMENT_NOT_FOUND');
    }
    return rows[0].marker;
  },

  markResumeProcessingIfPending: async (
    season: FplSeasonRef,
    tournamentId: number,
    marker?: string,
  ): Promise<boolean> => {
    const client = await getDbClient();
    const rows = await client<{ tournamentId: number }[]>`
      UPDATE competition.tournaments
      SET roster_sync_status = 'processing',
          roster_sync_error = NULL,
          setup_status = 'pending',
          setup_phase = 'queued',
          setup_error = NULL,
          setup_warning_count = 0,
          setup_completed_units = 0,
          setup_total_units = 0,
          setup_attempt = 0,
          setup_next_retry_at = NULL,
          setup_last_error_code = NULL,
          setup_last_error_at = NULL,
          setup_progress_indeterminate = false,
          standings_ready_at = NULL,
          profiles_ready_at = NULL,
          insights_ready_at = NULL,
          updated_at = now()
      WHERE season_id = ${season.seasonId}
        AND tournament_id = ${tournamentId}
        AND (
          (
            state = 'inactive'
            AND roster_sync_status IN ('processing', 'failed')
            AND setup_status IN ('pending', 'processing', 'failed')
            AND (
              setup_phase IN ('queued', 'failed')
              OR setup_status = 'processing'
            )
          )
          OR (
            -- The setup worker may die after the roster transition commits
            -- but before setup_status becomes ready. The same resume marker
            -- is still authoritative and may replay the setup to settle it.
            state = 'active'
            AND roster_sync_status = 'ready'
            AND setup_status = 'processing'
          )
        )
        ${marker ? client`AND setup_progress_updated_at::text = ${marker}` : client``}
      RETURNING tournament_id AS "tournamentId"
    `;
    return rows.length === 1;
  },

  publishAuthoritativeRoster: async (
    season: FplSeasonRef,
    tournament: TournamentRosterRecord,
    participants: TournamentParticipant[],
    sourceLeagueName: string | null,
    options?: {
      allowInactive?: boolean;
      resumeAfterSetup?: boolean;
      resumeMarker?: string;
      expectedProgressMarker?: string | null;
    },
  ): Promise<RosterPublicationResult> => {
    try {
      const participantIds = uniqueParticipantIds(participants);
      const sortedParticipantIds = [...participantIds].sort((left, right) => left - right);
      const client = await getDbClient();
      return await client.begin(async (tx) => {
        const seasonRows = await tx<Array<{ isCurrent: boolean }>>`
          SELECT is_current AS "isCurrent"
          FROM fpl.seasons
          WHERE season_id = ${season.seasonId}
          FOR KEY SHARE
        `;
        if (seasonRows[0]?.isCurrent !== true) {
          throw new Error(`FPL season ${season.seasonCode} is no longer current`);
        }

        const locked = await tx<
          Array<{
            id: number;
            state: 'active' | 'inactive' | 'finished';
            rosterMode: TournamentRosterMode;
            rosterSyncStatus: 'pending' | 'processing' | 'ready' | 'failed' | null;
            totalTeamNum: number;
          }>
        >`
          SELECT
            tournament_id AS id,
            state,
            roster_mode AS "rosterMode",
            roster_sync_status AS "rosterSyncStatus",
            total_team_num AS "totalTeamNum"
          FROM competition.tournaments
          WHERE season_id = ${season.seasonId}
            AND tournament_id = ${tournament.id}
          FOR UPDATE
        `;
        const current = locked[0];
        if (!current) {
          return { changed: false, participantCount: 0, automaticallyPaused: false, skipped: true };
        }
        if (options?.resumeAfterSetup && current.rosterSyncStatus !== 'processing') {
          return {
            changed: false,
            participantCount: current.totalTeamNum,
            automaticallyPaused: false,
            skipped: true,
          };
        }
        if (
          current.rosterMode !== 'official_sync' ||
          current.state === 'finished' ||
          (current.state === 'inactive' && !options?.allowInactive)
        ) {
          await tx`
            UPDATE competition.tournaments
            SET roster_sync_status = CASE
                  WHEN roster_mode = 'official_sync'
                    THEN 'ready'::competition.tournament_setup_status
                  ELSE NULL
                END,
                roster_sync_error = NULL,
                updated_at = now()
            WHERE season_id = ${season.seasonId}
              AND tournament_id = ${tournament.id}
          `;
          return {
            changed: false,
            participantCount: current.totalTeamNum,
            automaticallyPaused: false,
            skipped: true,
          };
        }

        const existingRows = await tx<Array<{ entryId: number }>>`
          SELECT entry_id AS "entryId"
          FROM competition.tournament_entries
          WHERE season_id = ${season.seasonId}
            AND tournament_id = ${tournament.id}
          ORDER BY entry_id
        `;
        const existingIds = existingRows.map((row) => Number(row.entryId));
        const changed =
          existingIds.length !== sortedParticipantIds.length ||
          existingIds.some((entryId, index) => entryId !== sortedParticipantIds[index]);

        if (!changed) {
          await tx`
            UPDATE competition.tournaments
            SET roster_sync_status = ${options?.resumeAfterSetup ? 'processing' : 'ready'},
                roster_sync_error = NULL,
                roster_last_synced_at = now(),
                setup_progress_updated_at = CASE
                  WHEN ${options?.expectedProgressMarker !== undefined}
                    THEN ${options?.expectedProgressMarker ?? null}::timestamptz
                  WHEN ${options?.resumeAfterSetup ? false : true} THEN now()
                  ELSE setup_progress_updated_at
                END,
                source_league_name = coalesce(${sourceLeagueName}, source_league_name),
                updated_at = now()
            WHERE season_id = ${season.seasonId}
              AND tournament_id = ${tournament.id}
          `;
          return {
            changed: false,
            participantCount: participantIds.length,
            automaticallyPaused: false,
            skipped: false,
          };
        }

        if (participants.length > 0) {
          const participantPayload = JSON.stringify(
            participants.map((participant) => ({
              entry_id: Number(participant.id),
              entry_name: participant.team,
              player_name: participant.manager,
              overall_rank: participant.overallRank || null,
              overall_points: participant.totalPoints || 0,
            })),
          );
          await tx`
            INSERT INTO competition.entries (
              season_id, entry_id, entry_name, player_name, overall_rank, overall_points
            )
            SELECT
              ${season.seasonId}, source.entry_id, source.entry_name, source.player_name,
              source.overall_rank, source.overall_points
            FROM jsonb_to_recordset(${participantPayload}::jsonb) AS source(
              entry_id int,
              entry_name text,
              player_name text,
              overall_rank int,
              overall_points int
            )
            ON CONFLICT (season_id, entry_id) DO NOTHING
          `;
        }

        await tx`
          DELETE FROM competition.tournament_knockout_results
          WHERE season_id = ${season.seasonId} AND tournament_id = ${tournament.id}
        `;
        await tx`
          DELETE FROM competition.tournament_knockouts
          WHERE season_id = ${season.seasonId} AND tournament_id = ${tournament.id}
        `;
        await tx`
          DELETE FROM competition.tournament_battle_group_results
          WHERE season_id = ${season.seasonId} AND tournament_id = ${tournament.id}
        `;
        await tx`
          DELETE FROM competition.tournament_points_group_results
          WHERE season_id = ${season.seasonId} AND tournament_id = ${tournament.id}
        `;
        await tx`
          DELETE FROM competition.tournament_groups
          WHERE season_id = ${season.seasonId} AND tournament_id = ${tournament.id}
        `;
        await tx`
          DELETE FROM competition.tournament_entries
          WHERE season_id = ${season.seasonId} AND tournament_id = ${tournament.id}
        `;

        if (participantIds.length > 0) {
          await tx`
            INSERT INTO competition.tournament_entries (
              tournament_id, season_id, league_id, entry_id
            )
            SELECT ${tournament.id}, ${season.seasonId}, ${tournament.leagueId}, entry_id
            FROM unnest(${participantIds}::int[]) AS entry_id
          `;
        }

        const automaticallyPaused = participants.length < 2;
        await tx`
          UPDATE competition.tournaments
          SET total_team_num = ${participants.length},
              group_team_num = ${participants.length},
              source_league_name = coalesce(${sourceLeagueName}, source_league_name),
              roster_sync_status = ${
                automaticallyPaused ? 'failed' : options?.resumeAfterSetup ? 'processing' : 'ready'
              },
              roster_sync_error = ${
                automaticallyPaused ? 'Official league has fewer than two participants.' : null
              },
              roster_last_synced_at = now(),
              state = ${automaticallyPaused ? 'inactive' : current.state},
              setup_status = ${automaticallyPaused ? 'failed' : 'pending'},
              setup_phase = ${automaticallyPaused ? 'failed' : 'queued'},
              setup_error = NULL,
              setup_warning_count = 0,
              setup_completed_units = 0,
              setup_total_units = 0,
              setup_attempt = 0,
              setup_next_retry_at = NULL,
              setup_last_error_code = NULL,
              setup_last_error_at = NULL,
              setup_progress_indeterminate = false,
              setup_progress_updated_at = CASE
                WHEN ${options?.resumeAfterSetup ? Boolean(options.resumeMarker) : false}
                  THEN ${options?.resumeMarker ?? null}::timestamptz
                WHEN ${options?.expectedProgressMarker !== undefined}
                  THEN ${options?.expectedProgressMarker ?? null}::timestamptz
                ELSE now()
              END,
              standings_ready_at = NULL,
              profiles_ready_at = NULL,
              insights_ready_at = NULL,
              updated_at = now()
          WHERE season_id = ${season.seasonId}
            AND tournament_id = ${tournament.id}
        `;

        return {
          changed: true,
          participantCount: participants.length,
          automaticallyPaused,
          skipped: false,
        };
      });
    } catch (error) {
      logError('Failed to publish authoritative tournament roster', error, {
        season: season.seasonCode,
        tournamentId: tournament.id,
      });
      throw new DatabaseError(
        'Failed to publish tournament roster.',
        'TOURNAMENT_ROSTER_PUBLISH_ERROR',
        error instanceof Error ? error : undefined,
      );
    }
  },

  markReadyAndResume: async (season: FplSeasonRef, tournamentId: number): Promise<void> => {
    const client = await getDbClient();
    await client`
      UPDATE competition.tournaments
      SET state = CASE
            WHEN state = 'finished' THEN state
            WHEN total_team_num >= 2 THEN 'active'::competition.tournament_state
            ELSE state
          END,
          roster_sync_status = CASE
            WHEN state = 'finished' OR total_team_num >= 2
              THEN 'ready'::competition.tournament_setup_status
            ELSE 'failed'::competition.tournament_setup_status
          END,
          roster_sync_error = CASE
            WHEN state = 'finished' OR total_team_num >= 2 THEN NULL
            ELSE 'Tournament requires at least two participants.'
          END,
          roster_last_synced_at = CASE
            WHEN state = 'finished' OR total_team_num >= 2
              THEN coalesce(roster_last_synced_at, now())
            ELSE roster_last_synced_at
          END,
          updated_at = now()
      WHERE season_id = ${season.seasonId}
        AND tournament_id = ${tournamentId}
        AND roster_sync_status = 'processing'
    `;
  },

  finishThroughEvent: async (
    season: FplSeasonRef,
    eventId: number,
    targets: TournamentFinalizationTarget[],
  ): Promise<number> => {
    const eligibleTargets = [
      ...new Map(
        targets
          .filter(
            (target) =>
              target.tournamentId > 0 &&
              Number.isFinite(Date.parse(target.standingsReadyAt)) &&
              Number.isFinite(Date.parse(target.resultsFreshAfter ?? '')),
          )
          .map((target) => [target.tournamentId, target]),
      ).values(),
    ];
    if (eligibleTargets.length === 0) {
      logInfo('No cascade-owned tournaments eligible for finish', { eventId });
      return 0;
    }
    const targetPayload = JSON.stringify(
      eligibleTargets.map((target) => ({
        tournament_id: target.tournamentId,
        standings_ready_at: target.standingsReadyAt,
        results_fresh_after: target.resultsFreshAfter,
      })),
    );
    const client = await getDbClient();
    const rows = await client<Array<{ id: number }>>`
      UPDATE competition.tournaments AS tournament
      SET state = 'finished', updated_at = now()
      FROM jsonb_to_recordset(${targetPayload}::jsonb) AS target(
        tournament_id int,
        standings_ready_at timestamptz,
        results_fresh_after timestamptz
      )
      WHERE tournament.season_id = ${season.seasonId}
        AND tournament.tournament_id = target.tournament_id
        AND tournament.standings_ready_at = target.standings_ready_at
        AND tournament.state = 'active'
        AND tournament.setup_status = 'ready'
        AND EXISTS (
          SELECT 1
          FROM fpl.events terminal_event
          WHERE terminal_event.season_id = tournament.season_id
            AND terminal_event.event_id = ${eventId}
            AND terminal_event.finished = true
            AND terminal_event.data_checked = true
            AND terminal_event.data_checked_at <= target.results_fresh_after
        )
        AND greatest(
          coalesce(tournament.group_ended_event_id, 0),
          coalesce(tournament.knockout_ended_event_id, 0)
        ) = ${eventId}
        AND (
          (
            tournament.knockout_mode <> 'no_knockout'
            AND coalesce(tournament.knockout_ended_event_id, 0)
              >= coalesce(tournament.group_ended_event_id, 0)
            AND EXISTS (
              SELECT 1
              FROM competition.tournament_knockout_results result
              WHERE result.season_id = tournament.season_id
                AND result.tournament_id = tournament.tournament_id
                AND result.event_id = tournament.knockout_ended_event_id
            )
            AND (
              tournament.league_type <> 'h2h'
              OR tournament.roster_mode <> 'official_sync'
              OR NOT EXISTS (
                SELECT 1
                FROM competition.tournament_knockout_results result
                WHERE result.season_id = tournament.season_id
                  AND result.tournament_id = tournament.tournament_id
                  AND result.event_id = tournament.knockout_ended_event_id
                  AND result.official_match_id IS NOT NULL
                  AND (result.home_net_points IS NULL OR result.away_net_points IS NULL)
              )
            )
          ) OR (
            (
              tournament.knockout_mode = 'no_knockout'
              OR coalesce(tournament.group_ended_event_id, 0)
                > coalesce(tournament.knockout_ended_event_id, 0)
            )
            AND tournament.group_mode = 'points_races'
            AND EXISTS (
              SELECT 1
              FROM competition.tournament_points_group_results result
              WHERE result.season_id = tournament.season_id
                AND result.tournament_id = tournament.tournament_id
                AND result.event_id = tournament.group_ended_event_id
            )
          ) OR (
            (
              tournament.knockout_mode = 'no_knockout'
              OR coalesce(tournament.group_ended_event_id, 0)
                > coalesce(tournament.knockout_ended_event_id, 0)
            )
            AND tournament.group_mode = 'battle_races'
            AND EXISTS (
              SELECT 1
              FROM competition.tournament_battle_group_results result
              WHERE result.season_id = tournament.season_id
                AND result.tournament_id = tournament.tournament_id
                AND result.event_id = tournament.group_ended_event_id
            )
            AND (
              tournament.league_type <> 'h2h'
              OR tournament.roster_mode <> 'official_sync'
              OR NOT EXISTS (
                SELECT 1
                FROM competition.tournament_battle_group_results result
                WHERE result.season_id = tournament.season_id
                  AND result.tournament_id = tournament.tournament_id
                  AND result.event_id = tournament.group_ended_event_id
                  AND result.official_match_id IS NOT NULL
                  AND (result.home_net_points IS NULL OR result.away_net_points IS NULL)
              )
            )
          )
        )
      RETURNING tournament.tournament_id AS id
    `;
    logInfo('Marked cascade-owned completed tournaments finished', {
      season: season.seasonCode,
      eventId,
      eligibleTournamentCount: eligibleTargets.length,
      count: rows.length,
    });
    return rows.length;
  },
};
