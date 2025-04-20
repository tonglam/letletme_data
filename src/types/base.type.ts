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
  H2H = 'H2H',
}

export enum ElementStatus {
  Available = 'a',
  Unavailable = 'u',
  Injured = 'i',
  Suspended = 's',
  NotAvailable = 'n',
  Departed = 'd',
}

export enum ElementType {
  GOALKEEPER = 1,
  DEFENDER = 2,
  MIDFIELDER = 3,
  FORWARD = 4,
  MANAGER = 5,
}

export const ElementTypeConfig = {
  [ElementType.GOALKEEPER]: { id: ElementType.GOALKEEPER, name: 'GK' },
  [ElementType.DEFENDER]: { id: ElementType.DEFENDER, name: 'DEF' },
  [ElementType.MIDFIELDER]: { id: ElementType.MIDFIELDER, name: 'MID' },
  [ElementType.FORWARD]: { id: ElementType.FORWARD, name: 'FWD' },
  [ElementType.MANAGER]: { id: ElementType.MANAGER, name: 'MNG' },
} as const;

export const getElementTypeById = (id: number): ElementType | null => {
  switch (id) {
    case ElementType.GOALKEEPER:
      return ElementType.GOALKEEPER;
    case ElementType.DEFENDER:
      return ElementType.DEFENDER;
    case ElementType.MIDFIELDER:
      return ElementType.MIDFIELDER;
    case ElementType.FORWARD:
      return ElementType.FORWARD;
    case ElementType.MANAGER:
      return ElementType.MANAGER;
    default:
      return null;
  }
};

export const getElementTypeName = (type: ElementType): string => ElementTypeConfig[type].name;

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

export const ELEMENT_TYPES: readonly ElementType[] = [
  ElementType.GOALKEEPER,
  ElementType.DEFENDER,
  ElementType.MIDFIELDER,
  ElementType.FORWARD,
  ElementType.MANAGER,
];
