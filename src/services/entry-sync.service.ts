import {
  syncEntryEventPicks,
  syncEntryEventResults,
  syncEntryEventTransfers,
} from './entries.service';
import { logError } from '../utils/logger';

export type EntrySyncHandler = (entryId: number, eventId?: number) => Promise<unknown>;

export type EntrySyncItemResult = {
  entryId: number;
  ok: boolean;
  error?: string;
};

export type EntrySyncBatchResult = {
  success: boolean;
  processed: number;
  successCount: number;
  failedCount: number;
  results: EntrySyncItemResult[];
};

export async function runEntrySync(
  entryIds: number[],
  handler: EntrySyncHandler,
  eventId?: number,
): Promise<EntrySyncBatchResult> {
  const settled = await Promise.allSettled(
    entryIds.map(async (entryId) => {
      try {
        await handler(entryId, eventId);
        return { entryId, ok: true as const };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        logError('Entry sync API error', error, { entryId });
        return { entryId, ok: false as const, error: message };
      }
    }),
  );

  const results: EntrySyncItemResult[] = settled.map((s) => {
    if (s.status === 'fulfilled') {
      return s.value;
    }
    return {
      entryId: 0,
      ok: false,
      error: s.reason instanceof Error ? s.reason.message : 'Unknown error',
    };
  });

  const success = results.filter((r) => r.ok).length;
  const failed = results.length - success;

  return {
    success: failed === 0,
    processed: results.length,
    successCount: success,
    failedCount: failed,
    results,
  };
}

export async function syncEntryPicksBatch(entryIds: number[], eventId?: number) {
  return runEntrySync(entryIds, syncEntryEventPicks, eventId);
}

export async function syncEntryTransfersBatch(entryIds: number[], eventId?: number) {
  return runEntrySync(entryIds, syncEntryEventTransfers, eventId);
}

export async function syncEntryResultsBatch(entryIds: number[], eventId?: number) {
  return runEntrySync(entryIds, syncEntryEventResults, eventId);
}

export async function syncEntryAllBatch(entryIds: number[], eventId?: number) {
  const [picks, transfers, results] = await Promise.all([
    syncEntryPicksBatch(entryIds, eventId),
    syncEntryTransfersBatch(entryIds, eventId),
    syncEntryResultsBatch(entryIds, eventId),
  ]);

  return { picks, transfers, results };
}
