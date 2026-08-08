import { explicitSeasonRef, type FplSeasonRef } from './fpl-season';
import { seasonRepository } from '../repositories/seasons';
import { ConflictError, ValidationError } from '../utils/errors';

export interface SeasonScopedJobData {
  readonly seasonId: number;
  readonly seasonCode: string;
}

export function seasonRefFromJobData(data: SeasonScopedJobData): FplSeasonRef {
  let season: FplSeasonRef;
  try {
    season = explicitSeasonRef(data.seasonCode);
  } catch (error) {
    throw new ValidationError('Queued job has an invalid FPL season code.', 'INVALID_JOB_SEASON', {
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  if (season.seasonId !== data.seasonId) {
    throw new ValidationError(
      'Queued job season ID does not match its season code.',
      'INVALID_JOB_SEASON',
    );
  }

  return season;
}

export async function requireCurrentSeasonForJob(data: SeasonScopedJobData): Promise<FplSeasonRef> {
  const requested = seasonRefFromJobData(data);
  const current = await seasonRepository.findCurrent();
  if (current.seasonId !== requested.seasonId || current.seasonCode !== requested.seasonCode) {
    throw new ConflictError(
      `Queued FPL job belongs to season ${requested.seasonCode}; current season is ${current.seasonCode}.`,
      'STALE_JOB_SEASON',
    );
  }

  return requested;
}
