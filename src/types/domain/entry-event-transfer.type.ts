import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { Branded, createBrandedType } from 'src/types/base.type';

export type EntryEventTransferId = Branded<number, 'EntryEventTransferId'>;

export const createEntryEventTransferId = createBrandedType<number, 'EntryEventTransferId'>(
  'EntryEventTransferId',
  (value: unknown): value is number => typeof value === 'number' && value > 0,
);

export const validateEntryEventTransferId = (
  value: unknown,
): E.Either<string, EntryEventTransferId> => {
  return pipe(
    value,
    E.fromPredicate(
      (v): v is number => typeof v === 'number' && v > 0,
      () => 'Invalid entry event transfer ID: must be a positive integer',
    ),
    E.map((v) => v as EntryEventTransferId),
  );
};

export type EntryEventTransfer = {
  readonly id: EntryEventTransferId;
  readonly entry: number;
  readonly event: number;
  readonly elementIn: number;
  readonly elementInCost: number;
  readonly elementInPoints: number;
  readonly elementOut: number;
  readonly elementOutCost: number;
  readonly elementOutPoints: number;
  readonly transferTime: Date;
};

export type MappedEntryEventTransfer = Omit<
  EntryEventTransfer,
  'id' | 'elementInPoints' | 'elementOutPoints'
>;
export type EntryEventTransfers = readonly MappedEntryEventTransfer[];
