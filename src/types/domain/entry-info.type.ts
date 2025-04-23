import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { Branded, createBrandedType } from 'src/types/base.type';

export type EntryId = Branded<number, 'EntryId'>;

export const createEntryId = createBrandedType<number, 'EntryId'>(
  'EntryId',
  (value: unknown): value is number => typeof value === 'number' && value > 0,
);

export const validateEntryId = (value: unknown): E.Either<string, EntryId> => {
  return pipe(
    value,
    E.fromPredicate(
      (v): v is number => typeof v === 'number' && v > 0,
      () => 'Invalid entry ID: must be a positive integer',
    ),
    E.map((v) => v as EntryId),
  );
};

export type EntryInfo = {
  readonly entry: EntryId;
  readonly entryName: string;
  readonly playerName: string;
  readonly region: string | null;
  readonly startedEvent: number;
  readonly overallPoints: number;
  readonly overallRank: number;
  readonly bank: number | null;
  readonly teamValue: number | null;
  readonly totalTransfers: number | null;
  readonly lastEntryName: string | null;
  readonly lastOverallPoints: number | null;
  readonly lastOverallRank: number | null;
  readonly lastEventPoints: number | null;
  readonly lastTeamValue: number | null;
  readonly usedEntryNames: string[];
};

export type MappedEntryInfo = Omit<
  EntryInfo,
  | 'lastEntryName'
  | 'lastOverallPoints'
  | 'lastOverallRank'
  | 'lastEventPoints'
  | 'lastTeamValue'
  | 'usedEntryNames'
>;
export type EntryInfos = readonly MappedEntryInfo[];
