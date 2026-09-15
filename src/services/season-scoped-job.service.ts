import {
  requireCurrentSeasonForJob as requireCurrentSeasonForJobWithReader,
  type SeasonScopedJobData,
} from '../domain/season-scoped-job';
import type { DbOrTransaction } from '../db/singleton';
import { createSeasonRepository, seasonRepository } from '../repositories/seasons';

/** Infrastructure composition for the pure season-scoped job validator. */
export async function requireCurrentSeasonForJob(
  data: SeasonScopedJobData,
  dbInstance?: DbOrTransaction,
): ReturnType<typeof requireCurrentSeasonForJobWithReader> {
  return requireCurrentSeasonForJobWithReader(
    data,
    dbInstance ? createSeasonRepository(dbInstance) : seasonRepository,
  );
}
