import { autoIncrementId } from '@app/schemas/_helpers.schema';
import { char, index, integer, pgTable, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

export const playerValueTracks = pgTable(
  'player_value_tracks',
  {
    ...autoIncrementId,
    hourIndex: integer('hour_index').notNull(),
    date: char('date', { length: 8 }).notNull(),
    eventId: integer('event_id').notNull(),
    elementId: integer('element_id').notNull(),
    elementType: integer('element_type').notNull(),
    teamId: integer('team_id').notNull(),
    chanceOfPlayingThisRound: integer('chance_of_playing_this_round'),
    chanceOfPlayingNextRound: integer('chance_of_playing_next_round'),
    transfersIn: integer('transfers_in').notNull(),
    transfersOut: integer('transfers_out').notNull(),
    transfersInEvent: integer('transfers_in_event').notNull(),
    transfersOutEvent: integer('transfers_out_event').notNull(),
    selectedBy: integer('selected_by').notNull(),
    value: integer('value').default(0).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('unique_player_value_track').on(table.elementId, table.date, table.hourIndex),
    index('idx_player_value_track_date_hour_index').on(table.date, table.hourIndex),
    index('idx_player_value_track_element_id').on(table.elementId),
    index('idx_player_value_track_event_id').on(table.eventId),
  ],
);

export type PlayerValueTrack = Readonly<typeof playerValueTracks.$inferSelect>;
export type PlayerValueTracks = readonly PlayerValueTrack[];

export type PlayerValueTrackCreateInput = Readonly<typeof playerValueTracks.$inferInsert>;
export type PlayerValueTrackCreateInputs = readonly PlayerValueTrackCreateInput[];
