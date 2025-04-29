import * as E from 'fp-ts/Either';
import { z } from 'zod';

export const Chips = ['n/a', 'wildcard', 'freehit', '3xc', 'bboost', 'manager'] as const;
export type Chip = (typeof Chips)[number];

export const ValueChangeTypes = ['start', 'rise', 'fall'] as const;
export type ValueChangeType = (typeof ValueChangeTypes)[number];

export const LeagueTypes = ['classic', 'h2h'] as const;
export type LeagueType = (typeof LeagueTypes)[number];

export const ElementStatus = ['a', 'u', 'i', 's', 'n', 'd'] as const;
export type ElementStatus = (typeof ElementStatus)[number];

export const TournamentModes = ['normal'] as const;
export type TournamentMode = (typeof TournamentModes)[number];

export const GroupModes = ['no_group', 'points_races', 'battle_races'] as const;
export type GroupMode = (typeof GroupModes)[number];

export const KnockoutModes = [
  'no_knockout',
  'single_elimination',
  'double_elimination',
  'head_to_head',
] as const;
export type KnockoutMode = (typeof KnockoutModes)[number];

export const TournamentStates = ['active', 'inactive', 'finished'] as const;
export type TournamentState = (typeof TournamentStates)[number];

export enum ElementType {
  GKP = 1,
  DEF = 2,
  MID = 3,
  FWD = 4,
  MNG = 5,
}

export const ElementTypeIds = Object.values(ElementType).filter(
  (v): v is number => typeof v === 'number',
) as ReadonlyArray<ElementType>;
export type ElementTypeId = (typeof ElementTypeIds)[number];

export const ElementTypeNames = Object.fromEntries(
  Object.entries(ElementType).map(([key, value]) => [value, key]),
) as Record<ElementType, string>;
export type ElementTypeName = (typeof ElementTypeNames)[keyof typeof ElementTypeNames];

export interface Brand<K extends string> {
  readonly __brand: K;
}

export type Branded<T, K extends string> = T & Brand<K>;

export const createBrandedType = <T, K extends string>(
  brand: K,
  validator: (value: unknown) => value is T,
) => ({
  validate: (value: unknown): E.Either<string, Branded<T, K>> =>
    validator(value) ? E.right(value as Branded<T, K>) : E.left(`Invalid ${brand}: ${value}`),
  is: (value: unknown): value is Branded<T, K> => validator(value),
});

export const GameSettingsSchema = z.object({
  league_join_private_max: z.number(),
});
