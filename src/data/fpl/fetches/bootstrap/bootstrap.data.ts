import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { Logger } from 'pino';
import { Events } from 'src/types/domain/event.type';
import { Phases } from 'src/types/domain/phase.type';
import { PlayerStat } from 'src/types/domain/player-stat.type';
import { MappedPlayerValue } from 'src/types/domain/player-value.type';
import { Players } from 'src/types/domain/player.type';
import { Teams } from 'src/types/domain/team.type';
import { DataLayerError, DataLayerErrorCode } from 'src/types/error.type';
import { createDataLayerError } from 'src/utils/error.util';

import { apiConfig } from '../../../../configs/api/api.config';
import { HTTPClient } from '../../../../infrastructures/http/client';
import { FplBootstrapDataService } from '../../../types';
import {
  mapElementResponseToPlayer,
  mapElementResponseToPlayerStat,
  mapElementResponseToPlayerValue,
} from '../../mappers/bootstrap/element.mapper';
import { mapEventResponseToEvent } from '../../mappers/bootstrap/event.mapper';
import { mapPhaseResponseToPhase } from '../../mappers/bootstrap/phase.mapper';
import { mapTeamResponseToTeam } from '../../mappers/bootstrap/team.mapper';
import {
  BootStrapResponse,
  BootStrapResponseSchema,
} from '../../schemas/bootstrap/bootstrap.schema';

export const createFplBootstrapDataService = (
  client: HTTPClient,
  logger: Logger,
): FplBootstrapDataService => {
  let cachedBootstrapResponse: BootStrapResponse | null = null;

  const fetchAndValidateBootstrap = (): TE.TaskEither<DataLayerError, BootStrapResponse> => {
    logger.info({ operation: 'fetchAndValidateBootstrap' }, 'Fetching FPL bootstrap data');

    return pipe(
      client.get<unknown>(apiConfig.endpoints.bootstrap.static),
      TE.mapLeft((apiError) => {
        logger.error(
          {
            operation: 'fetchAndValidateBootstrap',
            error: apiError,
            success: false,
          },
          'FPL API call failed',
        );
        return createDataLayerError({
          code: DataLayerErrorCode.FETCH_ERROR,
          message: 'Failed to fetch data from FPL API',
          cause: apiError instanceof Error ? apiError : undefined,
          details: { apiError },
        });
      }),
      TE.chain((response) => {
        const parsed = BootStrapResponseSchema.safeParse(response);
        if (!parsed.success) {
          logger.error(
            {
              operation: 'fetchAndValidateBootstrap',
              error: {
                message: 'Invalid response data',
                validationError: parsed.error.errors,
              },
              response: response,
              success: false,
            },
            'FPL API response validation failed',
          );
          return TE.left(
            createDataLayerError({
              code: DataLayerErrorCode.VALIDATION_ERROR,
              message: 'Invalid bootstrap data received from FPL API',
              cause: undefined,
              details: {
                validationError: parsed.error.format(),
              },
            }),
          );
        }
        logger.info(
          {
            operation: 'fetchAndValidateBootstrap',
            success: true,
            eventCount: parsed.data.events.length,
            teamCount: parsed.data.teams.length,
            elementCount: parsed.data.elements.length,
          },
          'FPL API call successful and validated',
        );
        cachedBootstrapResponse = parsed.data;
        return TE.right(parsed.data);
      }),
    );
  };

  const getBootstrapDataInternal = (): TE.TaskEither<DataLayerError, BootStrapResponse> => {
    if (cachedBootstrapResponse) {
      return TE.right(cachedBootstrapResponse);
    }
    return fetchAndValidateBootstrap();
  };

  const getEvents = (): TE.TaskEither<DataLayerError, Events> =>
    pipe(
      getBootstrapDataInternal(),
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
      getBootstrapDataInternal(),
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
      getBootstrapDataInternal(),
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

  const getPlayers = (): TE.TaskEither<DataLayerError, Players> =>
    pipe(
      getBootstrapDataInternal(),
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

  const getPlayerStats = (
    eventId: number,
  ): TE.TaskEither<DataLayerError, readonly Omit<PlayerStat, 'id'>[]> =>
    pipe(
      getBootstrapDataInternal(),
      TE.chain((bootstrapData) =>
        pipe(
          bootstrapData.elements,
          TE.traverseArray((elementResponse) =>
            pipe(
              mapElementResponseToPlayerStat(elementResponse, eventId),
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

  const getPlayerValues = (
    eventId: number,
  ): TE.TaskEither<DataLayerError, readonly MappedPlayerValue[]> =>
    pipe(
      getBootstrapDataInternal(),
      TE.chain((bootstrapData) =>
        pipe(
          bootstrapData.elements,
          TE.traverseArray((elementResponse) =>
            pipe(
              mapElementResponseToPlayerValue(elementResponse, eventId),
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

  return {
    getEvents,
    getPhases,
    getTeams,
    getPlayers,
    getPlayerStats,
    getPlayerValues,
  };
};
