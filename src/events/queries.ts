import * as O from 'fp-ts/Option';
import { Ord, fromCompare } from 'fp-ts/Ord';
import { pipe } from 'fp-ts/function';
import { ArrayFP } from '../shared/fp/array';
import { TimeOperations } from '../shared/time/operations';
import { EventDeadline, EventQueryResult } from './types';

/**
 * Internal type for handling dates during event processing
 */
interface DeadlineWithDate {
  readonly id: number;
  readonly date: Date;
}

/**
 * Ordering for DeadlineWithDate based on date in descending order
 */
const byDate: Ord<DeadlineWithDate> = fromCompare((x, y) =>
  TimeOperations.compareDesc(x.date, y.date),
);

/**
 * Event query functions
 */
export const EventQueries = {
  /**
   * Gets the current event based on the provided deadlines
   */
  getCurrent: (deadlines: ReadonlyArray<EventDeadline>): EventQueryResult => {
    const findCurrentEvent = (now: Date, ds: ReadonlyArray<EventDeadline>): O.Option<number> =>
      pipe(
        ds,
        ArrayFP.filterMap(
          (d: EventDeadline): O.Option<DeadlineWithDate> =>
            pipe(
              TimeOperations.parseDate(d.deadlineTime),
              O.chain((date) =>
                TimeOperations.isAfter(now, date) ? O.some({ id: d.id, date }) : O.none,
              ),
            ),
        ),
        ArrayFP.sortBy([byDate]),
        ArrayFP.head,
        O.map((d) => d.id),
      );

    return pipe(
      findCurrentEvent(new Date(), deadlines),
      O.fold<number, EventQueryResult>(
        () => ({
          currentEventId: 0,
          isValid: false,
          error: 'No current event found',
        }),
        (id) => ({
          currentEventId: id,
          isValid: true,
        }),
      ),
    );
  },
} as const;
