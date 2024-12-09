import * as A from 'fp-ts/Array';
import * as O from 'fp-ts/Option';
import { Ord, fromCompare } from 'fp-ts/Ord';
import { pipe } from 'fp-ts/function';
import { ArrayFP } from '../../shared/fp/array';
import { TimeOperations } from '../../shared/time/operations';
import { Event, EventDeadline, EventQueryResult, EventResult } from './types';

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

  /**
   * Gets events within a date range
   */
  getEventsInRange: (
    events: ReadonlyArray<Event>,
    startDate: Date,
    endDate: Date,
  ): EventResult<ReadonlyArray<Event>> => {
    try {
      const filteredEvents = pipe(
        [...events],
        A.filter((event) =>
          pipe(
            TimeOperations.parseDate(event.deadlineTime),
            O.map(
              (date) =>
                TimeOperations.isAfter(date, startDate) && TimeOperations.isAfter(endDate, date),
            ),
            O.getOrElse(() => false),
          ),
        ),
      );

      return {
        success: true,
        data: filteredEvents,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error filtering events',
      };
    }
  },

  /**
   * Gets upcoming events
   */
  getUpcoming: (events: ReadonlyArray<Event>): EventResult<ReadonlyArray<Event>> => {
    try {
      const now = new Date();
      const upcomingEvents = pipe(
        [...events],
        A.filter((event) =>
          pipe(
            TimeOperations.parseDate(event.deadlineTime),
            O.map((date) => TimeOperations.isAfter(date, now)),
            O.getOrElse(() => false),
          ),
        ),
        A.sort(
          fromCompare<Event>((a, b) =>
            TimeOperations.compareDesc(
              new Date(a.deadlineTimeEpoch * 1000),
              new Date(b.deadlineTimeEpoch * 1000),
            ),
          ),
        ),
      );

      return {
        success: true,
        data: upcomingEvents,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error finding upcoming events',
      };
    }
  },

  /**
   * Gets finished events
   */
  getFinished: (events: ReadonlyArray<Event>): EventResult<ReadonlyArray<Event>> => {
    try {
      const finishedEvents = pipe(
        [...events],
        A.filter((event) => event.isFinished),
        A.sort(
          fromCompare<Event>((a, b) =>
            TimeOperations.compareDesc(
              new Date(a.deadlineTimeEpoch * 1000),
              new Date(b.deadlineTimeEpoch * 1000),
            ),
          ),
        ),
      );

      return {
        success: true,
        data: finishedEvents,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error finding finished events',
      };
    }
  },
} as const;
