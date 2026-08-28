const positiveSeasonId = (seasonId: number): number => {
  if (!Number.isSafeInteger(seasonId) || seasonId <= 0) {
    throw new Error('My FPL advisory lock season must be a positive safe integer');
  }
  return seasonId;
};

export const myFplSnapshotSeasonLockScope = (seasonId: number): string =>
  `my-fpl-season:${positiveSeasonId(seasonId)}`;

export const myFplSnapshotEventLockScope = (seasonId: number, eventId: number): string => {
  positiveSeasonId(seasonId);
  if (!Number.isSafeInteger(eventId) || eventId <= 0) {
    throw new Error('My FPL advisory lock event must be a positive safe integer');
  }
  return `my-fpl:${seasonId}:${eventId}`;
};
