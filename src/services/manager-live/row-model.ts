import { findEventEligibleEntryIds } from '../../domain/entry-infos';
import type { EntryInfo } from '../../domain/entry-infos';

/**
 * Finalized manager-live data is scoped by event eligibility. An entry that
 * joined in a later gameweek is a valid tournament member but has no earlier
 * result row to fetch, so it must be excluded from the denominator.
 */
export const selectFinalizedManagerLiveEntryIds = (
  entryIds: readonly number[],
  entryInfos: ReadonlyArray<Pick<EntryInfo, 'id' | 'startedEvent'>>,
  eventId: number,
): { eligibleEntryIds: number[]; notApplicableEntryIds: number[] } => {
  const uniqueEntryIds = Array.from(new Set(entryIds));
  const eligible = new Set(findEventEligibleEntryIds(uniqueEntryIds, entryInfos, eventId));
  return {
    eligibleEntryIds: uniqueEntryIds.filter((entryId) => eligible.has(entryId)),
    notApplicableEntryIds: uniqueEntryIds.filter((entryId) => !eligible.has(entryId)),
  };
};
