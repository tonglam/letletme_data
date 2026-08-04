import { getDbClient } from '../db/singleton';
import type {
  LeagueType,
  TournamentConfig,
  TournamentParticipant,
  TournamentRosterMode,
} from '../domain/tournament';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

export type TournamentRosterRecord = TournamentConfig & {
  adminEntryId: number;
  leagueId: number;
  leagueType: LeagueType;
  rosterMode: TournamentRosterMode;
  state: 'active' | 'inactive' | 'finished';
  standingsReadyAt: string | null;
};

type RosterRow = {
  id: number;
  adminEntryId: number;
  leagueId: number;
  leagueType: LeagueType;
  rosterMode: TournamentRosterMode;
  state: 'active' | 'inactive' | 'finished';
  standingsReadyAt: string | null;
  totalTeamNum: number;
  groupMode: TournamentConfig['groupMode'];
  groupNum: number | null;
  groupStartedEventId: number | null;
  groupEndedEventId: number | null;
  groupQualifyNum: number | null;
  knockoutMode: TournamentConfig['knockoutMode'];
  knockoutTeamNum: number | null;
  knockoutEventNum: number | null;
  knockoutStartedEventId: number | null;
  knockoutEndedEventId: number | null;
  knockoutPlayAgainstNum: number | null;
};

const SELECT_ROSTER_RECORD = `
  id,
  admin_entry_id as "adminEntryId",
  league_id as "leagueId",
  league_type as "leagueType",
  roster_mode as "rosterMode",
  state,
  standings_ready_at::text as "standingsReadyAt",
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
`;

export type RosterPublicationResult = {
  changed: boolean;
  participantCount: number;
  automaticallyPaused: boolean;
  skipped: boolean;
};

