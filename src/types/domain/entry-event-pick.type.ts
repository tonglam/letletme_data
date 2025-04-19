import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { Branded, Chip, createBrandedType } from 'src/types/base.type';

export type EntryEventPickId = Branded<number, 'EntryEventPickId'>;

export const createEntryEventPickId = createBrandedType<number, 'EntryEventPickId'>(
  'EntryEventPickId',
  (value: unknown): value is number => typeof value === 'number' && value > 0,
);

export const validateEntryEventPickId = (value: unknown): E.Either<string, EntryEventPickId> => {
  return pipe(
    value,
    E.fromPredicate(
      (v): v is number => typeof v === 'number' && v > 0,
      () => 'Invalid entry event info ID: must be a positive integer',
    ),
    E.map((v) => v as EntryEventPickId),
  );
};

export type EntryEventPick = {
  readonly id: EntryEventPickId;
  readonly entry: number;
  readonly event: number;
  readonly chip: Chip | null;
  readonly picks: readonly number[];
  readonly transfers: number;
  readonly transfersCost: number;
};

export type MappedEntryEventPick = Omit<EntryEventPick, 'id' | 'transfers' | 'transfersCost'>;
export type EntryEventPicks = readonly MappedEntryEventPick[];
