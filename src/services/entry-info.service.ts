import { fplClient } from '../clients/fpl';
import { entryHistoryInfoRepository } from '../repositories/entry-history-infos';
import { entryInfoRepository } from '../repositories/entry-infos';
import { entryLeagueInfoRepository } from '../repositories/entry-league-infos';
import { logInfo } from '../utils/logger';

export async function syncEntryInfo(entryId: number) {
  logInfo('Starting entry info sync', { entryId });
  const summary = await fplClient.getEntrySummary(entryId);
  const saved = await entryInfoRepository.upsertFromSummary(summary);
  const history = await fplClient.getEntryHistory(entryId);
  await entryHistoryInfoRepository.upsertFromHistory(entryId, history);
  await entryLeagueInfoRepository.upsertFromLeagues(entryId, summary.leagues);
  logInfo('Entry info sync completed', { entryId });
  return { id: saved.id };
}
