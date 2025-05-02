import { autoIncrementId, timestamps } from '@app/schemas/_helpers.schema';
import { entryInfos } from '@app/schemas/entry-info.schema';
import { events } from '@app/schemas/event.schema';
import { tournamentInfos } from '@app/schemas/tournament-info.schema';
import { index, integer, pgTable, uniqueIndex } from 'drizzle-orm/pg-core';

export const tournamentKnockouts = pgTable(
  'tournament_knockouts',
  {
    ...autoIncrementId,
    tournamentId: integer('tournament_id')
      .notNull()
      .references(() => tournamentInfos.id),
    round: integer('round').notNull(),
    startedEventId: integer('started_event_id').references(() => events.id),
    endedEventId: integer('ended_event_id').references(() => events.id),
    matchId: integer('match_id').notNull(),
    nextMatchId: integer('next_match_id'),
    homeEntryId: integer('home_entry_id').references(() => entryInfos.id),
    homeNetPoints: integer('home_net_points'),
    homeGoalsScored: integer('home_goals_scored'),
    homeGoalsConceded: integer('home_goals_conceded'),
    homeWins: integer('home_wins'),
    awayEntryId: integer('away_entry_id').references(() => entryInfos.id),
    awayNetPoints: integer('away_net_points'),
    awayGoalsScored: integer('away_goals_scored'),
    awayGoalsConceded: integer('away_goals_conceded'),
    awayWins: integer('away_wins'),
    roundWinner: integer('round_winner').references(() => entryInfos.id),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('unique_tournament_knockout').on(table.tournamentId, table.matchId),
    index('idx_tournament_knockout_tournament_id').on(table.tournamentId),
  ],
);

export type TournamentKnockout = Readonly<typeof tournamentKnockouts.$inferSelect>;
export type TournamentKnockouts = readonly TournamentKnockout[];

export type TournamentKnockoutCreateInput = Readonly<typeof tournamentKnockouts.$inferInsert>;
export type TournamentKnockoutCreateInputs = readonly TournamentKnockoutCreateInput[];