export const tournamentRosterRepository = {
  findById: async (tournamentId: number): Promise<TournamentRosterRecord | null> => {
    try {
      const client = await getDbClient();
      const rows = await client.unsafe<RosterRow[]>(
        `select ${SELECT_ROSTER_RECORD} from tournament_infos where id = $1 limit 1`,
        [tournamentId],
      );
      return rows[0] ?? null;
    } catch (error) {
      logError('Failed to load tournament roster record', error, { tournamentId });
      throw new DatabaseError(
        'Failed to load tournament roster.',
        'TOURNAMENT_ROSTER_FIND_ERROR',
        error as Error,
      );
    }
  },

  findActiveOfficialSync: async (): Promise<TournamentRosterRecord[]> => {
    try {
      const client = await getDbClient();
      return await client.unsafe<RosterRow[]>(
        `select ${SELECT_ROSTER_RECORD}
         from tournament_infos
         where state = 'active' and roster_mode = 'official_sync'
         order by id`,
      );
    } catch (error) {
      logError('Failed to load official-sync tournaments', error);
      throw new DatabaseError(
        'Failed to load official-sync tournaments.',
        'TOURNAMENT_ROSTER_FIND_ACTIVE_ERROR',
        error as Error,
      );
    }
  },

  findEntryIds: async (tournamentId: number): Promise<number[]> => {
    try {
      const client = await getDbClient();
      const rows = await client<{ entryId: number }[]>`
        select entry_id as "entryId"
        from tournament_entries
        where tournament_id = ${tournamentId}
        order by entry_id
      `;
      return rows.map((row) => row.entryId);
    } catch (error) {
      logError('Failed to load tournament roster entry IDs', error, { tournamentId });
      throw new DatabaseError(
        'Failed to load tournament roster entries.',
        'TOURNAMENT_ROSTER_FIND_ENTRIES_ERROR',
        error as Error,
      );
    }
  },

  markSyncProcessing: async (tournamentId: number): Promise<void> => {
    const client = await getDbClient();
    await client`
      update tournament_infos
      set roster_sync_status = 'processing', roster_sync_error = null, updated_at = now()
      where id = ${tournamentId}
    `;
  },

  markSyncFailed: async (tournamentId: number, internalError: string): Promise<void> => {
    const client = await getDbClient();
    await client`
      update tournament_infos
      set roster_sync_status = 'failed',
          roster_sync_error = ${internalError},
          updated_at = now()
      where id = ${tournamentId}
    `;
  },

  markSyncReady: async (tournamentId: number, sourceLeagueName: string | null): Promise<void> => {
    const client = await getDbClient();
    await client`
      update tournament_infos
      set roster_sync_status = 'ready',
          roster_sync_error = null,
          roster_last_synced_at = now(),
          source_league_name = coalesce(${sourceLeagueName}, source_league_name),
          updated_at = now()
      where id = ${tournamentId}
    `;
  },

  markResumeProcessing: async (tournamentId: number): Promise<void> => {
    const client = await getDbClient();
    await client`
      update tournament_infos
      set roster_sync_status = 'processing',
          roster_sync_error = null,
          setup_status = 'pending',
          setup_phase = 'queued',
          setup_error = null,
          setup_warning_count = 0,
          setup_completed_units = 0,
          setup_total_units = 0,
          setup_progress_updated_at = now(),
          updated_at = now()
      where id = ${tournamentId} and state = 'inactive'
    `;
  },

  publishAuthoritativeRoster: async (
    tournament: TournamentRosterRecord,
    participants: TournamentParticipant[],
    sourceLeagueName: string | null,
    options?: { allowInactive?: boolean; resumeAfterSetup?: boolean },
  ): Promise<RosterPublicationResult> => {
    try {
      const participantIds = participants.map((participant) => Number(participant.id));
      const sortedParticipantIds = [...participantIds].sort((left, right) => left - right);
      const client = await getDbClient();
      return await client.begin(async (tx) => {
        const locked = await tx<
          {
            id: number;
            state: 'active' | 'inactive' | 'finished';
            rosterMode: TournamentRosterMode;
            rosterSyncStatus: 'pending' | 'processing' | 'ready' | 'failed' | null;
            totalTeamNum: number;
          }[]
        >`
          select
            id,
            state,
            roster_mode as "rosterMode",
            roster_sync_status as "rosterSyncStatus",
            total_team_num as "totalTeamNum"
          from tournament_infos
          where id = ${tournament.id}
          for update
        `;
        const current = locked[0];
        if (!current) {
          return {
            changed: false,
            participantCount: 0,
            automaticallyPaused: false,
            skipped: true,
          };
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
            update tournament_infos
            set roster_sync_status = case
                  when roster_mode = 'official_sync' then 'ready'::tournament_setup_status
                  else null
                end,
                roster_sync_error = null,
                updated_at = now()
            where id = ${tournament.id}
          `;
          return {
            changed: false,
            participantCount: current.totalTeamNum,
            automaticallyPaused: false,
            skipped: true,
          };
        }

        const existingRows = await tx<{ entryId: number }[]>`
          select entry_id as "entryId"
          from tournament_entries
          where tournament_id = ${tournament.id}
          order by entry_id
        `;
        const existingIds = existingRows.map((row) => row.entryId);
        const changed =
          existingIds.length !== sortedParticipantIds.length ||
          existingIds.some((entryId, index) => entryId !== sortedParticipantIds[index]);

        if (!changed) {
          await tx`
            update tournament_infos
            set roster_sync_status = ${options?.resumeAfterSetup ? 'processing' : 'ready'},
                roster_sync_error = null,
                roster_last_synced_at = now(),
                source_league_name = coalesce(${sourceLeagueName}, source_league_name),
                updated_at = now()
            where id = ${tournament.id}
          `;
          return {
            changed: false,
            participantCount: participantIds.length,
            automaticallyPaused: false,
            skipped: false,
          };
        }

        await tx`
          insert into entry_infos ${tx(
            participants.map((participant) => ({
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

        await tx`delete from tournament_selection_stats where tournament_id = ${tournament.id}`;
        await tx`delete from tournament_knockout_results where tournament_id = ${tournament.id}`;
        await tx`delete from tournament_knockouts where tournament_id = ${tournament.id}`;
        await tx`delete from tournament_battle_group_results where tournament_id = ${tournament.id}`;
        await tx`delete from tournament_points_group_results where tournament_id = ${tournament.id}`;
        await tx`delete from tournament_groups where tournament_id = ${tournament.id}`;
        await tx`delete from tournament_entries where tournament_id = ${tournament.id}`;

        if (participants.length > 0) {
          await tx`
            insert into tournament_entries ${tx(
              participantIds.map((entryId) => ({
                tournament_id: tournament.id,
                league_id: tournament.leagueId,
                entry_id: entryId,
              })),
              'tournament_id',
              'league_id',
              'entry_id',
            )}
          `;
        }

        const automaticallyPaused = participants.length < 2;
        await tx`
          update tournament_infos
          set total_team_num = ${participants.length},
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
              setup_error = null,
              setup_warning_count = 0,
              setup_completed_units = 0,
              setup_total_units = 0,
              setup_progress_updated_at = now(),
              standings_ready_at = null,
              updated_at = now()
          where id = ${tournament.id}
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
        tournamentId: tournament.id,
      });
      throw new DatabaseError(
        'Failed to publish tournament roster.',
        'TOURNAMENT_ROSTER_PUBLISH_ERROR',
        error as Error,
      );
    }
  },

  markReadyAndResume: async (tournamentId: number): Promise<void> => {
    const client = await getDbClient();
    await client`
      update tournament_infos
      set state = case when total_team_num >= 2 then 'active' else state end,
          roster_sync_status = case
            when total_team_num >= 2 then 'ready'::tournament_setup_status
            else 'failed'::tournament_setup_status
          end,
          roster_sync_error = case
            when total_team_num >= 2 then null
            else 'Tournament requires at least two participants.'
          end,
          roster_last_synced_at = case
            when total_team_num >= 2 then coalesce(roster_last_synced_at, now())
            else roster_last_synced_at
          end,
          updated_at = now()
      where id = ${tournamentId} and roster_sync_status = 'processing'
    `;
  },

  finishThroughEvent: async (eventId: number): Promise<number> => {
    const client = await getDbClient();
    const rows = await client<{ id: number }[]>`
      update tournament_infos
      set state = 'finished', updated_at = now()
      where state <> 'finished'
        and greatest(
          coalesce(group_ended_event_id, 0),
          coalesce(knockout_ended_event_id, 0)
        ) <= ${eventId}
      returning id
    `;
    logInfo('Marked completed tournaments finished', { eventId, count: rows.length });
    return rows.length;
  },
};
