import * as TE from 'fp-ts/TaskEither';
import type { BootstrapApi } from '../../domains/bootstrap/operations';
import type { PhaseCache } from '../../domains/phases/cache/cache';
import { phaseRepository } from '../../domains/phases/repository';
import type { APIError } from '../../infrastructure/http/common/errors';
import type { Phase, PhaseId } from '../../types/phases.type';

export type PhaseServiceError = APIError & {
  code: 'CACHE_ERROR' | 'VALIDATION_ERROR' | 'NOT_FOUND' | 'SYNC_ERROR';
  details?: Record<string, unknown>;
};

export interface PhaseService {
  syncPhases: () => TE.TaskEither<APIError, readonly Phase[]>;
  getPhases: () => TE.TaskEither<APIError, readonly Phase[]>;
  getPhase: (id: PhaseId) => TE.TaskEither<APIError, Phase | null>;
  getCurrentActivePhase: (currentEventId: number) => TE.TaskEither<APIError, Phase | null>;
}

export type PhaseServiceDependencies = {
  bootstrapApi: BootstrapApi;
  phaseCache?: PhaseCache;
  phaseRepository: typeof phaseRepository;
};
