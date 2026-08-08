import { eventLiveSummaryCache } from '../cache/operations';
import type { EventLiveSummary } from '../domain/event-live-summaries';
import { eventLiveSummariesRepository } from '../repositories/event-live-summaries';
import { logError, logInfo } from '../utils/logger';

import type { ElementTypeId } from '../types/base.type';

export async function syncEventLiveSummary(): Promise<{ count: number }> {
  try {
    logInfo('Starting season event live summary sync');

    const aggregated = await eventLiveSummariesRepository.aggregateSummaries();
    const summaries: EventLiveSummary[] = aggregated.map((row) => ({
      elementId: row.elementId,
      elementType: row.elementType as ElementTypeId,
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
      await eventLiveSummaryCache.set(summaries);
    } else {
      await eventLiveSummaryCache.clear();
    }

    logInfo('Event live summary sync completed', {
      count: result.count,
    });

    return { count: result.count };
  } catch (error) {
    logError('Event live summary sync failed', error);
    throw error;
  }
}
