import { playerStatsCache } from '../cache/operations';
import { fplClient } from '../clients/fpl';
import { playerStatsRepository } from '../repositories/player-stats';
import {
  createTeamsMap,
  transformCurrentGameweekPlayerStats,
  transformPlayerStats,
} from '../transformers/player-stats';
import type { EventId } from '../types/base.type';
import { logInfo } from '../utils/logger';
import { loadTeamsBasicInfo } from '../utils/teams';

export async function syncCurrentPlayerStats(): Promise<{
  count: number;
  eventId: EventId;
  errors: number;
}> {
  logInfo('Starting player stats sync for current gameweek');

  const fplData = await fplClient.getBootstrap();

  if (!Array.isArray(fplData.elements)) {
    throw new Error('Invalid player elements data from FPL API');
  }

  if (!Array.isArray(fplData.events)) {
    throw new Error('Invalid events data from FPL API');
  }

  const currentEvent = fplData.events.find((event) => event.is_current);
  if (!currentEvent) {
    throw new Error('No current event found in FPL API response');
  }

  if (fplData.elements.length === 0) {
    throw new Error('No player stats returned from FPL API');
  }

  logInfo('Raw player stats data fetched', {
    playersCount: fplData.elements.length,
    eventId: currentEvent.id,
  });

  const transformedPlayerStats = transformCurrentGameweekPlayerStats(fplData);
  const errors = fplData.elements.length - transformedPlayerStats.length;

  logInfo('Player stats transformed', {
    total: fplData.elements.length,
    successful: transformedPlayerStats.length,
    errors,
    eventId: currentEvent.id,
  });

  const upsertResult = await playerStatsRepository.upsertBatch(transformedPlayerStats);
  logInfo('Player stats upserted to database', { count: upsertResult.count });

  if (upsertResult.count > 0) {
    await playerStatsCache.setByEvent(currentEvent.id, transformedPlayerStats);
    logInfo('Player stats cache updated', {
      eventId: currentEvent.id,
      count: transformedPlayerStats.length,
    });
  }

  const result = {
    count: upsertResult.count,
    eventId: currentEvent.id,
    errors,
  };

  logInfo('Player stats sync completed', result);
  return result;
}

export async function syncPlayerStatsForEvent(
  eventId: EventId,
): Promise<{ count: number; errors: number }> {
  logInfo('Starting player stats sync for specific event', { eventId });

  const fplData = await fplClient.getBootstrap();

  if (!Array.isArray(fplData.elements)) {
    throw new Error('Invalid player elements data from FPL API');
  }

  if (fplData.elements.length === 0) {
    throw new Error('No player stats returned from FPL API');
  }

  const teams = await loadTeamsBasicInfo();
  const teamsMap = createTeamsMap(teams);

  const transformedPlayerStats = transformPlayerStats(fplData.elements, eventId, teamsMap);
  const errors = fplData.elements.length - transformedPlayerStats.length;

  logInfo('Player stats transformed for event', {
    total: fplData.elements.length,
    successful: transformedPlayerStats.length,
    errors,
    eventId,
  });

  const upsertResult = await playerStatsRepository.upsertBatch(transformedPlayerStats);
  logInfo('Player stats upserted to database for event', {
    count: upsertResult.count,
    eventId,
  });

  if (upsertResult.count > 0) {
    await playerStatsCache.setByEvent(eventId, transformedPlayerStats);
    logInfo('Player stats cache updated for event', {
      eventId,
      count: transformedPlayerStats.length,
    });
  }

  const result = {
    count: upsertResult.count,
    errors,
  };

  logInfo('Player stats sync for event completed', { ...result, eventId });
  return result;
}
