import { entryInfosCache } from '../cache/entry-infos-cache';
import { fplClient } from '../clients/fpl';
import { toEntryInfo } from '../domain/entry-infos';
import { getCurrentEvent } from './events.service';
import { entryHistoryInfoRepository } from '../repositories/entry-history-infos';
import { entryInfoRepository } from '../repositories/entry-infos';
import { entryLeagueInfoRepository } from '../repositories/entry-league-infos';
import { logInfo } from '../utils/logger';

export async function syncEntryInfo(entryId: number) {
  logInfo('Starting entry info sync', { entryId });
  const [summary, history, currentEvent] = await Promise.all([
    fplClient.getEntrySummary(entryId),
    fplClient.getEntryHistory(entryId),
    getCurrentEvent(),
  ]);
  const lastEventId = currentEvent ? currentEvent.id - 1 : null;
  const [saved] = await Promise.all([
    entryInfoRepository.upsertFromSummary(summary, lastEventId),
    entryHistoryInfoRepository.upsertFromHistory(entryId, history),
    entryLeagueInfoRepository.upsertFromLeagues(entryId, summary.leagues),
  ]);
  await entryInfosCache.setEntry(toEntryInfo(saved));
  logInfo('Entry info sync completed', { entryId });
  return saved;
}
