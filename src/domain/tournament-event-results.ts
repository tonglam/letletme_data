export type TournamentEventResultsSummary = {
  totalEntries: number;
};

export type TournamentEventFinalizationState = {
  finished?: boolean;
  dataChecked?: boolean;
  dataCheckedAt?: Date | null;
};

/**
 * Tournament derived reports consume the finalized event-live authority. A
 * post-match provisional result row is useful for entry history, but it must
 * not open a cascade whose transfer stage requires finalized event-live rows.
 */
export function isTournamentCascadeFinalizedEvent(
  event: TournamentEventFinalizationState | null | undefined,
): boolean {
  return event?.finished === true && event.dataChecked === true && event.dataCheckedAt != null;
}

export function shouldEnqueueTournamentCascade(result: TournamentEventResultsSummary): boolean {
  return result.totalEntries > 0;
}
