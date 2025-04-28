import { pgTable, integer, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { autoIncrementId, createdAtField } from 'schema/_helpers';
import { events } from 'schema/event';
import { players } from 'schema/player';

export const eventLiveExplains = pgTable(
  'event_live_explains',
  {
    ...autoIncrementId,
    eventId: integer('event_id')
      .notNull()
      .references(() => events.id),
    elementId: integer('element_id')
      .notNull()
      .references(() => players.id),
    bonus: integer('bonus'),
    minutes: integer('minutes'),
    minutesPoints: integer('minutes_points'),
    goalsScored: integer('goals_scored'),
    goalsScoredPoints: integer('goals_scored_points'),
    assists: integer('assists'),
    assistsPoints: integer('assists_points'),
    cleanSheets: integer('clean_sheets'),
    cleanSheetsPoints: integer('clean_sheets_points'),
    goalsConceded: integer('goals_conceded'),
    goalsConcededPoints: integer('goals_conceded_points'),
    ownGoals: integer('own_goals'),
    ownGoalsPoints: integer('own_goals_points'),
    penaltiesSaved: integer('penalties_saved'),
    penaltiesSavedPoints: integer('penalties_saved_points'),
    penaltiesMissed: integer('penalties_missed'),
    penaltiesMissedPoints: integer('penalties_missed_points'),
    yellowCards: integer('yellow_cards'),
    yellowCardsPoints: integer('yellow_cards_points'),
    redCards: integer('red_cards'),
    redCardsPoints: integer('red_cards_points'),
    saves: integer('saves'),
    savesPoints: integer('saves_points'),
    mngWin: integer('mng_win'),
    mngWinPoints: integer('mng_win_points'),
    mngDraw: integer('mng_draw'),
    mngDrawPoints: integer('mng_draw_points'),
    mngLoss: integer('mng_loss'),
    mngLossPoints: integer('mng_loss_points'),
    mngUnderdogWin: integer('mng_underdog_win'),
    mngUnderdogWinPoints: integer('mng_underdog_win_points'),
    mngUnderdogDraw: integer('mng_underdog_draw'),
    mngUnderdogDrawPoints: integer('mng_underdog_draw_points'),
    mngCleanSheets: integer('mng_clean_sheets'),
    mngCleanSheetsPoints: integer('mng_clean_sheets_points'),
    mngGoalsScored: integer('mng_goals_scored'),
    mngGoalsScoredPoints: integer('mng_goals_scored_points'),
    ...createdAtField,
  },
  (table) => [
    uniqueIndex('unique_event_element_live_explain').on(table.elementId, table.eventId),
    index('idx_event_live_explain_element_id').on(table.elementId),
    index('idx_event_live_explain_event_id').on(table.eventId),
  ],
);
