import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';

export type Chip = 'n/a' | 'wildcard' | 'freehit' | '3xc' | 'bboost' | 'manager';

export const Chips: Chip[] = ['n/a', 'wildcard', 'freehit', '3xc', 'bboost', 'manager'];

export const validateChip = (value: unknown): E.Either<string, Chip> => {
  return pipe(
    value,
    E.fromPredicate(
      (v): v is Chip => typeof v === 'string' && Chips.includes(v as Chip),
      () => 'Invalid chip: must be one of n/a, wildcard, freehit, 3xc, bboost, or manager',
    ),
  );
};
