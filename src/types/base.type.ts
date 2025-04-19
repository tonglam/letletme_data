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

export enum Season {
  Season_1617 = '1617',
  Season_1718 = '1718',
  Season_1819 = '1819',
  Season_1920 = '1920',
  Season_2021 = '2021',
  Season_2122 = '2122',
  Season_2223 = '2223',
  Season_2324 = '2324',
  Season_2425 = '2425',
}

export const getCurrentSeason = (): string => {
  const currentDate = new Date();
  const currentYear = currentDate.getFullYear();
  const currentMonth = currentDate.getMonth() + 1;

  const startYear = currentMonth >= 8 ? currentYear : currentYear - 1;
  const endYear = startYear + 1;
  const startYearStr = startYear.toString().slice(-2);
  const endYearStr = endYear.toString().slice(-2);
  return `${startYearStr}${endYearStr}`;
};

export const getAllSeasons = (): Season[] => Object.values(Season);
