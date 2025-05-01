import { PhaseCache } from 'domain/phase/types';

import { FplBootstrapDataService } from 'data/types';
import { pipe } from 'fp-ts/function';
import * as O from 'fp-ts/Option';
import * as TE from 'fp-ts/TaskEither';
import { PhaseCreateInputs, PhaseRepository } from 'repository/phase/types';
import { PhaseService, PhaseServiceOperations } from 'service/phase/types';
import { Phase, PhaseId, Phases } from 'types/domain/phase.type';
import { CacheErrorCode, createCacheError, ServiceError } from 'types/error.type';
import {
  mapCacheErrorToServiceError,
  mapDBErrorToServiceError,
  mapDataLayerErrorToServiceError,
} from 'utils/error.util';

const phaseServiceOperations = (
  fplDataService: FplBootstrapDataService,
  repository: PhaseRepository,
  cache: PhaseCache,
): PhaseServiceOperations => {
  const findPhaseById = (id: PhaseId): TE.TaskEither<ServiceError, Phase> =>
    pipe(
      cache.getAllPhases(),
      TE.mapLeft(mapCacheErrorToServiceError),
      TE.chainOptionK(() =>
        mapCacheErrorToServiceError(
          createCacheError({
            code: CacheErrorCode.NOT_FOUND,
            message: `Phase with ID ${id} not found in cache after fetching all.`,
          }),
        ),
      )((phases) => O.fromNullable(phases.find((phase) => phase.id === id))),
    );

  const findAllPhases = (): TE.TaskEither<ServiceError, Phases> =>
    pipe(cache.getAllPhases(), TE.mapLeft(mapCacheErrorToServiceError));

  const syncPhasesFromApi = (): TE.TaskEither<ServiceError, void> =>
    pipe(
      fplDataService.getPhases(),
      TE.mapLeft(mapDataLayerErrorToServiceError),
      TE.chainFirstW(() => pipe(repository.deleteAll(), TE.mapLeft(mapDBErrorToServiceError))),
      TE.chainW((phasesCreateData: PhaseCreateInputs) =>
        pipe(
          phasesCreateData.length > 0
            ? repository.saveBatch(phasesCreateData)
            : TE.right([] as Phases),
          TE.mapLeft(mapDBErrorToServiceError),
        ),
      ),
      TE.chainFirstW((savedPhases: Phases) =>
        pipe(cache.setAllPhases(savedPhases), TE.mapLeft(mapCacheErrorToServiceError)),
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
  const ops = phaseServiceOperations(fplDataService, repository, cache);

  return {
    getPhases: (): TE.TaskEither<ServiceError, Phases> => ops.findAllPhases(),
    getPhase: (id: PhaseId): TE.TaskEither<ServiceError, Phase> => ops.findPhaseById(id),
    syncPhasesFromApi: (): TE.TaskEither<ServiceError, void> => ops.syncPhasesFromApi(),
  };
};
