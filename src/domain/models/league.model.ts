import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { Branded, createBrandedType, LeagueType } from 'types/base.type';
import { EntryId } from 'types/domain/entry-info.type';

export type LeagueId = Branded<number, 'LeagueId'>;

export const createLeagueId = createBrandedType<number, 'LeagueId'>(
  'LeagueId',
  (value: unknown): value is number => typeof value === 'number' && value > 0,
);

export const validateLeagueId = (value: unknown): E.Either<string, LeagueId> => {
  return pipe(
    value,
    E.fromPredicate(
      (v): v is number => typeof v === 'number' && v > 0,
      () => 'Invalid league ID: must be a positive integer',
    ),
    E.map((v) => v as LeagueId),
  );
};

type ClassicStandings = {
  readonly entryId: EntryId;
  readonly entryName: string;
  readonly playerName: string;
  readonly rank: number;
  readonly lastRank: number;
  readonly rankSort: number;
  readonly eventPoints: number;
  readonly totalPoints: number;
  readonly hasPlayed: boolean;
};

type H2hStandings = {
  readonly entryId: EntryId;
  readonly entryName: string;
  readonly playerName: string;
  readonly rank: number;
  readonly lastRank: number;
  readonly rankSort: number;
  readonly eventPoints: number;
  readonly totalPoints: number;
  readonly played: number;
  readonly won: number;
  readonly drawn: number;
  readonly lost: number;
};

type LeagueInfo = {
  readonly id: LeagueId;
  readonly name: string;
  readonly leagueType: LeagueType;
  readonly created: Date;
  readonly closed: boolean;
  readonly adminEntryId: number | null;
  readonly startEventId: number;
  readonly hasCup: boolean;
  readonly cupLeague: number | null;
  readonly lastUpdatedData: Date;
};

export type ClassicLeague = LeagueInfo & {
  readonly standings: ClassicStandings[];
};

export type ClassicLeagues = readonly ClassicLeague[];

export type H2hLeague = LeagueInfo & {
  readonly koRounds: number;
  readonly standings: H2hStandings[];
};

export type H2hLeagues = readonly H2hLeague[];
