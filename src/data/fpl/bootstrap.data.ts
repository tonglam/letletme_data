import {
  mapElementResponseToPlayer,
  mapElementResponseToPlayerStat,
  mapElementResponseToPlayerValue,
  mapElementResponseToPlayerValueTrack,
} from 'data/fpl/mappers/bootstrap/element.mapper';
import { mapEventResponseToEvent } from 'data/fpl/mappers/bootstrap/event.mapper';
import { mapPhaseResponseToPhase } from 'data/fpl/mappers/bootstrap/phase.mapper';
import { mapTeamResponseToTeam } from 'data/fpl/mappers/bootstrap/team.mapper';
import {
  BootStrapResponse,
  BootStrapResponseSchema,
} from 'data/fpl/schemas/bootstrap/bootstrap.schema';
import { FplBootstrapDataService } from 'data/types';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { apiConfig } from 'src/config/api/api.config';
import { EventId, Events } from 'types/domain/event.type';
import { Phases } from 'types/domain/phase.type';
import { RawPlayerStats } from 'types/domain/player-stat.type';
import { PlayerValueTracks } from 'types/domain/player-value-track.type';
import { SourcePlayerValues } from 'types/domain/player-value.type';
import { RawPlayers } from 'types/domain/player.type';
import { Teams } from 'types/domain/team.type';
import { DataLayerError, DataLayerErrorCode } from 'types/error.type';
import { createDataLayerError } from 'utils/error.util';
import { FplApiContext, logFplApiCall, logFplApiError } from 'utils/logger.util';

