import * as E from 'fp-ts/Either';

export enum Chip {
  None = 'n/a',
  Wildcard = 'wildcard',
  FreeHit = 'freehit',
  TripleCaptain = '3xc',
  BenchBoost = 'bb',
  Manager = 'mng',
}

export enum ValueChangeType {
  Start = 'Start',
  Rise = 'Rise',
  Fall = 'Fall',
}

export enum LeagueType {
  Classic = 'Classic',
  H2h = 'H2h',
}

export enum ElementStatus {
  Available = 'a',
  Unavailable = 'u',
  Injured = 'i',
  Suspended = 's',
  NotAvailable = 'n',
  Departed = 'd',
}

export enum ElementTypeId {
  GOALKEEPER = 1,
  DEFENDER = 2,
  MIDFIELDER = 3,
  FORWARD = 4,
  MANAGER = 5,
}

export type ElementTypeName = 'GKP' | 'DEF' | 'MID' | 'FWD' | 'MNG';

export const ElementTypeMap: Readonly<Record<ElementTypeId, ElementTypeName>> = {
  [ElementTypeId.GOALKEEPER]: 'GKP',
  [ElementTypeId.DEFENDER]: 'DEF',
  [ElementTypeId.MIDFIELDER]: 'MID',
  [ElementTypeId.FORWARD]: 'FWD',
  [ElementTypeId.MANAGER]: 'MNG',
};

export const getElementTypeIdValue = (type: ElementTypeId): number => type;

export const getElementTypeById = (id: number): ElementTypeId | null => {
  if (Object.values(ElementTypeId).includes(id)) {
    return id as ElementTypeId;
  }
  return null;
};

export const getElementTypeName = (typeId: ElementTypeId): ElementTypeName =>
  ElementTypeMap[typeId];

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

export const ELEMENT_TYPE_IDS: readonly ElementTypeId[] = [
  ElementTypeId.GOALKEEPER,
  ElementTypeId.DEFENDER,
  ElementTypeId.MIDFIELDER,
  ElementTypeId.FORWARD,
  ElementTypeId.MANAGER,
];

export enum TournamentMode {
  Normal = 'Normal',
}

export enum GroupMode {
  NoGroup = 'NoGroup',
  PointsRaces = 'PointsRaces',
  BattleRaces = 'BattleRaces',
}

export enum KnockoutMode {
  NoKnockout = 'NoKnockout',
  SingleElimination = 'SingleElimination',
  DoubleElimination = 'DoubleElimination',
  HeadToHead = 'HeadToHead',
}

export enum TournamentState {
  Active = 'Active',
  Inactive = 'Inactive',
  Finished = 'Finished',
}
