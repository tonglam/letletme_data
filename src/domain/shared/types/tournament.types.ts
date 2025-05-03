import * as E from 'fp-ts/Either';
import { z } from 'zod';

// --- TournamentMode ---
export const TournamentModes = ['normal'] as const;

export type TournamentMode = (typeof TournamentModes)[number];

export const TournamentModeSchema = z.enum(TournamentModes);

export const validateTournamentMode = (value: unknown): E.Either<Error, TournamentMode> => {
  const result = TournamentModeSchema.safeParse(value);
  return result.success
    ? E.right(result.data)
    : E.left(new Error(`Invalid tournament mode. Received: ${value}`));
};

// --- GroupMode ---
export const GroupModes = ['no_group', 'points_races', 'battle_races'] as const;

export type GroupMode = (typeof GroupModes)[number];

export const GroupModeSchema = z.enum(GroupModes);

export const validateGroupMode = (value: unknown): E.Either<Error, GroupMode> => {
  const result = GroupModeSchema.safeParse(value);
  return result.success
    ? E.right(result.data)
    : E.left(new Error(`Invalid group mode. Received: ${value}`));
};

// --- KnockoutMode ---
export const KnockoutModes = [
  'no_knockout',
  'single_elimination',
  'double_elimination',
  'head_to_head',
] as const;

export type KnockoutMode = (typeof KnockoutModes)[number];

export const KnockoutModeSchema = z.enum(KnockoutModes);

export const validateKnockoutMode = (value: unknown): E.Either<Error, KnockoutMode> => {
  const result = KnockoutModeSchema.safeParse(value);
  return result.success
    ? E.right(result.data)
    : E.left(new Error(`Invalid knockout mode. Received: ${value}`));
};

// --- TournamentState ---
export const TournamentStates = ['active', 'inactive', 'finished'] as const;

export type TournamentState = (typeof TournamentStates)[number];

export const TournamentStateSchema = z.enum(TournamentStates);

export const validateTournamentState = (value: unknown): E.Either<Error, TournamentState> => {
  const result = TournamentStateSchema.safeParse(value);
  return result.success
    ? E.right(result.data)
    : E.left(new Error(`Invalid tournament state. Received: ${value}`));
};
