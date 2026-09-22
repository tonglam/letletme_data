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

/**
 * FPL represents an entry that has not received an overall ranking yet with a
 * nullable event rank and a zero overall rank.  A nullable rank is not a
 * publishable value, so preserve the source semantic as the explicit rank
 * sentinel `0` only when the same source payload also reports a zero
 * cumulative total.  Normal ranked rows (and rows with a non-zero cumulative
 * total) remain nullable and are rejected by finalization until FPL supplies
 * an authoritative rank.
 */
export function normalizeAuthoritativeUnrankedEventRank(input: {
  rank: number | null | undefined;
  overallRank: number | null | undefined;
  sourceTotalPoints: number | null | undefined;
}): number | null {
  if (input.rank !== null && input.rank !== undefined) return input.rank;
  return input.sourceTotalPoints === 0 && input.overallRank === 0 ? 0 : null;
}

/**
 * FPL keeps deleted entries in the current-season feed. The entry summary can
 * retain a non-negative cumulative score, while the finalized history row
 * reports either the normalized zero-total/zero-rank sentinel or a non-zero
 * cumulative total with a nullable event rank. The entry identity is the
 * durable discriminator available to us (`Deleted` / `Deleted Player`).
 */
export function isAuthoritativeUnrankedDeletedEntryResult(
  input: Readonly<{
    entryName: string;
    playerName: string;
    identityOverallPoints: number | null;
    identityOverallRank: number | null;
    resultOverallPoints: number | null;
    eventRank: number | null;
    overallRank: number | null;
  }>,
): boolean {
  const nonNegativeSafeInteger = (value: number | null): value is number =>
    value !== null && Number.isSafeInteger(value) && value >= 0;

  return (
    input.entryName.trim() === 'Deleted' &&
    input.playerName.trim() === 'Deleted Player' &&
    nonNegativeSafeInteger(input.identityOverallPoints) &&
    input.identityOverallRank === 0 &&
    nonNegativeSafeInteger(input.resultOverallPoints) &&
    input.overallRank === 0 &&
    ((input.resultOverallPoints === 0 && input.eventRank === 0) ||
      (input.resultOverallPoints > 0 && input.eventRank === null))
  );
}

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
