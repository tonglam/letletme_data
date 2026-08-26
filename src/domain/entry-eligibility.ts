/**
 * One eligibility rule is shared by entry, league, tournament and My FPL
 * denominators.  Keeping the rule here prevents a late entrant from being
 * reported as a missing historical row.
 */
export type EntryEligibilityInput = Readonly<{
  startedEvent: number | null | undefined;
  eventId: number;
}>;

export function isEntryEligibleForEvent(input: EntryEligibilityInput): boolean {
  if (!Number.isSafeInteger(input.eventId) || input.eventId < 1) return false;
  return input.startedEvent == null || input.startedEvent <= input.eventId;
}

export function classifyEntryEligibility(
  input: EntryEligibilityInput,
): 'ELIGIBLE' | 'NOT_APPLICABLE' {
  return isEntryEligibleForEvent(input) ? 'ELIGIBLE' : 'NOT_APPLICABLE';
}

export function countEntryEligibility(
  entries: readonly EntryEligibilityInput[],
): Readonly<{ eligibleCount: number; notApplicableCount: number }> {
  return entries.reduce(
    (counts, entry) => {
      if (isEntryEligibleForEvent(entry)) counts.eligibleCount += 1;
      else counts.notApplicableCount += 1;
      return counts;
    },
    { eligibleCount: 0, notApplicableCount: 0 },
  );
}

/** SQL fragment used by repositories that build denominator queries. */
export const ENTRY_EVENT_ELIGIBILITY_SQL =
  '("started_event" IS NULL OR "started_event" <= "event_id")' as const;
