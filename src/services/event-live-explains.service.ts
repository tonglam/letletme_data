import { eventLiveExplainCache } from '../cache/operations';
import { eventLiveExplainsRepository } from '../repositories/event-live-explains';
import { getCurrentEvent } from './events.service';
import { logError, logInfo } from '../utils/logger';

// Cascade job: reads explain data already written by event-lives-db-sync and updates cache.
// No FPL API call — avoids redundant fetch since syncEventLives already persisted this data.
export async function syncEventLiveExplain(
  eventId?: number,
): Promise<{ count: number; eventId: number }> {
  try {
    const resolvedEventId = eventId ?? (await getCurrentEvent())?.id;
    if (!resolvedEventId) {
      throw new Error('No current event found for event live explain');
    }

    logInfo('Starting event live explain cache update', { eventId: resolvedEventId });

    const explains = await eventLiveExplainsRepository.findByEventId(resolvedEventId);

    if (explains.length > 0) {
      await eventLiveExplainCache.set(resolvedEventId, explains);
    } else {
      await eventLiveExplainCache.clearByEventId(resolvedEventId);
    }

    logInfo('Event live explain cache update completed', {
      eventId: resolvedEventId,
      count: explains.length,
    });

    return { count: explains.length, eventId: resolvedEventId };
  } catch (error) {
    logError('Event live explain cache update failed', error);
    throw error;
  }
}
