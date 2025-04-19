import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { Branded, createBrandedType } from 'src/types/base.type';

export type EventLiveExplainId = Branded<number, 'EventLiveExplainId'>;

export const createEventLiveExplainId = createBrandedType<number, 'EventLiveExplainId'>(
  'EventLiveExplainId',
  (value: unknown): value is number => typeof value === 'number' && value > 0,
);

export const validateEventLiveExplainId = (value: unknown): E.Either<string, EventLiveExplainId> =>
  pipe(
    value,
    E.fromPredicate(
      (v) => typeof v === 'number' && v > 0,
      () => 'Invalid event live explain ID: must be a positive integer',
    ),
    E.map((v) => v as EventLiveExplainId),
  );

export interface EventLiveExplain {
  readonly id: EventLiveExplainId;
  readonly event: number;
  readonly element: number;
  readonly bps: number | null;
  readonly bonus: number | null;
  readonly minutes: number | null;
  readonly minutesPoints: number | null;
  readonly goalsScored: number | null;
  readonly goalsScoredPoints: number | null;
  readonly assists: number | null;
  readonly assistsPoints: number | null;
  readonly cleanSheets: number | null;
  readonly cleanSheetsPoints: number | null;
  readonly goalsConceded: number | null;
  readonly goalsConcededPoints: number | null;
  readonly ownGoals: number | null;
  readonly ownGoalsPoints: number | null;
  readonly penaltiesSaved: number | null;
  readonly penaltiesSavedPoints: number | null;
  readonly penaltiesMissed: number | null;
  readonly penaltiesMissedPoints: number | null;
  readonly yellowCards: number | null;
  readonly yellowCardsPoints: number | null;
  readonly redCards: number | null;
  readonly redCardsPoints: number | null;
  readonly saves: number | null;
  readonly savesPoints: number | null;
  readonly mngWin: number | null;
  readonly mngWinPoints: number | null;
  readonly mngDraw: number | null;
  readonly mngDrawPoints: number | null;
  readonly mngLoss: number | null;
  readonly mngLossPoints: number | null;
  readonly mngUnderdogWin: number | null;
  readonly mngUnderdogWinPoints: number | null;
  readonly mngUnderdogDraw: number | null;
  readonly mngUnderdogDrawPoints: number | null;
  readonly mngCleanSheets: number | null;
  readonly mngCleanSheetsPoints: number | null;
  readonly mngGoalsScored: number | null;
  readonly mngGoalsScoredPoints: number | null;
}

export type MappedEventLiveExplain = Omit<EventLiveExplain, 'id'>;
export type EventLiveExplains = readonly MappedEventLiveExplain[];
