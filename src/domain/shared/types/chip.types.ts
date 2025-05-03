import * as E from 'fp-ts/Either';
import { z } from 'zod';

export const Chips = ['n/a', 'wildcard', 'freehit', '3xc', 'bboost', 'manager'] as const;

export type Chip = (typeof Chips)[number];

export const ChipSchema = z.enum(Chips);

export const validateChip = (value: unknown): E.Either<Error, Chip> => {
  const result = ChipSchema.safeParse(value);
  return result.success
    ? E.right(result.data)
    : E.left(new Error(`Invalid chip. Received: ${value}`));
};
