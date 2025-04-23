import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { Branded, createBrandedType } from 'src/types/base.type';

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

export type LeagueInfo = {
  readonly id: LeagueId;
  readonly name: string;
  readonly created: string;
  readonly closed: boolean;
};

export type LeagueInfos = readonly LeagueInfo[];
