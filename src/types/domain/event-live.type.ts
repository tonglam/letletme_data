import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { Branded, createBrandedType } from '../base.type';

export type EventLiveId = Branded<number, 'EventLiveId'>;

export const createEventLiveId = createBrandedType<number, 'EventLiveId'>(
  'EventLiveId',
  (value: unknown): value is number => typeof value === 'number' && value > 0,
);

export const validateEventLiveId = (value: unknown): E.Either<string, EventLiveId> =>
  pipe(
    value,
    E.fromPredicate(
      (v): v is number => typeof v === 'number' && v > 0,
      () => 'Invalid event live ID: must be a positive integer',
    ),
    E.map((v) => v as EventLiveId),
  );

export type EventLive = {
  readonly id: EventLiveId;
  readonly event: number;
  readonly live: boolean;
};

export type EventLives = readonly EventLive[];
