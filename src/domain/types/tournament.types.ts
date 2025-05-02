import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';

// --- TournamentMode ---
export type TournamentMode = 'normal';

export const TournamentModes: TournamentMode[] = ['normal'];

export const validateTournamentMode = (value: unknown): E.Either<string, TournamentMode> => {
  return pipe(
    value,
    E.fromPredicate(
      (v): v is TournamentMode =>
        typeof v === 'string' && TournamentModes.includes(v as TournamentMode),
      () => 'Invalid tournament mode: must be normal',
    ),
  );
};

// --- GroupMode ---
export type GroupMode = 'no_group' | 'points_races' | 'battle_races';

export const GroupModes: GroupMode[] = ['no_group', 'points_races', 'battle_races'];

export const validateGroupMode = (value: unknown): E.Either<string, GroupMode> => {
  return pipe(
    value,
    E.fromPredicate(
      (v): v is GroupMode => GroupModes.includes(v as GroupMode),
      () => 'Invalid group mode: must be no_group, points_races, or battle_races',
    ),
  );
};

// --- KnockoutMode ---
export type KnockoutMode =
  | 'no_knockout'
  | 'single_elimination'
  | 'double_elimination'
  | 'head_to_head';

export const KnockoutModes: KnockoutMode[] = [
  'no_knockout',
  'single_elimination',
  'double_elimination',
  'head_to_head',
];

export const validateKnockoutMode = (value: unknown): E.Either<string, KnockoutMode> => {
  return pipe(
    value,
    E.fromPredicate(
      (v): v is KnockoutMode => KnockoutModes.includes(v as KnockoutMode),
      () =>
        'Invalid knockout mode: must be no_knockout, single_elimination, double_elimination, or head_to_head',
    ),
  );
};

// --- TournamentState ---
export type TournamentState = 'active' | 'inactive' | 'finished';

export const TournamentStates: TournamentState[] = ['active', 'inactive', 'finished'];

export const validateTournamentState = (value: unknown): E.Either<string, TournamentState> => {
  return pipe(
    value,
    E.fromPredicate(
      (v): v is TournamentState => TournamentStates.includes(v as TournamentState),
      () => 'Invalid tournament state: must be active, inactive, or finished',
    ),
  );
};
