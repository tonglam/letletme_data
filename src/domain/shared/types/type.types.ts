import * as E from 'fp-ts/Either';
import { z } from 'zod';

// --- PlayerTypeID ---
export const PlayerTypeIDs = [1, 2, 3, 4, 5] as const;

export type PlayerTypeID = (typeof PlayerTypeIDs)[number];

export const PlayerTypeNames = ['GKP', 'DEF', 'MID', 'FWD', 'MNG'] as const;

export type PlayerTypeName = (typeof PlayerTypeNames)[number];

export const PlayerTypeMap = {
  idToName: {
    1: 'GKP',
    2: 'DEF',
    3: 'MID',
    4: 'FWD',
    5: 'MNG',
  } as const satisfies Record<PlayerTypeID, PlayerTypeName>,

  nameToId: {
    GKP: 1,
    DEF: 2,
    MID: 3,
    FWD: 4,
    MNG: 5,
  } as const satisfies Record<PlayerTypeName, PlayerTypeID>,
};

export const PlayerTypeIDSchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
]);

export const PlayerTypeNameSchema = z.enum(PlayerTypeNames);

export const validatePlayerTypeId = (value: unknown): E.Either<Error, PlayerTypeID> => {
  const result = PlayerTypeIDSchema.safeParse(value);
  return result.success
    ? E.right(result.data)
    : E.left(new Error(`Invalid player type ID: must be 1-5. Received: ${value}`));
};

export const validatePlayerTypeName = (value: unknown): E.Either<Error, PlayerTypeName> => {
  const result = PlayerTypeNameSchema.safeParse(value);
  return result.success
    ? E.right(result.data)
    : E.left(
        new Error(
          `Invalid player type name: must be GKP, DEF, MID, FWD, or MNG. Received: ${value}`,
        ),
      );
};

export const mapPlayerTypeIdToName = (id: PlayerTypeID): PlayerTypeName => {
  return PlayerTypeMap.idToName[id];
};

export const mapPlayerTypeNameToId = (name: PlayerTypeName): PlayerTypeID => {
  return PlayerTypeMap.nameToId[name];
};

export const getAllPlayerTypeIds = (): PlayerTypeID[] => {
  return Object.keys(PlayerTypeMap.idToName).map(Number) as PlayerTypeID[];
};

export const getAllPlayerTypeNames = (): PlayerTypeName[] => {
  return Object.keys(PlayerTypeMap.nameToId) as PlayerTypeName[];
};

// --- LeagueType ---
export const LeagueTypes = ['Classic', 'H2H'] as const;

export type LeagueType = (typeof LeagueTypes)[number];

export const LeagueTypeSchema = z.enum(LeagueTypes);

export const validateLeagueType = (value: unknown): E.Either<Error, LeagueType> => {
  const result = LeagueTypeSchema.safeParse(value);
  return result.success
    ? E.right(result.data)
    : E.left(new Error(`Invalid league type: must be Classic or H2H. Received: ${value}`));
};

// --- ValueChangeType ---
export const ValueChangeTypes = ['start', 'rise', 'fall'] as const;

export type ValueChangeType = (typeof ValueChangeTypes)[number];

export const ValueChangeTypeSchema = z.enum(ValueChangeTypes);

export const validateValueChangeType = (value: unknown): E.Either<Error, ValueChangeType> => {
  const result = ValueChangeTypeSchema.safeParse(value);
  return result.success
    ? E.right(result.data)
    : E.left(
        new Error(
          `Invalid value change type: must be one of start, rise, or fall. Received: ${value}`,
        ),
      );
};

export const determineValueChangeType = (oldValue: number, newValue: number): ValueChangeType => {
  if (oldValue > newValue) {
    return 'fall';
  } else if (oldValue < newValue) {
    return 'rise';
  } else {
    return 'start';
  }
};
