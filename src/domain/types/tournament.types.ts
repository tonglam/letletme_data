import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';

// --- TournamentMode ---
export const TournamentModes = ['normal'] as const;

export type TournamentMode = (typeof TournamentModes)[number];

export const validateTournamentMode = (value: unknown): E.Either<Error, TournamentMode> => {
  return pipe(
    value,
    E.fromPredicate(
      (v): v is TournamentMode =>
        typeof v === 'string' && TournamentModes.includes(v as TournamentMode),
      (err) => new Error(`Invalid tournament mode: must be normal. Received: ${err}`),
    ),
  );
};

// --- GroupMode ---
export const GroupModes = ['no_group', 'points_races', 'battle_races'] as const;

export type GroupMode = (typeof GroupModes)[number];

export const validateGroupMode = (value: unknown): E.Either<Error, GroupMode> => {
  return pipe(
    value,
    E.fromPredicate(
      (v): v is GroupMode => GroupModes.includes(v as GroupMode),
      (err) =>
        new Error(
          `Invalid group mode: must be no_group, points_races, or battle_races. Received: ${err}`,
        ),
    ),
  );
};

// --- KnockoutMode ---
export const KnockoutModes = [
  'no_knockout',
  'single_elimination',
  'double_elimination',
  'head_to_head',
] as const;

export type KnockoutMode = (typeof KnockoutModes)[number];

export const validateKnockoutMode = (value: unknown): E.Either<Error, KnockoutMode> => {
  return pipe(
    value,
    E.fromPredicate(
      (v): v is KnockoutMode => KnockoutModes.includes(v as KnockoutMode),
      (err) =>
        new Error(
          `Invalid knockout mode: must be no_knockout, single_elimination, double_elimination, or head_to_head. Received: ${err}`,
        ),
    ),
  );
};

// --- TournamentState ---
export const TournamentStates = ['active', 'inactive', 'finished'] as const;

export type TournamentState = (typeof TournamentStates)[number];

export const validateTournamentState = (value: unknown): E.Either<Error, TournamentState> => {
  return pipe(
    value,
    E.fromPredicate(
      (v): v is TournamentState => TournamentStates.includes(v as TournamentState),
      (err) =>
        new Error(
          `Invalid tournament state: must be active, inactive, or finished. Received: ${err}`,
        ),
    ),
  );
};
