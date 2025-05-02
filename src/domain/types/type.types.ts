import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';

// --- PlayerTypeID ---
export type PlayerTypeID = 1 | 2 | 3 | 4 | 5;

export type PlayerTypeName = 'GKP' | 'DEF' | 'MID' | 'FWD' | 'MNG';

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

export const validatePlayerTypeId = (value: unknown): E.Either<string, PlayerTypeID> => {
  return pipe(
    value,
    E.fromPredicate(
      (v): v is PlayerTypeID => typeof v === 'number' && v in PlayerTypeMap.idToName,
      () => 'Invalid player type ID: must be a number between 1 and 5',
    ),
  );
};

export const validatePlayerTypeName = (value: unknown): E.Either<string, PlayerTypeName> => {
  return pipe(
    value,
    E.fromPredicate(
      (v): v is PlayerTypeName => typeof v === 'string' && v in PlayerTypeMap.nameToId,
      () => 'Invalid player type name: must be GKP, DEF, MID, FWD, or MNG',
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
export type LeagueType = 'Classic' | 'H2H';

export const LeagueTypes: LeagueType[] = ['Classic', 'H2H'];

export const validateLeagueType = (value: unknown): E.Either<string, LeagueType> => {
  return pipe(
    value,
    E.fromPredicate(
      (v): v is LeagueType => typeof v === 'string' && LeagueTypes.includes(v as LeagueType),
      () => 'Invalid league type: must be Classic or H2H',
    ),
  );
};

// --- ValueChangeType ---
export type ValueChangeType = 'start' | 'rise' | 'fall';

export const ValueChangeTypes: ValueChangeType[] = ['start', 'rise', 'fall'];

export const validateValueChangeType = (value: unknown): E.Either<string, ValueChangeType> => {
  return pipe(
    value,
    E.fromPredicate(
      (v): v is ValueChangeType =>
        typeof v === 'string' && ValueChangeTypes.includes(v as ValueChangeType),
      () => 'Invalid value change type: must be one of start, rise, or fall',
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
