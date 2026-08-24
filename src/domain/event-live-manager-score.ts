export type EventLiveManagerPick = {
  entryId: number;
  position: number;
  elementId: number;
  multiplier: number;
  isCaptain: boolean;
  isViceCaptain: boolean;
  transfersCost: number | null;
  sourceUpdatedAt: Date;
};

export type EventLiveManagerScore = {
  entryId: number;
  eventPoints: number;
  netEventPoints: number;
  transferCost: number;
  picksCheckedAt: string;
};

/**
 * Build one manager score from official picks and official event-live player
 * totals. Multipliers already include captain, Triple Captain, Bench Boost and
 * finalized substitution semantics, so no local lineup inference is allowed.
 */
export function deriveEventLiveManagerScore(
  entryId: number,
  picks: readonly EventLiveManagerPick[],
  pointsByElement: ReadonlyMap<number, number>,
): EventLiveManagerScore | null {
  if (picks.length !== 15 || picks.some((pick) => pick.entryId !== entryId)) return null;

  const positions = new Set<number>();
  const elements = new Set<number>();
  const sourceTimestamps = new Set<number>();
  let captainCount = 0;
  let viceCaptainCount = 0;
  let transferCost: number | null = null;
  let eventPoints = 0;

  for (const pick of picks) {
    if (
      !Number.isSafeInteger(pick.position) ||
      pick.position < 1 ||
      pick.position > 15 ||
      positions.has(pick.position) ||
      !Number.isSafeInteger(pick.elementId) ||
      pick.elementId <= 0 ||
      elements.has(pick.elementId) ||
      !Number.isSafeInteger(pick.multiplier) ||
      pick.multiplier < 0 ||
      pick.multiplier > 3 ||
      !Number.isFinite(pick.sourceUpdatedAt.getTime())
    ) {
      return null;
    }

    const playerPoints = pointsByElement.get(pick.elementId);
    if (typeof playerPoints !== 'number' || !Number.isSafeInteger(playerPoints)) return null;

    positions.add(pick.position);
    elements.add(pick.elementId);
    sourceTimestamps.add(pick.sourceUpdatedAt.getTime());
    if (pick.isCaptain) captainCount += 1;
    if (pick.isViceCaptain) viceCaptainCount += 1;
    if (pick.transfersCost !== null) {
      if (
        !Number.isSafeInteger(pick.transfersCost) ||
        pick.transfersCost < 0 ||
        (transferCost !== null && transferCost !== pick.transfersCost)
      ) {
        return null;
      }
      transferCost = pick.transfersCost;
    }
    eventPoints += playerPoints * pick.multiplier;
  }

  if (
    positions.size !== 15 ||
    elements.size !== 15 ||
    captainCount !== 1 ||
    viceCaptainCount !== 1 ||
    sourceTimestamps.size !== 1 ||
    transferCost === null
  ) {
    return null;
  }

  const picksCheckedAt = new Date([...sourceTimestamps][0]!).toISOString();
  return {
    entryId,
    eventPoints,
    netEventPoints: eventPoints - transferCost,
    transferCost,
    picksCheckedAt,
  };
}
