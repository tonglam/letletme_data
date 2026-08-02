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

export function getPlayerValueSeasonFloorForDate(changeDate: string): string {
  if (!/^\d{8}$/.test(changeDate)) {
    throw new Error(`Invalid player value change date: ${changeDate}`);
  }

  const year = Number.parseInt(changeDate.slice(0, 4), 10);
  const month = Number.parseInt(changeDate.slice(4, 6), 10);
  if (month < 1 || month > 12) {
    throw new Error(`Invalid player value change date: ${changeDate}`);
  }

  return `${seasonStartYear(year, month, 6)}0601`;
}
