import * as A from 'fp-ts/Array';
import * as O from 'fp-ts/Option';
import { Ord } from 'fp-ts/Ord';
import { pipe } from 'fp-ts/function';

/**
 * Common array operations using fp-ts
 */
export const ArrayFP = {
  /**
   * Safely converts a readonly array to a mutable array
   */
  fromReadonly: <T>(xs: ReadonlyArray<T>): ReadonlyArray<T> => Array.prototype.slice.call(xs),

  /**
   * Finds the first element matching the predicate
   */
  findFirst:
    <T>(predicate: (x: T) => boolean) =>
    (xs: ReadonlyArray<T>): O.Option<T> =>
      pipe(xs, A.findFirst<T>(predicate)),

  /**
   * Sorts array by multiple criteria
   */
  sortBy:
    <T>(ords: ReadonlyArray<Ord<T>>) =>
    (xs: ReadonlyArray<T>): ReadonlyArray<T> =>
      pipe(xs, A.sortBy(ords)),

  /**
   * Maps and filters array elements, returning Options
   */
  filterMap:
    <T, U>(f: (x: T) => O.Option<U>) =>
    (xs: ReadonlyArray<T>): ReadonlyArray<U> =>
      pipe(xs, A.filterMap(f)),

  /**
   * Gets the first element of an array
   */
  head: <T>(xs: ReadonlyArray<T>): O.Option<T> => pipe(xs, A.head),
} as const;
