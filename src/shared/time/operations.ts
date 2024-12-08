import { compareDesc, isAfter, parseISO } from 'date-fns';
import { pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';

/**
 * Common time operations
 */
export const TimeOperations = {
  /**
   * Parses an ISO string to Date, returning Option
   */
  parseDate: (dateStr: string): O.Option<Date> =>
    pipe(
      O.tryCatch(() => parseISO(dateStr)),
      O.filter((date) => !isNaN(date.getTime())),
    ),

  /**
   * Compares two dates in descending order
   */
  compareDesc: (a: Date, b: Date): -1 | 0 | 1 => compareDesc(a, b) as -1 | 0 | 1,

  /**
   * Checks if first date is after second date
   */
  isAfter: (date: Date, dateToCompare: Date): boolean => isAfter(date, dateToCompare),
} as const;
