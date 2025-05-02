import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';

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

export const validatePlayerTypeId = (value: unknown): E.Either<Error, PlayerTypeID> => {
  return pipe(
    value,
    E.fromPredicate(
      (v): v is PlayerTypeID => typeof v === 'number' && v in PlayerTypeMap.idToName,
      (err) =>
        new Error(`Invalid player type ID: must be a number between 1 and 5. Received: ${err}`),
    ),
  );
};

export const validatePlayerTypeName = (value: unknown): E.Either<Error, PlayerTypeName> => {
  return pipe(
    value,
    E.fromPredicate(
      (v): v is PlayerTypeName => typeof v === 'string' && v in PlayerTypeMap.nameToId,
      (err) =>
        new Error(`Invalid player type name: must be GKP, DEF, MID, FWD, or MNG. Received: ${err}`),
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

export const validateLeagueType = (value: unknown): E.Either<Error, LeagueType> => {
  return pipe(
    value,
    E.fromPredicate(
      (v): v is LeagueType => typeof v === 'string' && LeagueTypes.includes(v as LeagueType),
      (err) => new Error(`Invalid league type: must be Classic or H2H. Received: ${err}`),
    ),
  );
};

// --- ValueChangeType ---
export const ValueChangeTypes = ['start', 'rise', 'fall'] as const;

export type ValueChangeType = (typeof ValueChangeTypes)[number];

export const validateValueChangeType = (value: unknown): E.Either<Error, ValueChangeType> => {
  return pipe(
    value,
    E.fromPredicate(
      (v): v is ValueChangeType =>
        typeof v === 'string' && ValueChangeTypes.includes(v as ValueChangeType),
      (err) =>
        new Error(
          `Invalid value change type: must be one of start, rise, or fall. Received: ${err}`,
        ),
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