export const createFplBootstrapDataService = (): FplBootstrapDataService => {
  let cachedBootstrapResponse: BootStrapResponse | null = null;

  const fetchAndValidateBootstrap = (): TE.TaskEither<DataLayerError, BootStrapResponse> => {
    const context: FplApiContext = {
      service: 'FplBootstrapDataService',
      endpoint: apiConfig.endpoints.bootstrap.static,
    };

    logFplApiCall('Attempting to fetch FPL bootstrap data', context);

    return TE.tryCatchK(
      async () => {
        const response = await fetch(apiConfig.endpoints.bootstrap.static);

        if (!response.ok) {
          throw {
            type: 'HttpError',
            status: response.status,
            statusText: response.statusText,
            url: apiConfig.endpoints.bootstrap.static,
          } satisfies Partial<DataLayerError> & {
            type: 'HttpError';
            status: number;
            statusText: string;
            url: string;
          };
        }

        const data: unknown = await response.json();

        const parsed = BootStrapResponseSchema.safeParse(data);
        if (!parsed.success) {
          throw {
            type: 'ValidationError',
            validationError: parsed.error.format(),
            response: data,
          } satisfies Partial<DataLayerError> & {
            type: 'ValidationError';
            validationError: unknown;
            response: unknown;
          };
        }

        logFplApiCall('FPL API call successful and validated', {
          ...context,
          eventCount: parsed.data.events.length,
          teamCount: parsed.data.teams.length,
          elementCount: parsed.data.elements.length,
        });
        cachedBootstrapResponse = parsed.data;
        return parsed.data;
      },
      (error: unknown): DataLayerError => {
        if (typeof error === 'object' && error !== null && 'type' in error) {
          const errorObj = error as { type: string };

          if (
            errorObj.type === 'HttpError' &&
            'status' in error &&
            'statusText' in error &&
            'url' in error &&
            typeof error.status === 'number' &&
            typeof error.statusText === 'string'
          ) {
            const httpError = createDataLayerError({
              code: DataLayerErrorCode.FETCH_ERROR,
              message: `FPL API HTTP Error: ${error.status} ${error.statusText}`,
              details: { status: error.status, statusText: error.statusText, url: error.url },
            });
            logFplApiError(httpError, context);
            return httpError;
          }
          if (
            errorObj.type === 'ValidationError' &&
            'validationError' in error &&
            'response' in error &&
            typeof (error as { message?: string }).message === 'string'
          ) {
            const validationError = createDataLayerError({
              code: DataLayerErrorCode.VALIDATION_ERROR,
              message: 'Invalid response data',
              details: { validationError: error.validationError, response: error.response },
            });
            logFplApiError(validationError, context);
            return validationError;
          }
        }

        const unexpectedError = createDataLayerError({
          code: DataLayerErrorCode.FETCH_ERROR,
          message: 'An unexpected error occurred during FPL API fetch or processing',
          cause: error instanceof Error ? error : undefined,
          details: { error },
        });
        logFplApiError(unexpectedError, context);
        return unexpectedError;
      },
    )();
  };

  const getFplBootstrapDataInternal = (): TE.TaskEither<DataLayerError, BootStrapResponse> => {
    if (cachedBootstrapResponse) {
      return TE.right(cachedBootstrapResponse);
    }
    return fetchAndValidateBootstrap();
  };

  const getEvents = (): TE.TaskEither<DataLayerError, Events> =>
    pipe(
      getFplBootstrapDataInternal(),
      TE.chain((bootstrapData) =>
        pipe(
          bootstrapData.events,
          TE.traverseArray((eventResponse) =>
            pipe(
              mapEventResponseToEvent(eventResponse),
              E.mapLeft((mappingError) =>
                createDataLayerError({
                  code: DataLayerErrorCode.MAPPING_ERROR,
                  message: `Failed to map event: ${mappingError}`,
                }),
              ),
              TE.fromEither,
            ),
          ),
        ),
      ),
    );

  const getPhases = (): TE.TaskEither<DataLayerError, Phases> =>
    pipe(
      getFplBootstrapDataInternal(),
      TE.chain((bootstrapData) =>
        pipe(
          bootstrapData.phases,
          TE.traverseArray((phaseResponse) =>
            pipe(
              mapPhaseResponseToPhase(phaseResponse),
              E.mapLeft((mappingError) =>
                createDataLayerError({
                  code: DataLayerErrorCode.MAPPING_ERROR,
                  message: `Failed to map phase: ${mappingError}`,
                }),
              ),
              TE.fromEither,
            ),
          ),
        ),
      ),
    );

  const getTeams = (): TE.TaskEither<DataLayerError, Teams> =>
    pipe(
      getFplBootstrapDataInternal(),
      TE.chain((bootstrapData) =>
        pipe(
          bootstrapData.teams,
          TE.traverseArray((teamResponse) =>
            pipe(
              mapTeamResponseToTeam(teamResponse),
              E.mapLeft((mappingError) =>
                createDataLayerError({
                  code: DataLayerErrorCode.MAPPING_ERROR,
                  message: `Failed to map team: ${mappingError}`,
                }),
              ),
              TE.fromEither,
            ),
          ),
        ),
      ),
    );

  const getPlayers = (): TE.TaskEither<DataLayerError, RawPlayers> =>
    pipe(
      getFplBootstrapDataInternal(),
      TE.chain((bootstrapData) =>
        pipe(
          bootstrapData.elements,
          TE.traverseArray((elementResponse) =>
            pipe(
              mapElementResponseToPlayer(elementResponse),
              E.mapLeft((mappingError) =>
                createDataLayerError({
                  code: DataLayerErrorCode.MAPPING_ERROR,
                  message: `Failed to map element/player: ${mappingError}`,
                }),
              ),
              TE.fromEither,
            ),
          ),
        ),
      ),
    );

  const getPlayerStats = (eventId: EventId): TE.TaskEither<DataLayerError, RawPlayerStats> =>
    pipe(
      getFplBootstrapDataInternal(),
      TE.chain((bootstrapData) =>
        pipe(
          bootstrapData.elements,
          TE.traverseArray((elementResponse) =>
            pipe(
              mapElementResponseToPlayerStat(eventId, elementResponse),
              E.mapLeft((mappingError) =>
                createDataLayerError({
                  code: DataLayerErrorCode.MAPPING_ERROR,
                  message: `Failed to map element/player stat: ${mappingError}`,
                }),
              ),
              TE.fromEither,
            ),
          ),
        ),
      ),
    );

  const getPlayerValues = (eventId: EventId): TE.TaskEither<DataLayerError, SourcePlayerValues> =>
    pipe(
      getFplBootstrapDataInternal(),
      TE.chain((bootstrapData) =>
        pipe(
          bootstrapData.elements,
          TE.traverseArray((elementResponse) =>
            pipe(
              mapElementResponseToPlayerValue(eventId, elementResponse),
              E.mapLeft((mappingError) =>
                createDataLayerError({
                  code: DataLayerErrorCode.MAPPING_ERROR,
                  message: `Failed to map element/player value: ${mappingError}`,
                }),
              ),
              TE.fromEither,
            ),
          ),
        ),
      ),
    );

  const getPlayerValueTracks = (
    eventId: EventId,
  ): TE.TaskEither<DataLayerError, PlayerValueTracks> =>
    pipe(
      getFplBootstrapDataInternal(),
      TE.chain((bootstrapData) =>
        pipe(
          bootstrapData.elements,
          TE.traverseArray((elementResponse) =>
            pipe(
              mapElementResponseToPlayerValueTrack(eventId, elementResponse),
              E.mapLeft((mappingError) =>
                createDataLayerError({
                  code: DataLayerErrorCode.MAPPING_ERROR,
                  message: `Failed to map element/player value track: ${mappingError}`,
                }),
              ),
              TE.fromEither,
            ),
          ),
        ),
      ),
    );

  return {
    getEvents,
    getPhases,
    getTeams,
    getPlayers,
    getPlayerStats,
    getPlayerValues,
    getPlayerValueTracks,
  };
};
