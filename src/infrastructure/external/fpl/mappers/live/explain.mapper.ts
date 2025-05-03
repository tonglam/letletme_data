import { EventLiveExplain } from '@app/domain/models/event-live-explain.model';
import { EventID, PlayerID, validatePlayerId } from '@app/domain/shared/types/id.types';
import { EventLiveExplainResponse } from '@app/infrastructure/external/fpl/schemas/live/explain.schema';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';

export const mapEventLiveExplainResponseToDomain = (
  eventId: EventID,
  elementIdInput: number | undefined | null,
  raw: EventLiveExplainResponse,
): E.Either<string, EventLiveExplain> => {
  const validatedElementIdEither = validatePlayerId(elementIdInput);

  return pipe(
    validatedElementIdEither,
    E.map((validElementId) => {
      const defaultStats = {
        eventId: eventId,
        elementId: validElementId as PlayerID,
        bonus: 0,
        minutes: 0,
        minutesPoints: 0,
        goalsScored: 0,
        goalsScoredPoints: 0,
        assists: 0,
        assistsPoints: 0,
        cleanSheets: 0,
        cleanSheetsPoints: 0,
        goalsConceded: 0,
        goalsConcededPoints: 0,
        ownGoals: 0,
        ownGoalsPoints: 0,
        penaltiesSaved: 0,
        penaltiesSavedPoints: 0,
        penaltiesMissed: 0,
        penaltiesMissedPoints: 0,
        yellowCards: 0,
        yellowCardsPoints: 0,
        redCards: 0,
        redCardsPoints: 0,
        saves: 0,
        savesPoints: 0,
        mngWin: 0,
        mngWinPoints: 0,
        mngDraw: 0,
        mngDrawPoints: 0,
        mngLoss: 0,
        mngLossPoints: 0,
        mngUnderdogWin: 0,
        mngUnderdogWinPoints: 0,
        mngUnderdogDraw: 0,
        mngUnderdogDrawPoints: 0,
        mngCleanSheets: 0,
        mngCleanSheetsPoints: 0,
        mngGoalsScored: 0,
        mngGoalsScoredPoints: 0,
      };

      const processedStats = raw.stats.reduce(
        (acc, stat) => {
          const identifier = stat.identifier;
          const value = stat.value;
          const points = stat.points;

          switch (identifier) {
            case 'minutes':
              acc.minutes = value;
              acc.minutesPoints = points;
              break;
            case 'goals_scored':
              acc.goalsScored = value;
              acc.goalsScoredPoints = points;
              break;
            case 'assists':
              acc.assists = value;
              acc.assistsPoints = points;
              break;
            case 'clean_sheets':
              acc.cleanSheets = value;
              acc.cleanSheetsPoints = points;
              break;
            case 'goals_conceded':
              acc.goalsConceded = value;
              acc.goalsConcededPoints = points;
              break;
            case 'own_goals':
              acc.ownGoals = value;
              acc.ownGoalsPoints = points;
              break;
            case 'penalties_saved':
              acc.penaltiesSaved = value;
              acc.penaltiesSavedPoints = points;
              break;
            case 'penalties_missed':
              acc.penaltiesMissed = value;
              acc.penaltiesMissedPoints = points;
              break;
            case 'yellow_cards':
              acc.yellowCards = value;
              acc.yellowCardsPoints = points;
              break;
            case 'red_cards':
              acc.redCards = value;
              acc.redCardsPoints = points;
              break;
            case 'saves':
              acc.saves = value;
              acc.savesPoints = points;
              break;
            case 'bonus':
              acc.bonus = value;
              break;
          }

          return acc;
        },
        { ...defaultStats },
      );

      return processedStats as EventLiveExplain;
    }),
  );
};
