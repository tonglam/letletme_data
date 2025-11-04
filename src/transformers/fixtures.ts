import { validateFixture, validateRawFPLFixture } from '../domain/fixtures';
import { ValidationError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

import type { Fixture, RawFPLFixture } from '../types';

// Transform FPL API fixture to our domain Fixture
export function transformFixture(rawFixture: RawFPLFixture): Fixture {
  try {
    const validatedRaw = validateRawFPLFixture(rawFixture);

    const kickoffTime = validatedRaw.kickoff_time ? new Date(validatedRaw.kickoff_time) : null;
    const safeKickoffTime = kickoffTime && Number.isNaN(kickoffTime.getTime()) ? null : kickoffTime;

    const domainFixture: Fixture = {
      id: validatedRaw.id,
      code: validatedRaw.code,
      event: validatedRaw.event,
      finished: validatedRaw.finished,
      finishedProvisional: validatedRaw.finished_provisional,
      kickoffTime: safeKickoffTime,
      minutes: validatedRaw.minutes,
      provisionalStartTime: validatedRaw.provisional_start_time,
      started: validatedRaw.started,
      teamA: validatedRaw.team_a,
      teamAScore: validatedRaw.team_a_score,
      teamH: validatedRaw.team_h,
      teamHScore: validatedRaw.team_h_score,
      stats: validatedRaw.stats,
      teamHDifficulty: validatedRaw.team_h_difficulty,
      teamADifficulty: validatedRaw.team_a_difficulty,
      pulseId: validatedRaw.pulse_id,
      createdAt: null,
      updatedAt: null,
    };

    return validateFixture(domainFixture);
  } catch (error) {
    logError('Failed to transform fixture', error, { fixtureId: rawFixture.id });
    throw new ValidationError(
      `Failed to transform fixture with id: ${rawFixture.id}`,
      'TRANSFORM_ERROR',
      error,
    );
  }
}

// Transform array of fixtures with comprehensive error handling
export function transformFixtures(rawFixtures: RawFPLFixture[]): Fixture[] {
  const fixtures: Fixture[] = [];
  const errors: Array<{ fixtureId: number; error: string }> = [];

  for (const rawFixture of rawFixtures) {
    try {
      const transformedFixture = transformFixture(rawFixture);
      fixtures.push(transformedFixture);
    } catch (error) {
      errors.push({
        fixtureId: rawFixture.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      logError('Skipping invalid fixture during transformation', error, {
        fixtureId: rawFixture.id,
      });
    }
  }

  if (errors.length > 0) {
    logError('Some fixtures failed transformation', {
      totalFixtures: rawFixtures.length,
      successfulTransforms: fixtures.length,
      failedTransforms: errors.length,
      errors,
    });
  }

  if (fixtures.length === 0) {
    throw new ValidationError('No valid fixtures were transformed', 'ALL_FIXTURES_INVALID', {
      originalCount: rawFixtures.length,
      errors,
    });
  }

  logInfo('Fixtures transformation completed', {
    totalInput: rawFixtures.length,
    successfulOutput: fixtures.length,
    skippedCount: errors.length,
  });

  return fixtures;
}
