import { index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { autoIncrementId, timestamps } from './_helpers.schema';
import { cupResultEnum } from './enums.schema';
import { entryInfos } from './entry-infos.schema';
import { events } from './events.schema';

export const entryEventCupResults = pgTable(
  'entry_event_cup_results',
  {
    ...autoIncrementId,
    eventId: integer('event_id')
      .notNull()
      .references(() => events.id),
    entryId: integer('entry_id')
      .notNull()
      .references(() => entryInfos.id),
    entryName: text('entry_name'),
    playerName: text('player_name'),
    eventPoints: integer('event_points'),
    againstEntryId: integer('against_entry_id'),
    againstEntryName: text('against_entry_name'),
    againstPlayerName: text('against_player_name'),
    againstEventPoints: integer('against_event_points'),
    result: cupResultEnum('result'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('unique_entry_event_cup_result').on(table.entryId, table.eventId),
    index('idx_entry_event_cup_results_event_id').on(table.eventId),
    index('idx_entry_event_cup_results_entry_id').on(table.entryId),
  ],
);

export type DbEntryEventCupResult = Readonly<typeof entryEventCupResults.$inferSelect>;
export type DbEntryEventCupResults = readonly DbEntryEventCupResult[];

export type DbEntryEventCupResultInsert = Readonly<typeof entryEventCupResults.$inferInsert>;
export type DbEntryEventCupResultInserts = readonly DbEntryEventCupResultInsert[];
