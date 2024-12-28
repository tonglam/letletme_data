import * as O from 'fp-ts/Option';
import * as T from 'fp-ts/Task';
import { flow } from 'fp-ts/function';

/**
 * Converts an Option to a nullable value with a default value
 * @param defaultValue - The default value to use when Option is None
 * @returns A function that converts Option<T> to T
 */
export const toNullable = <T>(defaultValue: T) =>
  flow(
    O.fold(
      () => defaultValue,
      (value: T) => value,
    ),
  );

export const toNullableTask = <T>(option: O.Option<T>): T.Task<T | null> =>
  T.of(O.toNullable(option));
