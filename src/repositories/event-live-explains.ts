import { and, eq } from 'drizzle-orm';

import {
  playerGameweekScoringItemsInFpl,
  type DbEventLiveExplain,
  type DbEventLiveExplainInsert,
} from '../db/schemas/index.schema';
import { getDb, type DbOrTransaction } from '../db/singleton';
import type { EventLiveExplain } from '../domain/event-live-explains';
import type { FplSeasonRef } from '../domain/fpl-season';
import { DatabaseError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

function emptyExplain(eventId: number, elementId: number): EventLiveExplain {
  return {
    eventId,
    elementId,
    bonus: null,
    minutes: null,
    minutesPoints: null,
    goalsScored: null,
    goalsScoredPoints: null,
    assists: null,
    assistsPoints: null,
    cleanSheets: null,
    cleanSheetsPoints: null,
    goalsConceded: null,
    goalsConcededPoints: null,
    ownGoals: null,
    ownGoalsPoints: null,
    penaltiesSaved: null,
    penaltiesSavedPoints: null,
    penaltiesMissed: null,
    penaltiesMissedPoints: null,
    yellowCards: null,
    yellowCardsPoints: null,
    redCards: null,
    redCardsPoints: null,
    saves: null,
    savesPoints: null,
    defensiveContribution: null,
    defensiveContributionPoints: null,
  };
}

function applyScoringItem(explain: EventLiveExplain, row: DbEventLiveExplain): void {
  switch (row.scoringIdentifier) {
    case 'minutes':
      Object.assign(explain, { minutes: row.scoringValue, minutesPoints: row.points });
      break;
    case 'goals_scored':
      Object.assign(explain, { goalsScored: row.scoringValue, goalsScoredPoints: row.points });
      break;
    case 'assists':
      Object.assign(explain, { assists: row.scoringValue, assistsPoints: row.points });
      break;
    case 'clean_sheets':
      Object.assign(explain, { cleanSheets: row.scoringValue, cleanSheetsPoints: row.points });
      break;
    case 'goals_conceded':
      Object.assign(explain, {
        goalsConceded: row.scoringValue,
        goalsConcededPoints: row.points,
      });
      break;
    case 'own_goals':
      Object.assign(explain, { ownGoals: row.scoringValue, ownGoalsPoints: row.points });
      break;
    case 'penalties_saved':
      Object.assign(explain, {
        penaltiesSaved: row.scoringValue,
        penaltiesSavedPoints: row.points,
      });
      break;
    case 'penalties_missed':
      Object.assign(explain, {
        penaltiesMissed: row.scoringValue,
        penaltiesMissedPoints: row.points,
      });
      break;
    case 'yellow_cards':
      Object.assign(explain, { yellowCards: row.scoringValue, yellowCardsPoints: row.points });
      break;
    case 'red_cards':
      Object.assign(explain, { redCards: row.scoringValue, redCardsPoints: row.points });
      break;
    case 'saves':
      Object.assign(explain, { saves: row.scoringValue, savesPoints: row.points });
      break;
    case 'bonus':
      Object.assign(explain, { bonus: row.points });
      break;
    case 'defensive_contribution':
      Object.assign(explain, {
        defensiveContribution: row.scoringValue,
        defensiveContributionPoints: row.points,
      });
      break;
    default:
      throw new Error(`Unsupported FPL scoring identifier: ${row.scoringIdentifier}`);
  }
}

function flattenExplain(
  season: FplSeasonRef,
  explain: EventLiveExplain,
): DbEventLiveExplainInsert[] {
  const rows: DbEventLiveExplainInsert[] = [];
  const add = (scoringIdentifier: string, scoringValue: number | null, points: number | null) => {
    const value = scoringValue ?? 0;
    const score = points ?? 0;
    if (value === 0 && score === 0) {
      return;
    }
    rows.push({
      seasonId: season.seasonId,
      eventId: explain.eventId,
      elementId: explain.elementId,
      scoringIdentifier,
      scoringValue: value,
      points: score,
    });
  };

  add('minutes', explain.minutes, explain.minutesPoints);
  add('goals_scored', explain.goalsScored, explain.goalsScoredPoints);
  add('assists', explain.assists, explain.assistsPoints);
  add('clean_sheets', explain.cleanSheets, explain.cleanSheetsPoints);
  add('goals_conceded', explain.goalsConceded, explain.goalsConcededPoints);
  add('own_goals', explain.ownGoals, explain.ownGoalsPoints);
  add('penalties_saved', explain.penaltiesSaved, explain.penaltiesSavedPoints);
  add('penalties_missed', explain.penaltiesMissed, explain.penaltiesMissedPoints);
  add('yellow_cards', explain.yellowCards, explain.yellowCardsPoints);
  add('red_cards', explain.redCards, explain.redCardsPoints);
  add('saves', explain.saves, explain.savesPoints);
  add('bonus', explain.bonus, explain.bonus);
  add('defensive_contribution', explain.defensiveContribution, explain.defensiveContributionPoints);
  return rows;
}

export const createEventLiveExplainsRepository = (dbInstance?: DbOrTransaction) => {
  const getDbInstance = async () => dbInstance ?? (await getDb());

  return {
    findByEventId: async (season: FplSeasonRef, eventId: number): Promise<EventLiveExplain[]> => {
      try {
        const db = await getDbInstance();
        const rows = await db
          .select()
          .from(playerGameweekScoringItemsInFpl)
          .where(
            and(
              eq(playerGameweekScoringItemsInFpl.seasonId, season.seasonId),
              eq(playerGameweekScoringItemsInFpl.eventId, eventId),
            ),
          )
          .orderBy(
            playerGameweekScoringItemsInFpl.elementId,
            playerGameweekScoringItemsInFpl.scoringIdentifier,
          );

        const byElementId = new Map<number, EventLiveExplain>();
        for (const row of rows) {
          const explain =
            byElementId.get(row.elementId) ?? emptyExplain(row.eventId, row.elementId);
          applyScoringItem(explain, row);
          byElementId.set(row.elementId, explain);
        }
        return [...byElementId.values()];
      } catch (error) {
        logError('Failed to find event live explains by event ID', error, {
          season: season.seasonCode,
          eventId,
        });
        throw new DatabaseError(
          'Failed to find event live explains',
          'FIND_BY_EVENT_ID_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },

    replaceEvent: async (
      season: FplSeasonRef,
      records: EventLiveExplain[],
    ): Promise<DbEventLiveExplain[]> => {
      if (records.length === 0) {
        return [];
      }
      const eventIds = new Set(records.map((record) => record.eventId));
      if (eventIds.size !== 1) {
        throw new Error('Event live scoring replacement requires exactly one event');
      }
      const eventId = records[0].eventId;
      const inserts = records.flatMap((record) => flattenExplain(season, record));

      const replace = async (db: DbOrTransaction): Promise<DbEventLiveExplain[]> => {
        await db
          .delete(playerGameweekScoringItemsInFpl)
          .where(
            and(
              eq(playerGameweekScoringItemsInFpl.seasonId, season.seasonId),
              eq(playerGameweekScoringItemsInFpl.eventId, eventId),
            ),
          );
        return inserts.length === 0
          ? []
          : await db.insert(playerGameweekScoringItemsInFpl).values(inserts).returning();
      };

      try {
        const result = dbInstance
          ? await replace(dbInstance)
          : await (await getDb()).transaction((transaction) => replace(transaction));
        logInfo('Replaced event live scoring items', {
          season: season.seasonCode,
          eventId,
          count: result.length,
        });
        return result;
      } catch (error) {
        logError('Failed to replace event live scoring items', error, {
          season: season.seasonCode,
          eventId,
          count: records.length,
        });
        throw new DatabaseError(
          'Failed to replace event live scoring items',
          'REPLACE_SCORING_ITEMS_ERROR',
          error instanceof Error ? error : undefined,
        );
      }
    },
  };
};

export const eventLiveExplainsRepository = createEventLiveExplainsRepository();
