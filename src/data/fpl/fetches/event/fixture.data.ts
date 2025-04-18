import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { Logger } from 'pino';
import {
  EventFixturesResponse,
  EventFixturesResponseSchema,
} from 'src/data/fpl/schemas/event/fixture.schema';
import { EventFixtures } from 'src/types/domain/event-fixture.type';
import { DataLayerError, DataLayerErrorCode } from 'src/types/error.type';
import { createDataLayerError } from 'src/utils/error.util';
import { apiConfig } from '../../../../configs/api/api.config';
import { HTTPClient } from '../../../../infrastructures/http/client';
import { FplEventFixtureDataService } from '../../../types';
import { mapEventFixtureResponseToDomain } from '../../mappers/event/fixture.mapper';

export const createFplEventFixtureDataService = (
  client: HTTPClient,
  logger: Logger,
): FplEventFixtureDataService => {
  let cachedEventFixturesResponse: EventFixturesResponse | null = null;

  const fetchAndValidateEventFixtures = (
    eventId: number,
  ): TE.TaskEither<DataLayerError, EventFixturesResponse> => {
    logger.info({ operation: 'fetchAndValidateEventFixtures' }, 'Fetching FPL event fixtures data');

    return pipe(
      client.get<unknown>(apiConfig.endpoints.event.fixtures({ event: eventId })),
      TE.mapLeft((apiError) => {
        logger.error(
          {
            operation: 'fetchAndValidateEventFixture',
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
        const parsed = EventFixturesResponseSchema.safeParse(response);
        if (!parsed.success) {
          logger.error(
            {
              operation: 'fetchAndValidateEventFixture',
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
              message: 'Invalid response data',
              cause: undefined,
              details: {
                validationError: parsed.error.format(),
              },
            }),
          );
        }
        logger.info(
          {
            operation: 'fetchAndValidateEventFixture',
            success: true,
            fixtureCount: parsed.data.length,
          },
          'FPL API call successful and validated',
        );
        cachedEventFixturesResponse = parsed.data;
        return TE.right(parsed.data);
      }),
    );
  };

  const getEventFixturesDataInternal = (
    eventId: number,
  ): TE.TaskEither<DataLayerError, EventFixturesResponse> => {
    if (cachedEventFixturesResponse) {
      return TE.right(cachedEventFixturesResponse);
    }
    return fetchAndValidateEventFixtures(eventId);
  };

  const getEventFixtures = (eventId: number): TE.TaskEither<DataLayerError, EventFixtures> =>
    pipe(
      getEventFixturesDataInternal(eventId),
      TE.chain((eventFixturesData) =>
        pipe(
          eventFixturesData,
          TE.traverseArray((eventFixtureResponse) =>
            pipe(
              mapEventFixtureResponseToDomain(eventFixtureResponse),
              E.mapLeft((mappingError) =>
                createDataLayerError({
                  code: DataLayerErrorCode.MAPPING_ERROR,
                  message: `Failed to map event fixture: ${mappingError}`,
                }),
              ),
              TE.fromEither,
            ),
          ),
        ),
      ),
    );

  return {
    getEventFixtures,
  };
};
