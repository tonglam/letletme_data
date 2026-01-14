import { eventOverallResultCache } from '../cache/operations';
import { fplClient } from '../clients/fpl';
import type {
  EventChipData,
  EventOverallResultData,
  EventTopElementData,
} from '../domain/event-overall-results';
import { logError, logInfo } from '../utils/logger';

type ChipPlayRecord = { chip_name?: unknown; num_played?: unknown };
type TopElementRecord = { id?: unknown; points?: unknown };

function isChipPlayRecord(value: unknown): value is ChipPlayRecord {
  return Boolean(value) && typeof value === 'object';
}

function toNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseChipPlays(raw: unknown[]): EventChipData[] {
  return raw
    .filter(isChipPlayRecord)
    .map((item) => {
      const chipName = typeof item.chip_name === 'string' ? item.chip_name : null;
      const numberPlayed = toNumber(item.num_played);
      if (!chipName || numberPlayed === null) {
        return null;
      }
      return { chipName, numberPlayed };
    })
    .filter((item): item is EventChipData => item !== null);
}

function parseTopElementInfo(raw: unknown): EventTopElementData | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const record = raw as TopElementRecord;
  const element = toNumber(record.id);
  const points = toNumber(record.points);
  if (element === null || points === null) {
    return null;
  }

  return { element, points };
}

export async function syncEventOverallResult(): Promise<{ count: number; eventId: number | null }> {
  try {
    const bootstrapData = await fplClient.getBootstrap();
    const currentEvent = bootstrapData.events.find((event) => event.is_current);

    if (!currentEvent || currentEvent.id < 1 || currentEvent.id > 38) {
      logInfo('Skipping event overall result sync - invalid event', { eventId: currentEvent?.id });
      return { count: 0, eventId: currentEvent?.id ?? null };
    }

    const results: EventOverallResultData[] = bootstrapData.events.map((event) => ({
      event: event.id,
      averageEntryScore: event.average_entry_score,
      finished: event.finished,
      highestScoringEntry: event.highest_scoring_entry,
      highestScore: event.highest_score,
      chipPlays: parseChipPlays(Array.isArray(event.chip_plays) ? event.chip_plays : []),
      mostSelected: event.most_selected,
      mostTransferredIn: event.most_transferred_in,
      topElementInfo: parseTopElementInfo(event.top_element_info),
      transfersMade: event.transfers_made,
      mostCaptained: event.most_captained,
      mostViceCaptained: event.most_vice_captained,
    }));

    await eventOverallResultCache.setAll(results);

    logInfo('Event overall result sync completed', {
      eventId: currentEvent.id,
      count: results.length,
    });

    return { count: results.length, eventId: currentEvent.id };
  } catch (error) {
    logError('Event overall result sync failed', error);
    throw error;
  }
}
