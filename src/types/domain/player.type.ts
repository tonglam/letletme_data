import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { Branded, createBrandedType, ElementTypeId } from 'types/base.type';
import { TeamId } from 'types/domain/team.type';

export type PlayerId = Branded<number, 'PlayerId'>;

export const PlayerId = createBrandedType<number, 'PlayerId'>(
  'PlayerId',
  (value: unknown): value is number =>
    typeof value === 'number' && value > 0 && Number.isInteger(value),
);

export const validatePlayerId = (value: unknown): E.Either<string, PlayerId> =>
  pipe(
    value,
    E.fromPredicate(
      (v): v is number => typeof v === 'number' && v > 0 && Number.isInteger(v),
      () => 'Invalid player ID: must be a positive integer',
    ),
    E.map((v) => v as PlayerId),
  );

export type Player = {
  readonly id: PlayerId;
  readonly code: number;
  readonly type: ElementTypeId;
  readonly teamId: TeamId;
  readonly teamName: string;
  readonly teamShortName: string;
  readonly price: number;
  readonly startPrice: number;
  readonly firstName: string | null;
  readonly secondName: string | null;
  readonly webName: string;
};

export type Players = readonly Player[];

export type RawPlayer = Omit<Player, 'teamName' | 'teamShortName'>;
export type RawPlayers = readonly RawPlayer[];
