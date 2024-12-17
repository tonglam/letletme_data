import { PrismaClient } from '@prisma/client';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { createResult, transformRawPhase, validatePhase } from '../../domains/phases/operations';
import { getAllPhases, getCurrentPhase, getPhaseById } from '../../domains/phases/queries';
import { PrismaPhaseRepository } from '../../domains/phases/repository';
import { Phase, PhaseOperationResult } from '../../domains/phases/types';
import { BootstrapApi } from '../../infrastructure/api/bootstrap';

export class PhaseService {
  private repository: PrismaPhaseRepository;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly bootstrapApi: BootstrapApi,
  ) {
    this.repository = new PrismaPhaseRepository(prisma);
  }

  /**
   * Sync phases from FPL API
   */
  async syncPhases(): Promise<PhaseOperationResult<Phase[]>> {
    try {
      const bootstrapData = await this.bootstrapApi.getBootstrapData();

      if (!bootstrapData?.phases) {
        return createResult(undefined, 'No phases data available from API');
      }

      const results = await Promise.all(
        bootstrapData.phases.map(async (rawPhase) => {
          const phaseResult = pipe(rawPhase, transformRawPhase, E.chain(validatePhase));

          if (E.isLeft(phaseResult)) {
            return createResult<Phase>(undefined, phaseResult.left);
          }

          try {
            const phase = await this.repository.save(phaseResult.right);
            return createResult(phase);
          } catch (error) {
            return createResult<Phase>(
              undefined,
              `Failed to save phase: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }),
      );

      const errors = results
        .filter((result) => !result.success)
        .map((result) => result.error)
        .filter((error): error is string => error !== undefined)
        .join(', ');

      if (errors) {
        return createResult(undefined, `Some phases failed to sync: ${errors}`);
      }

      const savedPhases = results
        .filter(
          (result): result is PhaseOperationResult<Phase> & { data: Phase } =>
            result.success && result.data !== undefined,
        )
        .map((result) => result.data);

      return createResult(savedPhases);
    } catch (error) {
      return createResult(
        undefined,
        `Failed to sync phases: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Get all phases
   */
  async getPhases(): Promise<PhaseOperationResult<Phase[]>> {
    return getAllPhases(this.repository);
  }

  /**
   * Get phase by ID
   */
  async getPhase(id: number): Promise<PhaseOperationResult<Phase | null>> {
    return getPhaseById(this.repository, id);
  }

  /**
   * Get current phase
   */
  async getCurrentPhase(currentEventId: number): Promise<PhaseOperationResult<Phase | null>> {
    return getCurrentPhase(this.repository, currentEventId);
  }
}
