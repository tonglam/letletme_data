import { createPlayerValueOperations } from 'domains/player-value/operation';
import {
  PlayerValueCache,
  PlayerValueOperations,
  PlayerValueRepository,
} from 'domains/player-value/types';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { EventService } from 'services/event/types';
import { PlayerValueService, PlayerValueServiceOperations } from 'services/player-value/types';
import { FplBootstrapDataService } from 'src/data/types';
import { PrismaPlayerValueCreate } from 'src/repositories/player-value/type';
import {
  MappedPlayerValue,
  PlayerValue,
  PlayerValueId,
  PlayerValues,
} from 'src/types/domain/player-value.type';
import {
  createServiceError,
  DataLayerError,
  ServiceError,
  ServiceErrorCode,
} from 'src/types/error.type';
import { createServiceIntegrationError, mapDomainErrorToServiceError } from 'src/utils/error.util';

export const playerValueServiceOperations = (
  domainOps: PlayerValueOperations,
  fplDataService: FplBootstrapDataService,
  eventService: EventService,
): PlayerValueServiceOperations => ({
  findAllPlayerValues: () =>
    pipe(domainOps.getAllPlayerValues(), TE.mapLeft(mapDomainErrorToServiceError)) as TE.TaskEither<
      ServiceError,
      PlayerValues
    >,

  findPlayerValueById: (id: PlayerValueId) =>
    pipe(
      domainOps.getPlayerValueById(id),
      TE.mapLeft(mapDomainErrorToServiceError),
    ) as TE.TaskEither<ServiceError, PlayerValue | null>,

  syncPlayerValuesFromApi: () =>
    pipe(
      eventService.getCurrentEvent(),
      TE.mapLeft((error: ServiceError) =>
        createServiceError({
          code: ServiceErrorCode.OPERATION_ERROR,
          message: 'Failed to fetch current event',
          cause: error,
        }),
      ),
      TE.chainW((event) =>
        event
          ? TE.right(event.id)
          : TE.left(
              createServiceError({
                code: ServiceErrorCode.OPERATION_ERROR,
                message: 'No current event found to sync player values for.',
              }),
            ),
      ),
      TE.chainW((eventId) => fplDataService.getPlayerValues(eventId)),
      TE.mapLeft((error: DataLayerError | ServiceError) =>
        createServiceIntegrationError({
          message: 'Failed to fetch/map player values via data layer',
          cause: error.cause,
          details: error.details,
        }),
      ),
      TE.map((rawData: readonly MappedPlayerValue[]) =>
        mapRawDataToPlayerValueCreateArray(rawData),
      ),
      TE.chain((playerValueCreateData) =>
        pipe(
          domainOps.savePlayerValues(playerValueCreateData),
          TE.mapLeft(mapDomainErrorToServiceError),
        ),
      ),
    ) as TE.TaskEither<ServiceError, PlayerValues>,
});

const mapRawDataToPlayerValueCreateArray = (
  rawData: readonly MappedPlayerValue[],
): PrismaPlayerValueCreate[] => {
  return rawData.map((playerValue) => playerValue as PrismaPlayerValueCreate);
};

export const createPlayerValueService = (
  fplDataService: FplBootstrapDataService,
  repository: PlayerValueRepository,
  cache: PlayerValueCache,
  eventService: EventService,
): PlayerValueService => {
  const domainOps = createPlayerValueOperations(repository, cache);
  const ops = playerValueServiceOperations(domainOps, fplDataService, eventService);

  return {
    getPlayerValues: () => ops.findAllPlayerValues(),
    getPlayerValue: (id: PlayerValueId) => ops.findPlayerValueById(id),
    syncPlayerValuesFromApi: () => ops.syncPlayerValuesFromApi(),
  };
};
