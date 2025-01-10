// Player Value Service Module
// Provides business logic for Player Value operations, implementing caching and error handling.
// Uses functional programming principles for type-safe operations.

import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { createPlayerValueOperations } from '../../domain/player-value/operation';
import { PlayerValueCache, PlayerValueOperations } from '../../domain/player-value/types';
import { ElementResponse } from '../../types/element.type';
import { APIError, ServiceError } from '../../types/error.type';
import {
  PlayerValue,
  PlayerValueId,
  PlayerValueRepository,
  PlayerValues,
  toDomainPlayerValue,
} from '../../types/player-value.type';
import { createServiceIntegrationError } from '../../utils/error.util';
import { mapDomainError } from '../utils';
import type {
  PlayerValueService,
  PlayerValueServiceDependencies,
  PlayerValueServiceOperations,
  PlayerValueServiceWithWorkflows,
} from './types';
import { playerValueWorkflows } from './workflow';

// Implementation of service operations
const playerValueServiceOperations = (
  domainOps: PlayerValueOperations,
): PlayerValueServiceOperations => ({
  findAllPlayerValues: () =>
    pipe(domainOps.getPlayerValueByChangeDate(''), TE.mapLeft(mapDomainError)) as TE.TaskEither<
      ServiceError,
      PlayerValues
    >,

  findPlayerValueById: (id: PlayerValueId) =>
    pipe(
      domainOps.getPlayerValueByChangeDate(id),
      TE.mapLeft(mapDomainError),
      TE.map((values) => (values.length > 0 ? values[0] : null)),
    ) as TE.TaskEither<ServiceError, PlayerValue | null>,

  syncPlayerValuesFromApi: (bootstrapApi: PlayerValueServiceDependencies['bootstrapApi']) =>
    pipe(
      bootstrapApi.getBootstrapElements(),
      TE.mapLeft((error: APIError) =>
        createServiceIntegrationError({
          message: 'Failed to fetch player values from API',
          cause: error,
        }),
      ),
      TE.chain((elements: readonly ElementResponse[]) =>
        pipe(
          TE.right(elements.map(toDomainPlayerValue)),
          TE.chain((domainValues) =>
            pipe(domainOps.createPlayerValues(domainValues), TE.mapLeft(mapDomainError)),
          ),
        ),
      ),
    ) as TE.TaskEither<ServiceError, PlayerValues>,
});

export const createPlayerValueService = (
  bootstrapApi: PlayerValueServiceDependencies['bootstrapApi'],
  repository: PlayerValueRepository,
  cache: PlayerValueCache = {
    findByChangeDate: () => TE.right([]),
  },
): PlayerValueServiceWithWorkflows => {
  const domainOps = createPlayerValueOperations(repository, cache);
  const ops = playerValueServiceOperations(domainOps);

  const service: PlayerValueService = {
    getPlayerValues: () => ops.findAllPlayerValues(),
    getPlayerValue: (id: PlayerValueId) => ops.findPlayerValueById(id),
    savePlayerValues: (values: PlayerValues) =>
      pipe(domainOps.createPlayerValues(values), TE.mapLeft(mapDomainError)),
    syncPlayerValuesFromApi: () => ops.syncPlayerValuesFromApi(bootstrapApi),
  };

  return {
    ...service,
    workflows: playerValueWorkflows(service),
  };
};
