import { fplClient } from '../clients/fpl';
import { entryInfoRepository } from '../repositories/entry-infos';
import { entryHistoryInfoRepository } from '../repositories/entry-history-infos';
import { entryLeagueInfoRepository } from '../repositories/entry-league-infos';
import { entryEventPicksRepository } from '../repositories/entry-event-picks';
import { entryEventTransfersRepository } from '../repositories/entry-event-transfers';
import { entryEventResultsRepository } from '../repositories/entry-event-results';
import { logError, logInfo } from '../utils/logger';
import { entryEventPicksRepository } from '../repositories/entry-event-picks';

export async function getEntryInfo(entryId: number) {
  try {
    const row = await entryInfoRepository.findById(entryId);
    return row;
  } catch (error) {
    logError('Failed to get entry info', error, { entryId });
    throw error;
  }
}

export async function syncEntryInfo(entryId: number) {
  try {
    logInfo('Starting entry info sync', { entryId });
    const summary = await fplClient.getEntrySummary(entryId);
    const saved = await entryInfoRepository.upsertFromSummary(summary);
    // Also upsert seasonal history snapshot using history endpoint
    const history = await fplClient.getEntryHistory(entryId);
    await entryHistoryInfoRepository.upsertFromHistory(entryId, history);
    // Upsert league infos from entry summary leagues
    await entryLeagueInfoRepository.upsertFromLeagues(entryId, summary.leagues);
    logInfo('Entry info sync completed', { entryId });
    return { id: saved.id };
  } catch (error) {
    logError('Entry info sync failed', error, { entryId });
    throw error;
  }
}

export async function syncEntryEventPicks(entryId: number, eventId?: number) {
  try {
    logInfo('Starting entry event picks sync', { entryId, eventId });
    // Determine event id if not provided (use current event)
    let targetEventId = eventId;
    if (!targetEventId) {
      const bootstrap = await fplClient.getBootstrap();
      const current = bootstrap.events.find((e) => e.is_current);
      if (!current) throw new Error('No current event found');
      targetEventId = current.id;
    }
    const picks = await fplClient.getEntryEventPicks(entryId, targetEventId);
    await entryEventPicksRepository.upsertFromPicks(entryId, targetEventId, picks);
    logInfo('Entry event picks sync completed', { entryId, eventId: targetEventId });
    return { entryId, eventId: targetEventId };
  } catch (error) {
    logError('Sync entry event picks failed', error, { entryId, eventId });
    throw error;
  }
}

export async function syncEntryEventTransfers(entryId: number, eventId?: number) {
  try {
    logInfo('Starting entry event transfers sync', { entryId, eventId });
    // Determine event id if not provided (use current event)
    let targetEventId = eventId;
    if (!targetEventId) {
      const bootstrap = await fplClient.getBootstrap();
      const current = bootstrap.events.find((e) => e.is_current);
      if (!current) throw new Error('No current event found');
      targetEventId = current.id;
    }
    const transfers = await fplClient.getEntryTransfers(entryId);
    // Build points map from event live for this event
    const live = await fplClient.getEventLive(targetEventId);
    const pointsByElement = new Map<number, number>();
    for (const el of live.elements) {
      pointsByElement.set(el.id, el.stats.total_points);
    }
    await entryEventTransfersRepository.replaceForEvent(entryId, targetEventId, transfers, pointsByElement);
    logInfo('Entry event transfers sync completed', { entryId, eventId: targetEventId });
    return { entryId, eventId: targetEventId };
  } catch (error) {
    logError('Sync entry event transfers failed', error, { entryId, eventId });
    throw error;
  }
}

export async function syncEntryEventResults(entryId: number, eventId?: number) {
  try {
    logInfo('Starting entry event results sync', { entryId, eventId });
    // Determine event id if not provided (use current event)
    let targetEventId = eventId;
    if (!targetEventId) {
      const bootstrap = await fplClient.getBootstrap();
      const current = bootstrap.events.find((e) => e.is_current);
      if (!current) throw new Error('No current event found');
      targetEventId = current.id;
    }
    const [picks, live] = await Promise.all([
      fplClient.getEntryEventPicks(entryId, targetEventId),
      fplClient.getEventLive(targetEventId),
    ]);
    await entryEventResultsRepository.upsertFromPicksAndLive(entryId, targetEventId, picks, live);
    logInfo('Entry event results sync completed', { entryId, eventId: targetEventId });
    return { entryId, eventId: targetEventId };
  } catch (error) {
    logError('Sync entry event results failed', error, { entryId, eventId });
    throw error;
  }
}
