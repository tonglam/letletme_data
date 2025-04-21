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

// --- Refactored ElementType ---

// Keep numeric IDs for potential DB storage / external API mapping
export enum ElementTypeId {
  GOALKEEPER = 1,
  DEFENDER = 2,
  MIDFIELDER = 3,
  FORWARD = 4,
  MANAGER = 5, // Assuming 5 is Manager based on previous enum
}

// Define the short names as a type
export type ElementTypeName = 'GKP' | 'DEF' | 'MID' | 'FWD' | 'MNG';

// Main configuration object mapping ID to Name
export const ElementTypeMap: Readonly<Record<ElementTypeId, ElementTypeName>> = {
  [ElementTypeId.GOALKEEPER]: 'GKP',
  [ElementTypeId.DEFENDER]: 'DEF',
  [ElementTypeId.MIDFIELDER]: 'MID',
  [ElementTypeId.FORWARD]: 'FWD',
  [ElementTypeId.MANAGER]: 'MNG',
};

// Helper to get the numeric ID from the enum value (might not be needed often)
// export const getElementTypeIdValue = (type: ElementTypeId): number => type;

// Updated helper to get enum member by numeric ID
export const getElementTypeById = (id: number): ElementTypeId | null => {
  // Check if the id is a valid value in the ElementTypeId enum
  if (Object.values(ElementTypeId).includes(id)) {
    return id as ElementTypeId;
  }
  return null;
};

// Updated helper to get short name string by enum ID
export const getElementTypeName = (typeId: ElementTypeId): ElementTypeName =>
  ElementTypeMap[typeId];

// --- End Refactored ElementType ---

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

// Update this array to use the new enum IDs
export const ELEMENT_TYPE_IDS: readonly ElementTypeId[] = [
  ElementTypeId.GOALKEEPER,
  ElementTypeId.DEFENDER,
  ElementTypeId.MIDFIELDER,
  ElementTypeId.FORWARD,
  ElementTypeId.MANAGER,
];
