function seasonStartYear(year: number, month: number, boundaryMonth: number): number {
  return month >= boundaryMonth ? year : year - 1;
}

/**
 * player_values is date-keyed and has no season column. June 1 is the stable
 * post-season boundary before a new FPL bootstrap can publish its roster.
 */
export function getPlayerValueSeasonFloor(deadlineTime: string | null): string {
  if (!deadlineTime) {
    throw new Error('Player value season cannot be resolved without an event deadline');
  }

  const deadline = new Date(deadlineTime);
  if (Number.isNaN(deadline.getTime())) {
    throw new Error(`Invalid event deadline for player value season: ${deadlineTime}`);
  }

  return `${seasonStartYear(deadline.getUTCFullYear(), deadline.getUTCMonth() + 1, 7)}0601`;
}

export function getPlayerValueSeasonBounds(deadlineTime: string | null): {
  fromChangeDate: string;
  beforeChangeDate: string;
} {
  const fromChangeDate = getPlayerValueSeasonFloor(deadlineTime);
  const startYear = Number.parseInt(fromChangeDate.slice(0, 4), 10);
  return {
    fromChangeDate,
    beforeChangeDate: `${startYear + 1}0601`,
  };
}
