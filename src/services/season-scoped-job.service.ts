import {
  requireCurrentSeasonForJob as requireCurrentSeasonForJobWithReader,
  type SeasonScopedJobData,
} from '../domain/season-scoped-job';
import { seasonRepository } from '../repositories/seasons';

/** Infrastructure composition for the pure season-scoped job validator. */
export async function requireCurrentSeasonForJob(
  data: SeasonScopedJobData,
): ReturnType<typeof requireCurrentSeasonForJobWithReader> {
  return requireCurrentSeasonForJobWithReader(data, seasonRepository);
}
