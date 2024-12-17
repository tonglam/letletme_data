import { createResult } from './operations';
import { Phase, PhaseOperationResult, PhaseRepository } from './types';

/**
 * Get all phases
 */
export const getAllPhases = async (
  repository: PhaseRepository,
): Promise<PhaseOperationResult<Phase[]>> => {
  try {
    const phases = await repository.findAll();
    return createResult(phases);
  } catch (error) {
    return createResult(undefined, `Failed to get phases: ${error}`);
  }
};

/**
 * Get phase by ID
 */
export const getPhaseById = async (
  repository: PhaseRepository,
  id: number,
): Promise<PhaseOperationResult<Phase | null>> => {
  try {
    const phase = await repository.findById(id);
    return createResult(phase);
  } catch (error) {
    return createResult(undefined, `Failed to get phase ${id}: ${error}`);
  }
};

/**
 * Get current phase
 */
export const getCurrentPhase = async (
  repository: PhaseRepository,
  currentEventId: number,
): Promise<PhaseOperationResult<Phase | null>> => {
  try {
    const phases = await repository.findAll();
    const currentPhase = phases.find(
      (phase) => phase.startEventId <= currentEventId && phase.stopEventId >= currentEventId,
    );
    return createResult(currentPhase || null);
  } catch (error) {
    return createResult(undefined, `Failed to get current phase: ${error}`);
  }
};
