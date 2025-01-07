/**
 * Phase Service Module
 * Exports the phase service interface and implementation.
 */

export { createPhaseService } from './service';
export type {
  PhaseService,
  PhaseServiceDependencies,
  PhaseServiceOperations,
  PhaseServiceWithWorkflows,
  WorkflowContext,
  WorkflowResult,
} from './types';
export { phaseWorkflows } from './workflow';
