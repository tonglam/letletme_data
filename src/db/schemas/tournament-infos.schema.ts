import { boolean, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import {
  groupModeEnum,
  knockoutModeEnum,
  leagueTypeEnum,
  tournamentModeEnum,
  tournamentStateEnum,
} from 'enums.schema';
import { autoIncrementId, timestamps } from './_helpers.schema';
import { events } from './events.schema';

export const tournamentInfos = pgTable(
  'tournament_infos',
  {
    ...autoIncrementId,
    name: text('name').notNull(),
    creator: text('creator').notNull(),
    adminEntryId: integer('admin_entry_id').notNull(),
    leagueId: integer('league_id').notNull(),
    leagueType: leagueTypeEnum('league_type').notNull(),
    totalTeamNum: integer('total_team_num').notNull(),
    tournamentMode: tournamentModeEnum('tournament_mode').notNull(),
    groupMode: groupModeEnum('group_mode').notNull(),
    groupTeamNum: integer('group_team_num'),
    groupNum: integer('group_num'),
    groupStartedEventId: integer('group_started_event_id').references(() => events.id),
    groupEndedEventId: integer('group_ended_event_id').references(() => events.id),
    groupAutoAverages: boolean('group_auto_averages'),
    groupRounds: integer('group_rounds'),
    groupPlayAgainstNum: integer('group_play_against_num'),
    groupQualifyNum: integer('group_qualify_num'),
    knockoutMode: knockoutModeEnum('knockout_mode').notNull(),
    knockoutTeamNum: integer('knockout_team_num'),
    knockoutRounds: integer('knockout_rounds'),
    knockoutEventNum: integer('knockout_event_num'),
    knockoutStartedEventId: integer('knockout_started_event_id').references(() => events.id),
    knockoutEndedEventId: integer('knockout_ended_event_id').references(() => events.id),
    knockoutPlayAgainstNum: integer('knockout_play_against_num'),
    state: tournamentStateEnum('state').notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('unique_tournament_name').on(table.name),
    index('idx_tournament_info_league_id').on(table.leagueId),
  ],
);

export type DbTournamentInfo = Readonly<typeof tournamentInfos.$inferSelect>;
export type DbTournamentInfos = readonly DbTournamentInfo[];

export type DbTournamentInfoInsert = Readonly<typeof tournamentInfos.$inferInsert>;
export type DbTournamentInfosInserts = readonly DbTournamentInfoInsert[];
