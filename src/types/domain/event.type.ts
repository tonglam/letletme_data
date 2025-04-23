import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';

import { Branded, createBrandedType } from '../base.type';

export type EventId = Branded<number, 'EventId'>;

export const createEventId = createBrandedType<number, 'EventId'>(
  'EventId',
  (value: unknown): value is number =>
    typeof value === 'number' && value > 0 && value < 39 && Number.isInteger(value),
);

export const validateEventId = (value: unknown): E.Either<string, EventId> =>
  pipe(
    value,
    E.fromPredicate(
      (v): v is number => typeof v === 'number' && v > 0 && v < 39 && Number.isInteger(v),
      () => 'Invalid event ID: must be a positive integer between 1 and 38',
    ),
    E.map((v) => v as EventId),
  );

export interface TopElementInfo {
  readonly id: number;
  readonly points: number;
}

export interface ChipPlay {
  readonly chip_name: string;
  readonly num_played: number;
}

export type Event = {
  readonly id: EventId;
  readonly name: string;
  readonly deadlineTime: string;
  readonly finished: boolean;
  readonly isPrevious: boolean;
  readonly isCurrent: boolean;
  readonly isNext: boolean;
  readonly averageEntryScore: number;
  readonly dataChecked: boolean;
  readonly highestScore: number | null;
  readonly highestScoringEntry: number | null;
  readonly cupLeaguesCreated: boolean;
  readonly h2hKoMatchesCreated: boolean;
  readonly transfersMade: number;
  readonly rankedCount: number;
  readonly chipPlays: readonly ChipPlay[];
  readonly mostSelected: number | null;
  readonly mostTransferredIn: number | null;
  readonly mostCaptained: number | null;
  readonly mostViceCaptained: number | null;
  readonly topElement: number | null;
  readonly topElementInfo: TopElementInfo | null;
};

export type Events = readonly Event[];
