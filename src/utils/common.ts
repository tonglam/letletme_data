import { compareDesc, isAfter, parseISO } from 'date-fns';
import * as A from 'fp-ts/Array';
import * as O from 'fp-ts/Option';
import { Ord, fromCompare } from 'fp-ts/Ord';
import { pipe } from 'fp-ts/function';

/**
 * Represents a deadline event with its identifier and timing information
 */
interface EventDeadline {
  id: number;
  deadlineTime: string;
  deadlineTimeEpoch: number;
}

/**
 * Result type for getCurrentEvent operation
 * @property currentEventId - The ID of the current event (0 if no event found)
 * @property isValid - Whether a valid current event was found
 * @property error - Optional error message if no event was found
 */
type GetCurrentEventResult = {
  currentEventId: number;
  isValid: boolean;
  error?: string;
};

/**
 * Internal type for handling dates during event processing
 */
interface DeadlineWithDate {
  id: number;
  date: Date;
}

/**
 * Ordering for DeadlineWithDate based on date in descending order
 */
const byDate: Ord<DeadlineWithDate> = fromCompare(
  (x, y) => compareDesc(x.date, y.date) as -1 | 0 | 1,
);

/**
 * Finds the most recent event that has passed
 * @param now - Current date to compare against
 * @param deadlines - Array of event deadlines
 * @returns Option of the most recent past event ID
 */
const findCurrentEvent = (now: Date, deadlines: ReadonlyArray<EventDeadline>): O.Option<number> =>
  pipe(
    Array.prototype.slice.call(deadlines),
    A.filterMap((d: EventDeadline): O.Option<DeadlineWithDate> => {
      const date = parseISO(d.deadlineTime);
      return isAfter(now, date) ? O.some({ id: d.id, date }) : O.none;
    }),
    A.sortBy([byDate]),
    A.head,
    O.map((d) => d.id),
  );

/**
 * Gets the current event based on the provided deadlines
 * @param deadlines - Array of event deadlines to process
 * @returns Result containing current event info or error if none found
 */
const getCurrentEvent = (deadlines: ReadonlyArray<EventDeadline>): GetCurrentEventResult =>
  pipe(
    findCurrentEvent(new Date(), deadlines),
    O.fold<number, GetCurrentEventResult>(
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

export { getCurrentEvent };
