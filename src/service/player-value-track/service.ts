import { EventCache } from 'domain/event/types';

import { FplBootstrapDataService } from 'data/types';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import {
  PlayerValueTrackCreateInputs,
  PlayerValueTrackRepository,
} from 'repository/player-value-track/types';
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
import {
  createServiceIntegrationError,
  mapDBErrorToServiceError,
  mapCacheErrorToServiceError,
} from 'utils/error.util';

export const playerValueTrackServiceOperations = (
  fplDataService: FplBootstrapDataService,
  repository: PlayerValueTrackRepository,
  eventCache: EventCache,
): PlayerValueTrackServiceOperations => {
  const findPlayerValueTracksByDate = (
    date: string,
  ): TE.TaskEither<ServiceError, PlayerValueTracks> =>
    pipe(repository.findByDate(date), TE.mapLeft(mapDBErrorToServiceError));

  const syncPlayerValueTracksFromApi = (): TE.TaskEither<ServiceError, void> => {
    return pipe(
      eventCache.getCurrentEvent(),
      TE.mapLeft(mapCacheErrorToServiceError),
      TE.chainW((event: Event) =>
        event
          ? TE.right(event)
          : TE.left(
              createServiceError({
                code: ServiceErrorCode.INTEGRATION_ERROR,
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
                ? repository.savePlayerValueTracksByDate(
                    playerValueTracks as PlayerValueTrackCreateInputs,
                  )
                : TE.right([] as PlayerValueTracks),
              TE.mapLeft(mapDBErrorToServiceError),
            ),
          ),
        ),
      ),
      TE.map(() => undefined),
    );
  };

  return {
    findPlayerValueTracksByDate,
    syncPlayerValueTracksFromApi,
  };
};

export const createPlayerValueTrackService = (
  fplDataService: FplBootstrapDataService,
  repository: PlayerValueTrackRepository,
  eventCache: EventCache,
): PlayerValueTrackService => {
  const ops = playerValueTrackServiceOperations(fplDataService, repository, eventCache);

  return {
    getPlayerValueTracksByDate: ops.findPlayerValueTracksByDate,
    syncPlayerValueTracksFromApi: ops.syncPlayerValueTracksFromApi,
  };
};
