import type { EntrySyncExecutionIntent, EntrySyncJobName } from '../queues/entry-sync.queue';
import { findEventEligibleEntryIds, type EntryInfo } from './entry-infos';

type EventFinalizationState = {
  finished: boolean;
  dataChecked: boolean;
  dataCheckedAt: Date | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isVerifiedFinalInputPayload(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.finalResult)) return false;
  const finalResult = value.finalResult;
  if (
    typeof finalResult.revision !== 'string' ||
    !/^[0-9a-f]{64}$/.test(finalResult.revision) ||
    !isRecord(finalResult.score) ||
    !Number.isSafeInteger(finalResult.score.eventPoints) ||
    (finalResult.score.totalPoints !== null &&
      !Number.isSafeInteger(finalResult.score.totalPoints)) ||
    !Array.isArray(finalResult.picks) ||
    finalResult.picks.length !== 15 ||
    !Array.isArray(finalResult.automaticSubs)
  ) {
    return false;
  }
  const positions = new Set<number>();
  return finalResult.picks.every((pick) => {
    if (!isRecord(pick)) return false;
    const position = pick.position as number;
    const element = pick.element as number;
    const multiplier = pick.multiplier as number;
    if (
      !Number.isSafeInteger(position) ||
      position < 1 ||
      position > 15 ||
      positions.has(position) ||
      !Number.isSafeInteger(element) ||
      element <= 0 ||
      !Number.isSafeInteger(multiplier) ||
      multiplier < 0 ||
      multiplier > 3 ||
      typeof pick.isCaptain !== 'boolean' ||
      typeof pick.isViceCaptain !== 'boolean'
    ) {
      return false;
    }
    positions.add(position);
    return true;
  });
}

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
    inputPayload?: unknown | null;
  },
  requestWatermark: string | undefined,
): boolean {
  if (!requestWatermark || head.state !== 'COMPLETE' || head.rowCount !== 15) return false;
  const normalizeExact = (value: string): string | null => {
    const trimmed = value.trim();
    const exact = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(trimmed);
    if (exact) {
      const fraction = (exact[2] ?? '').padEnd(6, '0').slice(0, 6);
      return `${exact[1]}.${fraction}Z`;
    }
    const date = new Date(trimmed);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  };
  const watermark = normalizeExact(requestWatermark);
  const sourceCheckedAt = normalizeExact(
    head.sourceCheckedAtExact ??
      (head.sourceCheckedAt instanceof Date
        ? head.sourceCheckedAt.toISOString()
        : String(head.sourceCheckedAt)),
  );
  if (watermark === null || sourceCheckedAt === null) return false;
  // A FINAL input is an immutable, already-verified source observation.  Its
  // original source watermark is intentionally frozen at finalization and
  // therefore may predate a later retry watermark.  Requiring that frozen
  // timestamp to advance would keep a successful retry in the missing set
  // forever because FINAL persistence correctly refuses to rewrite it.
  if (isVerifiedFinalInputPayload(head.inputPayload)) return true;
  // PostgreSQL ordering timestamps are normalized UTC strings with six
  // fractional digits. Lexical comparison preserves microseconds; converting
  // them through Date would truncate the last three digits and can incorrectly
  // reuse a stale head captured in the same millisecond.
  return watermark !== null && sourceCheckedAt !== null && sourceCheckedAt >= watermark;
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
