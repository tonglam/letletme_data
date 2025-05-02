import { autoIncrementId, timestamps } from '@app/schemas/_helpers.schema';
import { entryInfos } from '@app/schemas/entry-info.schema';
import { events } from '@app/schemas/event.schema';
import { tournamentInfos } from '@app/schemas/tournament-info.schema';
import { index, integer, pgTable, uniqueIndex } from 'drizzle-orm/pg-core';

export const tournamentKnockoutResults = pgTable(
  'tournament_knockout_results',
  {
    ...autoIncrementId,
    tournamentId: integer('tournament_id')
      .notNull()
      .references(() => tournamentInfos.id),
    eventId: integer('event_id')
      .notNull()
      .references(() => events.id),
    matchId: integer('match_id').notNull(),
    playAgainstId: integer('play_against_id').notNull(),
    homeEntryId: integer('home_entry_id').references(() => entryInfos.id),
    homeNetPoints: integer('home_net_points'),
    homeGoalsScored: integer('home_goals_scored'),
    homeGoalsConceded: integer('home_goals_conceded'),
    awayEntryId: integer('away_entry_id').references(() => entryInfos.id),
    awayNetPoints: integer('away_net_points'),
    awayGoalsScored: integer('away_goals_scored'),
    awayGoalsConceded: integer('away_goals_conceded'),
    matchWinner: integer('match_winner').references(() => entryInfos.id),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('unique_tournament_knockout_result').on(
      table.tournamentId,
      table.eventId,
      table.matchId,
      table.playAgainstId,
    ),
    index('idx_tournament_knockout_result_tournament_id').on(table.tournamentId),
    index('idx_tournament_knockout_result_event_id').on(table.eventId),
    index('idx_tournament_knockout_result_match_id').on(table.matchId),
    index('idx_tournament_knockout_result_play_against_id').on(table.playAgainstId),
  ],
);

export type DbTournamentKnockoutResult = Readonly<typeof tournamentKnockoutResults.$inferSelect>;
export type DbTournamentKnockoutResults = readonly DbTournamentKnockoutResult[];

export type DbTournamentKnockoutResultInsert = Readonly<
  typeof tournamentKnockoutResults.$inferInsert
>;
export type DbTournamentKnockoutResultInserts = readonly DbTournamentKnockoutResultInsert[];
