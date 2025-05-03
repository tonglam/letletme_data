import { Event } from '@app/domain/event/model';
import { EventID } from '@app/domain/shared/types/id.types';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';

export interface EventDto {
  readonly id: EventID;
  readonly deadlineTime: Date;
  readonly finished: boolean;
}

export const createDto = (event: Event): E.Either<Error, EventDto> => {
  return pipe(
    E.right(event),
    E.map((event) => ({
      id: event.id,
      deadlineTime: event.deadlineTime,
      finished: event.finished,
    })),
  );
};
