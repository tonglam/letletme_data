import { RawEventOverallResult } from '@app/domain/models/event-overall-result.model';
import { Events } from '@app/domain/models/event.type';
import { PhasesModel } from '@app/domain/models/phase.model';
import { RawPlayerStats } from '@app/domain/models/player-stat.model';
import { PlayerValueTracks } from '@app/domain/models/player-value-track.model';
import { SourcePlayerValues } from '@app/domain/models/player-value.model';
import { RawPlayers } from '@app/domain/models/player.model';
import { EventID } from '@app/domain/shared/types/id.types';
import { apiConfig } from '@app/infrastructure/config/api.config';
import { FplBootstrapDataService } from '@app/infrastructure/external/fpl/clients/types';
import {
  mapElementResponseToPlayer,
  mapElementResponseToPlayerStat,
  mapElementResponseToPlayerValue,
  mapElementResponseToPlayerValueTrack,
} from '@app/infrastructure/external/fpl/mappers/bootstrap/element.mapper';
import { mapEventResponseToEvent } from '@app/infrastructure/external/fpl/mappers/bootstrap/event.mapper';
import { mapEventResponseToEventOverallResult } from '@app/infrastructure/external/fpl/mappers/bootstrap/overall-result.mapper';
import { mapPhaseResponseToPhase } from '@app/infrastructure/external/fpl/mappers/bootstrap/phase.mapper';
import { mapTeamResponseToTeam } from '@app/infrastructure/external/fpl/mappers/bootstrap/team.mapper';
import {
  BootStrapResponse,
  BootStrapResponseSchema,
} from '@app/infrastructure/external/fpl/schemas/bootstrap/bootstrap.schema';
import { TeamCreateInputs } from '@app/infrastructure/persistence/drizzle/repositories/team/types';
import { DataLayerError, DataLayerErrorCode } from '@app/shared/types/error.types';
import { createDataLayerError } from '@app/shared/utils/error.util';
import { FplApiContext, logFplApiCall, logFplApiError } from '@app/shared/utils/logger.util';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';

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
        const url = `${apiConfig.baseUrl}${apiConfig.endpoints.bootstrap.static}`;
        const response = await fetch(url);

        if (!response.ok) {
          throw {
            type: 'HttpError',
            status: response.status,
            statusText: response.statusText,
            url: url,
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

        // Fallback for other errors:
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorDetails = { originalError: String(error) }; // Stringify original error for details

        const unexpectedError = createDataLayerError({
          code: DataLayerErrorCode.FETCH_ERROR,
          message: `An unexpected error occurred during FPL API fetch or processing: ${errorMessage}`,
          cause: error instanceof Error ? error : undefined,
          details: errorDetails,
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

  const getPhases = (): TE.TaskEither<DataLayerError, PhasesModel> =>
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

  const getTeams = (): TE.TaskEither<DataLayerError, TeamCreateInputs> =>
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
          TE.map((teams) => teams as TeamCreateInputs),
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

  const getPlayerStats = (eventId: EventID): TE.TaskEither<DataLayerError, RawPlayerStats> =>
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

  const getPlayerValues = (eventId: EventID): TE.TaskEither<DataLayerError, SourcePlayerValues> =>
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
    eventId: EventID,
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

  const getEventOverallResults = (
    eventId: EventID,
  ): TE.TaskEither<DataLayerError, RawEventOverallResult> =>
    pipe(
      getFplBootstrapDataInternal(),
      TE.chain((bootstrapData) => {
        const eventResponse = bootstrapData.events.find((e) => e.id === eventId);
        if (!eventResponse) {
          return TE.left(
            createDataLayerError({
              code: DataLayerErrorCode.INTERNAL_ERROR,
              message: `Event with ID ${eventId} not found in bootstrap data.`,
            }),
          );
        }
        return pipe(
          mapEventResponseToEventOverallResult(eventResponse),
          E.mapLeft((mappingError) =>
            createDataLayerError({
              code: DataLayerErrorCode.MAPPING_ERROR,
              message: `Failed to map event overall result for event ${eventId}: ${mappingError}`,
            }),
          ),
          TE.fromEither,
        );
      }),
    );

  return {
    getEvents,
    getPhases,
    getTeams,
    getPlayers,
    getPlayerStats,
    getPlayerValues,
    getPlayerValueTracks,
    getEventOverallResults,
  };
};
