import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';

export const Chips = ['n/a', 'wildcard', 'freehit', '3xc', 'bboost', 'manager'] as const;

export type Chip = (typeof Chips)[number];

export const validateChip = (value: unknown): E.Either<Error, Chip> => {
  return pipe(
    value,
    E.fromPredicate(
      (v): v is Chip => typeof v === 'string' && Chips.includes(v as Chip),
      (err) =>
        new Error(
          `Invalid chip: must be one of n/a, wildcard, freehit, 3xc, bboost, or manager. Received: ${err}`,
        ),
    ),
  );
};
