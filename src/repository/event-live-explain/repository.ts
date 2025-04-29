import { db } from 'db/index';
import { and, eq, sql } from 'drizzle-orm';
import { pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import { Option } from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import {
  mapDomainEventLiveExplainToDbCreate,
  mapDbEventLiveExplainToDomain,
} from 'repository/event-live-explain/mapper';
import {
  EventLiveExplainCreateInputs,
  EventLiveExplainRepository,
} from 'repository/event-live-explain/types';
import * as schema from 'schema/event-live-explain';
import { EventLiveExplains, EventLiveExplain } from 'types/domain/event-live-explain.type';
import { EventId } from 'types/domain/event.type';
import { PlayerId } from 'types/domain/player.type';
import { createDBError, DBError, DBErrorCode } from 'types/error.type';
import { getErrorMessage } from 'utils/error.util';

export const createEventLiveExplainRepository = (): EventLiveExplainRepository => {
  const findByElementIdAndEventId = (
    elementId: PlayerId,
    eventId: EventId,
  ): TE.TaskEither<DBError, Option<EventLiveExplain>> =>
    pipe(
      TE.tryCatch(
        async () => {
          const result = await db
            .select()
            .from(schema.eventLiveExplains)
            .where(
              and(
                eq(schema.eventLiveExplains.eventId, Number(eventId)),
                eq(schema.eventLiveExplains.elementId, Number(elementId)),
              ),
            )
            .limit(1);
          return result[0] ? O.some(mapDbEventLiveExplainToDomain(result[0])) : O.none;
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch event live explain by element id ${elementId} and event id ${eventId}: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
    );

  const findByEventId = (eventId: EventId): TE.TaskEither<DBError, EventLiveExplains> =>
    pipe(
      TE.tryCatch(
        async () => {
          const result = await db
            .select()
            .from(schema.eventLiveExplains)
            .where(eq(schema.eventLiveExplains.eventId, Number(eventId)));
          return result.map(mapDbEventLiveExplainToDomain);
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to fetch event live explains by event id ${eventId}: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
    );

  const saveBatchByEventId = (
    eventLiveExplainInputs: EventLiveExplainCreateInputs,
  ): TE.TaskEither<DBError, void> => {
    if (eventLiveExplainInputs.length === 0) {
      return TE.right(undefined);
    }

    return pipe(
      TE.tryCatch(
        async () => {
          const dataToCreate = eventLiveExplainInputs.map(mapDomainEventLiveExplainToDbCreate);
          await db
            .insert(schema.eventLiveExplains)
            .values(dataToCreate)
            .onConflictDoUpdate({
              target: [schema.eventLiveExplains.eventId, schema.eventLiveExplains.elementId],
              set: {
                bonus: sql`excluded.bonus`,
                minutes: sql`excluded.minutes`,
                minutesPoints: sql`excluded.minutes_points`,
                goalsScored: sql`excluded.goals_scored`,
                goalsScoredPoints: sql`excluded.goals_scored_points`,
                assists: sql`excluded.assists`,
                assistsPoints: sql`excluded.assists_points`,
                cleanSheets: sql`excluded.clean_sheets`,
                cleanSheetsPoints: sql`excluded.clean_sheets_points`,
                goalsConceded: sql`excluded.goals_conceded`,
                goalsConcededPoints: sql`excluded.goals_conceded_points`,
                ownGoals: sql`excluded.own_goals`,
                ownGoalsPoints: sql`excluded.own_goals_points`,
                penaltiesSaved: sql`excluded.penalties_saved`,
                penaltiesSavedPoints: sql`excluded.penalties_saved_points`,
                penaltiesMissed: sql`excluded.penalties_missed`,
                penaltiesMissedPoints: sql`excluded.penalties_missed_points`,
                yellowCards: sql`excluded.yellow_cards`,
                yellowCardsPoints: sql`excluded.yellow_cards_points`,
                redCards: sql`excluded.red_cards`,
                redCardsPoints: sql`excluded.red_cards_points`,
                saves: sql`excluded.saves`,
                savesPoints: sql`excluded.saves_points`,
                mngWin: sql`excluded.mng_win`,
                mngWinPoints: sql`excluded.mng_win_points`,
                mngDraw: sql`excluded.mng_draw`,
                mngDrawPoints: sql`excluded.mng_draw_points`,
                mngLoss: sql`excluded.mng_loss`,
                mngLossPoints: sql`excluded.mng_loss_points`,
                mngUnderdogWin: sql`excluded.mng_underdog_win`,
                mngUnderdogWinPoints: sql`excluded.mng_underdog_win_points`,
                mngUnderdogDraw: sql`excluded.mng_underdog_draw`,
                mngUnderdogDrawPoints: sql`excluded.mng_underdog_draw_points`,
                mngCleanSheets: sql`excluded.mng_clean_sheets`,
                mngCleanSheetsPoints: sql`excluded.mng_clean_sheets_points`,
                mngGoalsScored: sql`excluded.mng_goals_scored`,
                mngGoalsScoredPoints: sql`excluded.mng_goals_scored_points`,
              },
            });
          return undefined;
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to create event live explain in batch: ${error}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
    );
  };

  const deleteByEventId = (eventId: EventId): TE.TaskEither<DBError, void> =>
    pipe(
      TE.tryCatch(
        async () => {
          await db
            .delete(schema.eventLiveExplains)
            .where(eq(schema.eventLiveExplains.eventId, Number(eventId)));
        },
        (error) =>
          createDBError({
            code: DBErrorCode.QUERY_ERROR,
            message: `Failed to delete event live explain by event id ${eventId}: ${getErrorMessage(error)}`,
            cause: error instanceof Error ? error : undefined,
          }),
      ),
    );

  return {
    findByElementIdAndEventId,
    findByEventId,
    saveBatchByEventId,
    deleteByEventId,
  };
};
