/**
 * Resolve the cumulative score immediately before an event.
 *
 * FPL's entry-history payload normally lets us derive the previous total from
 * `total_points - (points - event_transfers_cost)`.  A newly-created entry can
 * temporarily return a cumulative total below its current event net points,
 * though.  That value would produce a negative historical baseline and make a
 * final publication impossible even when the event picks/live evidence is
 * complete.  In that case callers may supply the last persisted checked total;
 * for a first eligible event, zero is the only valid baseline.
 */
export type EntryScoreBaselineInput = Readonly<{
  sourceTotalPoints: number;
  sourceEventPoints: number;
  eventTransfersCost: number;
  persistedPreviousOverallPoints?: number | null;
}>;

export type EntryScoreBaseline = Readonly<{
  previousOverallPoints: number;
  sourcePreviousOverallPoints: number;
  usedPersistedFallback: boolean;
}>;

export function resolveEntryScoreBaseline(input: EntryScoreBaselineInput): EntryScoreBaseline {
  const sourcePreviousOverallPoints =
    input.sourceTotalPoints - (input.sourceEventPoints - input.eventTransfersCost);
  if (Number.isSafeInteger(sourcePreviousOverallPoints) && sourcePreviousOverallPoints >= 0) {
    return {
      previousOverallPoints: sourcePreviousOverallPoints,
      sourcePreviousOverallPoints,
      usedPersistedFallback: false,
    };
  }

  const persistedPreviousOverallPoints = input.persistedPreviousOverallPoints;
  if (
    persistedPreviousOverallPoints !== null &&
    persistedPreviousOverallPoints !== undefined &&
    Number.isSafeInteger(persistedPreviousOverallPoints) &&
    persistedPreviousOverallPoints >= 0
  ) {
    return {
      previousOverallPoints: persistedPreviousOverallPoints,
      sourcePreviousOverallPoints,
      usedPersistedFallback: true,
    };
  }

  return {
    previousOverallPoints: 0,
    sourcePreviousOverallPoints,
    usedPersistedFallback: true,
  };
}
