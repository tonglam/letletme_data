import { eventLiveSummaryCache } from '../cache/operations';
import type { EventLiveSummary } from '../domain/event-live-summaries';
import { eventLiveSummariesRepository } from '../repositories/event-live-summaries';
import { logError, logInfo } from '../utils/logger';
import { getCurrentEvent } from './events.service';

import type { ElementTypeId } from '../types/base.type';

export async function syncEventLiveSummary(): Promise<{ count: number; eventId: number }> {
  try {
    const currentEvent = await getCurrentEvent();
    if (!currentEvent) {
      throw new Error('No current event found for event live summary');
    }

    logInfo('Starting event live summary sync', { eventId: currentEvent.id });

    const aggregated = await eventLiveSummariesRepository.aggregateSummaries(currentEvent.id);
    const summaries: EventLiveSummary[] = aggregated.map((row) => ({
      eventId: currentEvent.id,
      elementId: row.elementId,
      elementType: row.elementType as ElementTypeId,
      teamId: row.teamId,
      minutes: row.minutes,
      goalsScored: row.goalsScored,
      assists: row.assists,
      cleanSheets: row.cleanSheets,
      goalsConceded: row.goalsConceded,
      ownGoals: row.ownGoals,
      penaltiesSaved: row.penaltiesSaved,
      penaltiesMissed: row.penaltiesMissed,
      yellowCards: row.yellowCards,
      redCards: row.redCards,
      saves: row.saves,
      bonus: row.bonus,
      bps: row.bps,
      totalPoints: row.totalPoints,
      createdAt: null,
      updatedAt: null,
    }));

    const result = await eventLiveSummariesRepository.replaceAll(summaries);

    if (result.count > 0) {
      await eventLiveSummaryCache.set(currentEvent.id, summaries);
    } else {
      await eventLiveSummaryCache.clearByEventId(currentEvent.id);
    }

    logInfo('Event live summary sync completed', {
      eventId: currentEvent.id,
      count: result.count,
    });

    return { count: result.count, eventId: currentEvent.id };
  } catch (error) {
    logError('Event live summary sync failed', error);
    throw error;
  }
}
