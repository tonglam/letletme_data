import { createPlayerValueTrackOperations } from 'domain/player-value-track/operation';
import { PlayerValueTrackOperations } from 'domain/player-value-track/types';

import { FplBootstrapDataService } from 'data/types';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import {
  PlayerValueTrackCreateInputs,
  PlayerValueTrackRepository,
} from 'repository/player-value-track/types';
import { EventService } from 'service/event/types';
import {
  PlayerValueTrackService,
  PlayerValueTrackServiceOperations,
} from 'service/player-value-track/types';
import { Event } from 'types/domain/event.type';
import { PlayerValueTracks } from 'types/domain/player-value-track.type';
import {
  DataLayerError,
  ServiceError,
  ServiceErrorCode,
  createServiceError,
} from 'types/error.type';
import { createServiceIntegrationError, mapDomainErrorToServiceError } from 'utils/error.util';

export const playerValueTrackServiceOperations = (
  fplDataService: FplBootstrapDataService,
  domainOps: PlayerValueTrackOperations,
  eventService: EventService,
): PlayerValueTrackServiceOperations => {
  const getPlayerValueTracksByDate = (
    date: string,
  ): TE.TaskEither<ServiceError, PlayerValueTracks> =>
    pipe(domainOps.getPlayerValueTracksByDate(date), TE.mapLeft(mapDomainErrorToServiceError));

  const syncPlayerValueTracksFromApi = (): TE.TaskEither<ServiceError, void> => {
    return pipe(
      eventService.getCurrentEvent(),
      TE.chainW((event: Event) =>
        event
          ? TE.right(event)
          : TE.left(
              createServiceError({
                code: ServiceErrorCode.OPERATION_ERROR,
                message: 'No current event found to sync player value tracks.',
              }),
            ),
      ),
      TE.chainW((event: Event) =>
        pipe(
          fplDataService.getPlayerValueTracks(event.id),
          TE.mapLeft((error: DataLayerError) =>
            createServiceIntegrationError({
              message: 'Failed to fetch player value tracks via data layer',
              cause: error.cause,
            }),
          ),
          TE.chainW((playerValueTracks: PlayerValueTracks) =>
            pipe(
              playerValueTracks.length > 0
                ? domainOps.savePlayerValueTracksByDate(
                    playerValueTracks as PlayerValueTrackCreateInputs,
                  )
                : TE.right([] as PlayerValueTracks),
              TE.mapLeft(mapDomainErrorToServiceError),
            ),
          ),
        ),
      ),
      TE.map(() => undefined),
    );
  };

  return {
    findPlayerValueTracksByDate: getPlayerValueTracksByDate,
    syncPlayerValueTracksFromApi,
  };
};

export const createPlayerValueTrackService = (
  fplDataService: FplBootstrapDataService,
  repository: PlayerValueTrackRepository,
  eventService: EventService,
): PlayerValueTrackService => {
  const domainOps = createPlayerValueTrackOperations(repository);
  const ops = playerValueTrackServiceOperations(fplDataService, domainOps, eventService);

  return {
    getPlayerValueTracksByDate: ops.findPlayerValueTracksByDate,
    syncPlayerValueTracksFromApi: ops.syncPlayerValueTracksFromApi,
  };
};
