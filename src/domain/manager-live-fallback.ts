const MAX_FOREGROUND_SUMMARY_FETCHES = 4;

export const planClassicManagerFallback = (
  pendingEntryIds: readonly number[],
  standingsComplete: boolean,
): Readonly<{
  foregroundSummaryEntryIds: readonly number[];
  backgroundEntryIds: readonly number[];
  continueStandings: boolean;
}> => ({
  // Once standings pagination is exhausted, a roster member can still be in
  // FPL's new-entries lane. Use the official entry summary instead of leaving
  // that manager unavailable for the entire gameweek.
  foregroundSummaryEntryIds: standingsComplete
    ? pendingEntryIds.slice(0, MAX_FOREGROUND_SUMMARY_FETCHES)
    : [],
  backgroundEntryIds: pendingEntryIds,
  continueStandings: !standingsComplete,
});
