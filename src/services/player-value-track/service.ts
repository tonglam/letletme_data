import { createPlayerValueTrackOperations } from 'domains/player-value-track/operation';
import { PlayerValueTrackOperations } from 'domains/player-value-track/types';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import {
  PlayerValueTrackService,
  PlayerValueTrackServiceOperations,
} from 'services/player-value-track/types';
import { FplBootstrapDataService } from 'src/data/types';
import {
  PlayerValueTrackCreateInputs,
  PlayerValueTrackRepository,
} from 'src/repositories/player-value-track/type';
import { EventService } from 'src/services/event/types';
import { Event } from 'src/types/domain/event.type';
import { PlayerValueTracks } from 'src/types/domain/player-value-track.type';
import {
  DataLayerError,
  ServiceError,
  ServiceErrorCode,
  createServiceError,
} from 'src/types/error.type';
import { formatYYYYMMDD } from 'src/utils/date.util';
import { createServiceIntegrationError, mapDomainErrorToServiceError } from 'src/utils/error.util';

export const playerValueTrackServiceOperations = (
  fplDataService: FplBootstrapDataService,
  eventService: EventService,
  domainOps: PlayerValueTrackOperations,
): PlayerValueTrackServiceOperations => {
  const getPlayerValueTracksByDate = (
    date: string,
  ): TE.TaskEither<ServiceError, PlayerValueTracks> =>
    pipe(domainOps.getPlayerValueTracksByDate(date), TE.mapLeft(mapDomainErrorToServiceError));

  const syncPlayerValueTracksFromApi = (): TE.TaskEither<ServiceError, void> => {
    const date = formatYYYYMMDD();

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
          TE.chainFirstW(() =>
            pipe(
              domainOps.deletePlayerValueTracksByDate(date),
              TE.mapLeft(mapDomainErrorToServiceError),
            ),
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
  eventService: EventService,
  repository: PlayerValueTrackRepository,
): PlayerValueTrackService => {
  const domainOps = createPlayerValueTrackOperations(repository);
  const ops = playerValueTrackServiceOperations(fplDataService, eventService, domainOps);

  return {
    getPlayerValueTracksByDate: ops.findPlayerValueTracksByDate,
    syncPlayerValueTracksFromApi: ops.syncPlayerValueTracksFromApi,
  };
};
