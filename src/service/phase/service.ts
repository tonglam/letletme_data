// Phase Service Module
// Provides business logic for Phase operations, implementing caching and error handling.
// Uses functional programming principles for type-safe operations.

import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { createPhaseOperations } from '../../domain/phase/operation';
import { PhaseCache, PhaseOperations } from '../../domain/phase/types';
import { APIError, ServiceError } from '../../types/error.type';
import {
  Phase,
  PhaseId,
  PhaseRepository,
  PhaseResponse,
  Phases,
  toDomainPhase,
} from '../../types/phase.type';
import { createServiceIntegrationError } from '../../utils/error.util';
import { mapDomainError } from '../utils';
import type {
  PhaseService,
  PhaseServiceDependencies,
  PhaseServiceOperations,
  PhaseServiceWithWorkflows,
} from './types';
import { phaseWorkflows } from './workflow';

// Implementation of service operations
const phaseServiceOperations = (domainOps: PhaseOperations): PhaseServiceOperations => ({
  findAllPhases: () =>
    pipe(domainOps.getAllPhases(), TE.mapLeft(mapDomainError)) as TE.TaskEither<
      ServiceError,
      Phases
    >,

  findPhaseById: (id: PhaseId) =>
    pipe(domainOps.getPhaseById(id), TE.mapLeft(mapDomainError)) as TE.TaskEither<
      ServiceError,
      Phase | null
    >,

  syncPhasesFromApi: (bootstrapApi: PhaseServiceDependencies['bootstrapApi']) =>
    pipe(
      bootstrapApi.getBootstrapPhases(),
      TE.mapLeft((error: APIError) =>
        createServiceIntegrationError({
          message: 'Failed to fetch phases from API',
          cause: error,
        }),
      ),
      TE.chain((phases: readonly PhaseResponse[]) =>
        pipe(
          TE.right(phases.map(toDomainPhase)),
          TE.chain((domainPhases) =>
            pipe(
              domainOps.deleteAll(),
              TE.mapLeft(mapDomainError),
              TE.chain(() =>
                pipe(domainOps.createPhases(domainPhases), TE.mapLeft(mapDomainError)),
              ),
            ),
          ),
        ),
      ),
    ) as TE.TaskEither<ServiceError, Phases>,
});

export const createPhaseService = (
  bootstrapApi: PhaseServiceDependencies['bootstrapApi'],
  repository: PhaseRepository,
  cache: PhaseCache = {
    getAllPhases: () => TE.right([]),
    getPhase: () => TE.right(null),
    warmUp: () => TE.right(undefined),
    cachePhase: () => TE.right(undefined),
    cachePhases: () => TE.right(undefined),
  },
): PhaseServiceWithWorkflows => {
  const domainOps = createPhaseOperations(repository, cache);
  const ops = phaseServiceOperations(domainOps);

  const service: PhaseService = {
    getPhases: () => ops.findAllPhases(),
    getPhase: (id: PhaseId) => ops.findPhaseById(id),
    savePhases: (phases: Phases) =>
      pipe(domainOps.createPhases(phases), TE.mapLeft(mapDomainError)),
    syncPhasesFromApi: () => ops.syncPhasesFromApi(bootstrapApi),
  };

  return {
    ...service,
    workflows: phaseWorkflows(service),
  };
};
