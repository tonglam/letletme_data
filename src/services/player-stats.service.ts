import { playerStatsCache } from '../cache/operations';
import { fplClient } from '../clients/fpl';
import { getDb } from '../db/singleton';
import { shouldWritePlayerStatsView } from '../domain/player-stats';
import { createPlayerMarketSnapshotsRepository } from '../repositories/player-market-snapshots';
import { createPlayerStatsRepository, playerStatsRepository } from '../repositories/player-stats';
import { transformPlayerMarketSnapshots } from '../transformers/player-market-snapshots';
import {
  createTeamsMap,
  transformCurrentGameweekPlayerStats,
  transformPlayerStatsStrict,
} from '../transformers/player-stats';
import type { EventId } from '../types/base.type';
import { logInfo } from '../utils/logger';
import { loadTeamsBasicInfo } from '../utils/teams';
import { getCurrentEvent, getNextEvent } from './events.service';
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
  options?: {
    onTargetEventResolved?: (eventId: EventId) => void;
  },
  dependencies: PlayerStatsSyncDependencies = defaultDependencies,
): Promise<{
  count: number;
  eventId: EventId;
  errors: number;
  marketSnapshotCount: number;
  snapshotDate: string;
}> {
  logInfo('Starting player stats sync for current gameweek');

  // Resolve and publish the target before the fallible upstream request. This
  // keeps failed unscoped attempts traceable to the affected gameweek.
  const syncEvent = await dependencies.resolvePlayerSyncEvent();
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

  const capturedAt = new Date();
  const transformedPlayerStats = transformCurrentGameweekPlayerStats(fplData, syncEvent.event.id);
  const marketSnapshots = transformPlayerMarketSnapshots(fplData, capturedAt);
  const errors = fplData.elements.length - transformedPlayerStats.length;

  logInfo('Player stats transformed', {
    total: fplData.elements.length,
    successful: transformedPlayerStats.length,
    errors,
    eventId: syncEvent.event.id,
  });

  const db = await getDb();
  const persisted = await db.transaction(async (tx) => {
    const txPlayerStatsRepository = createPlayerStatsRepository(tx);
    const txMarketSnapshotsRepository = createPlayerMarketSnapshotsRepository(tx);

    const upsertResult = await txPlayerStatsRepository.upsertBatch(transformedPlayerStats);
    if (upsertResult.count !== fplData.elements.length) {
      throw new Error(
        `Incomplete player stats write: expected ${fplData.elements.length}, persisted ${upsertResult.count}`,
      );
    }

    const marketResult = await txMarketSnapshotsRepository.upsertCompleteDay(
      marketSnapshots,
      fplData.elements.length,
    );
    return { upsertResult, marketResult };
  });
  logInfo('Player stats and market snapshot committed', {
    expectedCount: fplData.elements.length,
    playerStatsCount: persisted.upsertResult.count,
    marketSnapshotCount: persisted.marketResult.persistedCount,
    snapshotDate: persisted.marketResult.snapshotDate,
  });

  if (persisted.upsertResult.count > 0) {
    await playerStatsCache.setByEvent(syncEvent.event.id, transformedPlayerStats);
    logInfo('Player stats cache updated', {
      eventId: syncEvent.event.id,
      count: transformedPlayerStats.length,
    });
  }

  const result = {
    count: persisted.upsertResult.count,
    eventId: syncEvent.event.id,
    errors,
    marketSnapshotCount: persisted.marketResult.persistedCount,
    snapshotDate: persisted.marketResult.snapshotDate,
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

  const transformedPlayerStats = transformPlayerStatsStrict(fplData.elements, eventId, teamsMap);
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
    // H9: PlayerStat:{season} is a latest-event-wins view consumed
    // externally — every setByEvent wholesale-replaces it. The current event,
    // or preseason next event when no current exists, may write it. Historical
    // backfills persist to the DB only so they cannot clobber the latest view.
    const [currentEvent, nextEvent] = await Promise.all([getCurrentEvent(), getNextEvent()]);
    if (shouldWritePlayerStatsView(eventId, currentEvent?.id ?? null, nextEvent?.id ?? null)) {
      await playerStatsCache.setByEvent(eventId, transformedPlayerStats);
      logInfo('Player stats cache updated for event', {
        eventId,
        count: transformedPlayerStats.length,
      });
    } else {
      logInfo('Skipping player stats cache write for non-latest event', {
        eventId,
        currentEventId: currentEvent?.id ?? null,
        nextEventId: nextEvent?.id ?? null,
      });
    }
  }

  const result = {
    count: upsertResult.count,
    errors,
  };

  logInfo('Player stats sync for event completed', { ...result, eventId });
  return result;
}
