import type { BootstrapApi } from '../../domains/bootstrap/operations';
import type { PhaseCacheOperations } from '../../domains/phases/cache';
import { phaseRepository } from '../../domains/phases/repository';
import { initializePhaseCache } from './cache';
import { createPhaseServiceImpl } from './service';
import type { PhaseService } from './types';

export const createPhaseService = (bootstrapApi: BootstrapApi): PhaseService => {
  const phaseCache: PhaseCacheOperations | undefined = initializePhaseCache(bootstrapApi);

  return createPhaseServiceImpl({
    bootstrapApi,
    phaseCache,
    phaseRepository,
  });
};

export type { PhaseService } from './types';
