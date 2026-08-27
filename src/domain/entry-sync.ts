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

export function shouldRefreshEntryInfoFromSource(
  jobData:
    | {
        source?: string;
        entryIds?: readonly number[];
        retryCount?: number;
        obligationId?: string;
      }
    | undefined,
): boolean {
  const isRoutineCapture =
    (jobData?.source === 'catchup' || jobData?.source === 'reconcile') &&
    jobData.obligationId === undefined;
  if (isRoutineCapture && (jobData?.retryCount ?? 0) > 0) return false;
  if (jobData?.entryIds !== undefined) return true;
  if (jobData?.source === 'cron' || jobData?.source === 'manual') return true;

  // Standalone scheduler jobs use `catchup` as their source, but carry the
  // durable obligation through every scan chunk and retry. Entry identity is
  // mutable even when the GW snapshot checkpoint is already complete, so a
  // scheduled full scan must still read the upstream summary.
  return jobData?.obligationId !== undefined;
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

/**
 * Finalized source data is immutable at the FPL data_checked fence.  Replays
 * must therefore use that persisted checkpoint as their lower freshness bound
 * instead of the coordinator's wall clock.  This lets a finalization retry
 * reuse rows already captured after the authoritative fence while still
 * refreshing any row that genuinely predates it.
 */
export function resolveFinalizationFreshAfter(event: EventFinalizationState | null): string | null {
  return resolveRichResultFreshnessCutoff(event)?.toISOString() ?? null;
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
