import { eventLiveExplainCache } from '../cache/operations';
import { fplClient } from '../clients/fpl';
import { eventLiveExplainsRepository } from '../repositories/event-live-explains';
import { transformEventLiveExplains } from '../transformers/event-live-explains';
import { getCurrentEvent } from './events.service';
import { logError, logInfo } from '../utils/logger';

export async function syncEventLiveExplain(
  eventId?: number,
): Promise<{ count: number; eventId: number }> {
  try {
    const resolvedEventId = eventId ?? (await getCurrentEvent())?.id;
    if (!resolvedEventId) {
      throw new Error('No current event found for event live explain');
    }

    logInfo('Starting event live explain sync', { eventId: resolvedEventId });

    const liveData = await fplClient.getEventLive(resolvedEventId);
    if (!liveData.elements || !Array.isArray(liveData.elements)) {
      throw new Error('Invalid event live data from FPL API');
    }

    const explains = transformEventLiveExplains(resolvedEventId, liveData.elements);
    const saved = await eventLiveExplainsRepository.upsertBatch(explains);

    if (saved.length > 0) {
      await eventLiveExplainCache.set(resolvedEventId, explains);
    } else {
      await eventLiveExplainCache.clearByEventId(resolvedEventId);
    }

    logInfo('Event live explain sync completed', {
      eventId: resolvedEventId,
      count: saved.length,
    });

    return { count: saved.length, eventId: resolvedEventId };
  } catch (error) {
    logError('Event live explain sync failed', error);
    throw error;
  }
}
