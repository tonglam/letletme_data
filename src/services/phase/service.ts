import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { FplBootstrapDataService } from '../../data/types';
import { createPhaseOperations } from '../../domains/phase/operation';
import { PhaseCache, PhaseOperations, PhaseRepository } from '../../domains/phase/types';
import { PrismaPhaseCreate } from '../../repositories/phase/type';
import { Phase, PhaseId, Phases } from '../../types/domain/phase.type';
import { DataLayerError, ServiceError } from '../../types/error.type';
import {
  createServiceIntegrationError,
  mapDomainErrorToServiceError,
} from '../../utils/error.util';
import { PhaseService, PhaseServiceOperations } from './types';

const phaseServiceOperations = (
  domainOps: PhaseOperations,
  fplDataService: FplBootstrapDataService,
): PhaseServiceOperations => ({
  findAllPhases: () =>
    pipe(domainOps.getAllPhases(), TE.mapLeft(mapDomainErrorToServiceError)) as TE.TaskEither<
      ServiceError,
      Phases
    >,

  findPhaseById: (id: PhaseId) =>
    pipe(domainOps.getPhaseById(id), TE.mapLeft(mapDomainErrorToServiceError)) as TE.TaskEither<
      ServiceError,
      Phase | null
    >,

  syncPhasesFromApi: () =>
    pipe(
      fplDataService.getPhases(),
      TE.mapLeft((error: DataLayerError) =>
        createServiceIntegrationError({
          message: 'Failed to fetch/map phases via data layer',
          cause: error.cause,
          details: error.details,
        }),
      ),
      TE.map((rawData) => mapRawDataToPhaseCreateArray(rawData)),
      TE.chain((phaseCreateData) =>
        pipe(domainOps.savePhases(phaseCreateData), TE.mapLeft(mapDomainErrorToServiceError)),
      ),
    ) as TE.TaskEither<ServiceError, Phases>,
});

const mapRawDataToPhaseCreateArray = (rawData: Phases): PrismaPhaseCreate[] => {
  return rawData.map((phase) => phase as PrismaPhaseCreate);
};

export const createPhaseService = (
  fplDataService: FplBootstrapDataService,
  repository: PhaseRepository,
  cache: PhaseCache,
): PhaseService => {
  const domainOps = createPhaseOperations(repository, cache);
  const ops = phaseServiceOperations(domainOps, fplDataService);

  return {
    getPhases: () => ops.findAllPhases(),
    getPhase: (id: PhaseId) => ops.findPhaseById(id),
    syncPhasesFromApi: () => ops.syncPhasesFromApi(),
  };
};
