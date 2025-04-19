import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { Branded, createBrandedType } from 'src/types/base.type';

export type EntryInfoId = Branded<number, 'EntryInfoId'>;

export const createEntryInfoId = createBrandedType<number, 'EntryInfoId'>(
  'EntryInfoId',
  (value: unknown): value is number => typeof value === 'number' && value > 0,
);

export const validateEntryInfoId = (value: unknown): E.Either<string, EntryInfoId> => {
  return pipe(
    value,
    E.fromPredicate(
      (v): v is number => typeof v === 'number' && v > 0,
      () => 'Invalid entry info ID: must be a positive integer',
    ),
    E.map((v) => v as EntryInfoId),
  );
};

export type EntryInfo = {
  readonly entry: EntryInfoId;
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
