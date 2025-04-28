import { createPhaseOperations } from 'domain/phase/operation';
import { PhaseCache, PhaseOperations } from 'domain/phase/types';

import { FplBootstrapDataService } from 'data/types';
import { pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { PhaseCreateInputs, PhaseRepository } from 'repository/phase/types';
import { PhaseService, PhaseServiceOperations } from 'service/phase/types';
import { Phase, PhaseId, Phases } from 'types/domain/phase.type';
import { createDomainError, DataLayerError, DomainErrorCode, ServiceError } from 'types/error.type';
import { createServiceIntegrationError, mapDomainErrorToServiceError } from 'utils/error.util';

const phaseServiceOperations = (
  fplDataService: FplBootstrapDataService,
  domainOps: PhaseOperations,
  cache: PhaseCache,
): PhaseServiceOperations => {
  const findPhaseById = (id: PhaseId): TE.TaskEither<ServiceError, Phase> =>
    pipe(
      cache.getAllPhases(),
      TE.mapLeft(mapDomainErrorToServiceError),
      TE.chainOptionK(() =>
        mapDomainErrorToServiceError(
          createDomainError({
            code: DomainErrorCode.NOT_FOUND,
            message: `Phase with ID ${id} not found in cache after fetching all.`,
          }),
        ),
      )((phases) => O.fromNullable(phases.find((phase) => phase.id === id))),
    );

  const findAllPhases = (): TE.TaskEither<ServiceError, Phases> =>
    pipe(cache.getAllPhases(), TE.mapLeft(mapDomainErrorToServiceError));

  const syncPhasesFromApi = (): TE.TaskEither<ServiceError, void> =>
    pipe(
      fplDataService.getPhases(),
      TE.mapLeft((error: DataLayerError) =>
        createServiceIntegrationError({
          message: 'Failed to fetch/map phases via data layer',
          cause: error.cause,
          details: error.details,
        }),
      ),
      TE.chainFirstW(() =>
        pipe(domainOps.deleteAllPhases(), TE.mapLeft(mapDomainErrorToServiceError)),
      ),
      TE.chainW((phasesCreateData: PhaseCreateInputs) =>
        pipe(domainOps.savePhases(phasesCreateData), TE.mapLeft(mapDomainErrorToServiceError)),
      ),
      TE.chainFirstW((savedPhases: Phases) =>
        pipe(cache.setAllPhases(savedPhases), TE.mapLeft(mapDomainErrorToServiceError)),
      ),
      TE.map(() => undefined),
    );

  return {
    findPhaseById,
    findAllPhases,
    syncPhasesFromApi,
  };
};

export const createPhaseService = (
  fplDataService: FplBootstrapDataService,
  repository: PhaseRepository,
  cache: PhaseCache,
): PhaseService => {
  const domainOps = createPhaseOperations(repository);
  const ops = phaseServiceOperations(fplDataService, domainOps, cache);

  return {
    getPhases: (): TE.TaskEither<ServiceError, Phases> => ops.findAllPhases(),
    getPhase: (id: PhaseId): TE.TaskEither<ServiceError, Phase> => ops.findPhaseById(id),
    syncPhasesFromApi: (): TE.TaskEither<ServiceError, void> => ops.syncPhasesFromApi(),
  };
};
