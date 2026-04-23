import { entryInfosCache } from '../cache/entry-infos-cache';
import { fplClient } from '../clients/fpl';
import { entryHistoryInfoRepository } from '../repositories/entry-history-infos';
import { entryInfoRepository } from '../repositories/entry-infos';
import { entryLeagueInfoRepository } from '../repositories/entry-league-infos';
import { logInfo } from '../utils/logger';

export async function syncEntryInfo(entryId: number) {
  logInfo('Starting entry info sync', { entryId });
  const [summary, history] = await Promise.all([
    fplClient.getEntrySummary(entryId),
    fplClient.getEntryHistory(entryId),
  ]);
  const [saved] = await Promise.all([
    entryInfoRepository.upsertFromSummary(summary),
    entryHistoryInfoRepository.upsertFromHistory(entryId, history),
    entryLeagueInfoRepository.upsertFromLeagues(entryId, summary.leagues),
  ]);
  await entryInfosCache.setEntry(saved);
  logInfo('Entry info sync completed', { entryId });
  return saved;
}
