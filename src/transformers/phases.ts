import { validatePhase, validateRawFPLPhase } from '../domain/phases';
import { ValidationError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

import type { Phase, RawFPLPhase } from '../types';

/**
 * Transform FPL API phase to our domain Phase with validation
 */
export function transformPhase(rawPhase: RawFPLPhase): Phase {
  try {
    // Validate raw FPL data first
    const validatedRawPhase = validateRawFPLPhase(rawPhase);

    // Transform to domain object
    const domainPhase: Phase = {
      id: validatedRawPhase.id,
      name: validatedRawPhase.name,
      startEvent: validatedRawPhase.start_event,
      stopEvent: validatedRawPhase.stop_event,
      highestScore: validatedRawPhase.highest_score,
    };

    // Validate the transformed domain object
    return validatePhase(domainPhase);
  } catch (error) {
    logError('Failed to transform phase', error, {
      phaseId: rawPhase.id,
      phaseName: rawPhase.name,
    });
    throw new ValidationError(
      `Failed to transform phase with id: ${rawPhase.id}`,
      'TRANSFORM_ERROR',
      error,
    );
  }
}

/**
 * Transform array of phases with comprehensive error handling
 */
export function transformPhases(rawPhases: RawFPLPhase[]): Phase[] {
  const phases: Phase[] = [];
  const errors: Array<{ phaseId: number; error: string }> = [];

  for (const rawPhase of rawPhases) {
    try {
      const transformedPhase = transformPhase(rawPhase);
      phases.push(transformedPhase);
    } catch (error) {
      errors.push({
        phaseId: rawPhase.id,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      logError('Skipping invalid phase during transformation', error, { phaseId: rawPhase.id });
    }
  }

  if (errors.length > 0) {
    logError('Some phases failed transformation', {
      totalPhases: rawPhases.length,
      successfulTransforms: phases.length,
      failedTransforms: errors.length,
      errors: errors,
    });
  }

  if (phases.length === 0) {
    throw new ValidationError('No valid phases were transformed', 'ALL_PHASES_INVALID', {
      originalCount: rawPhases.length,
      errors,
    });
  }

  logInfo('Phases transformation completed', {
    totalInput: rawPhases.length,
    successfulOutput: phases.length,
    skippedCount: errors.length,
  });

  return phases;
}
