import { enqueueFplSeasonArchiveJob } from '../jobs/data-sync-enqueue';
import { fplHistoryRepository } from '../repositories/fpl-history';

export async function enqueueFplSeasonArchiveIfEligible(season: string) {
  const archive = await fplHistoryRepository.findArchive(season);
  if (
    archive?.status === 'sealed' ||
    archive?.status === 'unavailable' ||
    archive?.status === 'building'
  ) {
    return null;
  }
  const eligibility = await fplHistoryRepository.checkEligibility();
  if (!eligibility.eligible) return null;
  await fplHistoryRepository.markPending(season);
  return enqueueFplSeasonArchiveJob(season, 'event-transition');
}
