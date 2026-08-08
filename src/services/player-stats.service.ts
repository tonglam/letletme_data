import { fplClient } from '../clients/fpl';
import type { FplSeasonRef } from '../domain/fpl-season';
import { playerStatsRepository } from '../repositories/player-stats';
import {
  createTeamsMap,
  transformCurrentGameweekPlayerStats,
  transformPlayerStatsStrict,
} from '../transformers/player-stats';
import type { EventId } from '../types/base.type';
import { logInfo } from '../utils/logger';
import { loadTeamsBasicInfo } from '../utils/teams';
import { resolvePlayerSyncEvent } from './player-sync-event.service';

export type PlayerStatsSyncDependencies = {
  getBootstrap: () => ReturnType<typeof fplClient.getBootstrap>;
  resolvePlayerSyncEvent: typeof resolvePlayerSyncEvent;
};

const defaultDependencies: PlayerStatsSyncDependencies = {
  getBootstrap: () => fplClient.getBootstrap(),
  resolvePlayerSyncEvent,
};

export async function syncCurrentPlayerStats(
  season: FplSeasonRef,
  options?: {
    onTargetEventResolved?: (eventId: EventId) => void;
  },
  dependencies: PlayerStatsSyncDependencies = defaultDependencies,
): Promise<{
  count: number;
  eventId: EventId;
  errors: number;
}> {
  logInfo('Starting player stats sync for current gameweek');

  // Resolve and publish the target before the fallible upstream request. This
  // keeps failed unscoped attempts traceable to the affected gameweek.
  const syncEvent = await dependencies.resolvePlayerSyncEvent(season);
  if (!syncEvent) {
    throw new Error('No current or next event found for player stats');
  }
  options?.onTargetEventResolved?.(syncEvent.event.id);

  const fplData = await dependencies.getBootstrap();

  if (!Array.isArray(fplData.elements)) {
    throw new Error('Invalid player elements data from FPL API');
  }

  if (fplData.elements.length === 0) {
    throw new Error('No player stats returned from FPL API');
  }

  logInfo('Raw player stats data fetched', {
    playersCount: fplData.elements.length,
    eventId: syncEvent.event.id,
  });

  const transformedPlayerStats = transformCurrentGameweekPlayerStats(fplData, syncEvent.event.id);
  const errors = fplData.elements.length - transformedPlayerStats.length;

  logInfo('Player stats transformed', {
    total: fplData.elements.length,
    successful: transformedPlayerStats.length,
    errors,
    eventId: syncEvent.event.id,
  });

  const persisted = await playerStatsRepository.upsertBatch(season, transformedPlayerStats);
  if (persisted.count !== fplData.elements.length) {
    throw new Error(
      `Incomplete player stats write: expected ${fplData.elements.length}, persisted ${persisted.count}`,
    );
  }
  logInfo('Player event snapshot committed', {
    expectedCount: fplData.elements.length,
    playerStatsCount: persisted.count,
  });

  const result = {
    count: persisted.count,
    eventId: syncEvent.event.id,
    errors,
  };

  logInfo('Player stats sync completed', result);
  return result;
}

export async function syncPlayerStatsForEvent(
  season: FplSeasonRef,
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

  const teams = await loadTeamsBasicInfo(season);
  const teamsMap = createTeamsMap(teams);

  const transformedPlayerStats = transformPlayerStatsStrict(fplData.elements, eventId, teamsMap);
  const errors = fplData.elements.length - transformedPlayerStats.length;

  logInfo('Player stats transformed for event', {
    total: fplData.elements.length,
    successful: transformedPlayerStats.length,
    errors,
    eventId,
  });

  const upsertResult = await playerStatsRepository.upsertBatch(season, transformedPlayerStats);
  logInfo('Player stats upserted to database for event', {
    count: upsertResult.count,
    eventId,
  });

  const result = {
    count: upsertResult.count,
    errors,
  };

  logInfo('Player stats sync for event completed', { ...result, eventId });
  return result;
}
