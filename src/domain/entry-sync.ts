import type { EntrySyncExecutionIntent, EntrySyncJobName } from '../queues/entry-sync.queue';
import { findEventEligibleEntryIds, type EntryInfo } from './entry-infos';

type EventFinalizationState = {
  finished: boolean;
  dataChecked: boolean;
  dataCheckedAt: Date | null;
};

/** Resolve the source intent that a successful scan continuation must carry. */
export function resolveEntrySyncExecutionIntent(
  source: string | undefined,
): EntrySyncExecutionIntent {
  if (source === 'manual' || source === 'api') return 'force';
  if (source === 'reconcile' || source === 'catchup') return 'reconcile';
  return 'refresh';
}

export function isReusableEntryPicksHeadForRetry(
  head: {
    state: string;
    rowCount: number;
    sourceCheckedAt: Date | string;
    sourceCheckedAtExact?: string;
  },
  requestWatermark: string | undefined,
): boolean {
  if (!requestWatermark || head.state !== 'COMPLETE' || head.rowCount !== 15) return false;
  const watermarkMs = new Date(requestWatermark).getTime();
  const sourceCheckedAtMs = new Date(head.sourceCheckedAtExact ?? head.sourceCheckedAt).getTime();
  return Number.isFinite(watermarkMs) && Number.isFinite(sourceCheckedAtMs)
    ? sourceCheckedAtMs >= watermarkMs
    : false;
}

export function isExplicitEntryRepairRequest(
  jobData:
    | {
        entryIds?: readonly number[];
        retryCount?: number;
        executionIntent?: string;
      }
    | undefined,
): boolean {
  return (
    jobData?.entryIds !== undefined &&
    jobData.executionIntent !== 'retry' &&
    (jobData.retryCount ?? 0) === 0
  );
}

export function shouldRefreshEntryInfoFromSource(
  jobData:
    | {
        source?: string;
        entryIds?: readonly number[];
        retryCount?: number;
        executionIntent?: string;
        obligationId?: string;
      }
    | undefined,
): boolean {
  if (jobData?.executionIntent === 'retry' || (jobData?.retryCount ?? 0) > 0) return false;
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
  jobData:
    | {
        source?: string;
        entryIds?: readonly number[];
        retryCount?: number;
        executionIntent?: string;
      }
    | undefined,
): boolean {
  if (jobData?.executionIntent === 'retry' || (jobData?.retryCount ?? 0) > 0) return false;
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
