import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { Branded, createBrandedType, LeagueType } from 'src/types/base.type';

export type EntryLeagueInfoId = Branded<number, 'EntryLeagueInfoId'>;

export const createEntryLeagueInfoId = createBrandedType<number, 'EntryLeagueInfoId'>(
  'EntryLeagueInfoId',
  (value: unknown): value is number => typeof value === 'number' && value > 0,
);

export const validateEntryLeagueInfoId = (value: unknown): E.Either<string, EntryLeagueInfoId> => {
  return pipe(
    value,
    E.fromPredicate(
      (v): v is number => typeof v === 'number' && v > 0,
      () => 'Invalid entry league info ID: must be a positive integer',
    ),
    E.map((v) => v as EntryLeagueInfoId),
  );
};

export type EntryLeagueInfo = {
  readonly id: EntryLeagueInfoId;
  readonly entry: number;
  readonly leagueId: number;
  readonly leagueName: string;
  readonly leagueType: LeagueType;
  readonly startedEvent: number | null;
  readonly entryRank: number | null;
  readonly entryLastRank: number | null;
};

export type MappedEntryLeagueInfo = Omit<EntryLeagueInfo, 'id'>;
export type EntryLeagueInfos = readonly MappedEntryLeagueInfo[];
