import type { EntrySyncJobName } from '../queues/entry-sync.queue';
import { findEventEligibleEntryIds, type EntryInfo } from './entry-infos';

type EventFinalizationState = {
  finished: boolean;
  dataChecked: boolean;
  dataCheckedAt: Date | null;
};

export function isExplicitEntryRepairRequest(
  jobData: { entryIds?: readonly number[] } | undefined,
): boolean {
  return jobData?.entryIds !== undefined;
}

export function isCronEntryInfoTableScan(
  jobData: { source?: string; entryIds?: readonly number[] } | undefined,
): boolean {
  return jobData?.source === 'cron' && jobData.entryIds === undefined;
}

export function shouldRefreshEntryPicks(
  jobData: { source?: string; entryIds?: readonly number[] } | undefined,
): boolean {
  return jobData?.source === 'cron' || isExplicitEntryRepairRequest(jobData);
}

export function planEventEligibleEntrySyncWork(
  entryIds: readonly number[],
  entryInfos: ReadonlyArray<Pick<EntryInfo, 'id' | 'startedEvent'>>,
  eventId: number,
): { eligibleEntryIds: number[]; skippedUnits: number } {
  const eligibleEntryIds = findEventEligibleEntryIds(entryIds, entryInfos, eventId);
  return {
    eligibleEntryIds,
    skippedUnits: entryIds.length - eligibleEntryIds.length,
  };
}

export function resolveRichResultFreshnessCutoff(
  event: EventFinalizationState | null,
): Date | null {
  return event?.finished && event.dataChecked ? event.dataCheckedAt : null;
}

export async function resolveEntrySyncTargetEventId(
  jobName: EntrySyncJobName,
  requestedEventId: number | undefined,
  findCurrentEventId: () => Promise<number | null>,
): Promise<number | undefined> {
  if (jobName === 'entry-info' || requestedEventId !== undefined) {
    return requestedEventId;
  }

  const currentEventId = await findCurrentEventId();
  if (currentEventId === null) {
    throw new Error('No current event found');
  }
  return currentEventId;
}
