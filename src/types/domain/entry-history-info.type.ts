import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { Branded, createBrandedType } from 'src/types/base.type';

export type EntryHistoryInfoId = Branded<number, 'EntryHistoryInfoId'>;

export const createEntryHistoryInfoId = createBrandedType<number, 'EntryHistoryInfoId'>(
  'EntryHistoryInfoId',
  (value: unknown): value is number => typeof value === 'number' && value > 0,
);

export const validateEntryHistoryInfoId = (
  value: unknown,
): E.Either<string, EntryHistoryInfoId> => {
  return pipe(
    value,
    E.fromPredicate(
      (v): v is number => typeof v === 'number' && v > 0,
      () => 'Invalid entry history info ID: must be a positive integer',
    ),
    E.map((v) => v as EntryHistoryInfoId),
  );
};

export type EntryHistoryInfo = {
  readonly id: EntryHistoryInfoId;
  readonly entry: number;
  readonly season: string;
  readonly totalPoints: number;
  readonly overallRank: number;
};

export type MappedEntryHistoryInfo = Omit<EntryHistoryInfo, 'id'>;
export type EntryHistoryInfos = readonly MappedEntryHistoryInfo[];
