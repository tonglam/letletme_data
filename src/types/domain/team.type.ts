import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';

import { Branded, createBrandedType } from '../base.type';

export type TeamId = Branded<number, 'TeamId'>;

export const createTeamId = createBrandedType<number, 'TeamId'>(
  'TeamId',
  (value: unknown): value is number =>
    typeof value === 'number' && value > 0 && Number.isInteger(value),
);

export const validateTeamId = (value: unknown): E.Either<string, TeamId> =>
  pipe(
    value,
    E.fromPredicate(
      (v): v is number => typeof v === 'number' && v > 0 && Number.isInteger(v),
      () => 'Invalid team ID: must be a positive integer',
    ),
    E.map((v) => v as TeamId),
  );

export interface Team {
  readonly id: TeamId;
  readonly code: number;
  readonly name: string;
  readonly shortName: string;
  readonly strength: number;
  readonly strengthOverallHome: number;
  readonly strengthOverallAway: number;
  readonly strengthAttackHome: number;
  readonly strengthAttackAway: number;
  readonly strengthDefenceHome: number;
  readonly strengthDefenceAway: number;
  readonly pulseId: number;
  readonly played: number;
  readonly position: number;
  readonly points: number;
  readonly form: string | null;
  readonly win: number;
  readonly draw: number;
  readonly loss: number;
  readonly teamDivision: string | null;
  readonly unavailable: boolean;
}

export type Teams = readonly Team[];
