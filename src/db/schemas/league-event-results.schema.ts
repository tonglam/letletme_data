import { boolean, index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { autoIncrementId, timestamps } from './_helpers.schema';
import { chipEnum, leagueTypeEnum } from './enums.schema';
import { entryInfos } from './entry-infos.schema';
import { events } from './events.schema';
import { players } from './players.schema';

export const leagueEventResults = pgTable(
  'league_event_results',
  {
    ...autoIncrementId,
    leagueId: integer('league_id').notNull(),
    leagueType: leagueTypeEnum('league_type').notNull(),
    eventId: integer('event_id')
      .notNull()
      .references(() => events.id),
    entryId: integer('entry_id')
      .notNull()
      .references(() => entryInfos.id),
    entryName: text('entry_name'),
    playerName: text('player_name'),
    overallPoints: integer('overall_points').default(0).notNull(),
    overallRank: integer('overall_rank').default(0).notNull(),
    teamValue: integer('team_value'),
    bank: integer('bank'),
    eventPoints: integer('event_points').default(0).notNull(),
    eventTransfers: integer('event_transfers').default(0).notNull(),
    eventTransfersCost: integer('event_transfers_cost').default(0).notNull(),
    eventNetPoints: integer('event_net_points').default(0).notNull(),
    eventBenchPoints: integer('event_bench_points'),
    eventAutoSubPoints: integer('event_auto_sub_points'),
    eventRank: integer('event_rank'),
    eventChip: chipEnum('event_chip'),
    captainId: integer('captain_id').references(() => players.id),
    captainPoints: integer('captain_points'),
    captainBlank: boolean('captain_blank'),
    viceCaptainId: integer('vice_captain_id').references(() => players.id),
    viceCaptainPoints: integer('vice_captain_points'),
    viceCaptainBlank: boolean('vice_captain_blank'),
    playedCaptainId: integer('played_captain_id').references(() => players.id),
    highestScoreElementId: integer('highest_score_element_id').references(() => players.id),
    highestScorePoints: integer('highest_score_points'),
    highestScoreBlank: boolean('highest_score_blank'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('unique_league_event_result').on(
      table.leagueId,
      table.leagueType,
      table.eventId,
      table.entryId,
    ),
    index('idx_league_event_results_league_id').on(table.leagueId),
    index('idx_league_event_results_event_id').on(table.eventId),
    index('idx_league_event_results_entry_id').on(table.entryId),
  ],
);

export type DbLeagueEventResult = Readonly<typeof leagueEventResults.$inferSelect>;
export type DbLeagueEventResults = readonly DbLeagueEventResult[];

export type DbLeagueEventResultInsert = Readonly<typeof leagueEventResults.$inferInsert>;
export type DbLeagueEventResultInserts = readonly DbLeagueEventResultInsert[];
