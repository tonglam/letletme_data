import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { Logger } from 'pino';
import {
  EventFixturesResponse,
  EventFixturesResponseSchema,
} from 'src/data/fpl/schemas/fixture/fixture.schema';
import { RawEventFixtures } from 'src/types/domain/event-fixture.type';
import { EventId } from 'src/types/domain/event.type';
import { DataLayerError, DataLayerErrorCode } from 'src/types/error.type';
import { createDataLayerError } from 'src/utils/error.util';

import { apiConfig } from '../../configs/api/api.config';
import { HTTPClient } from '../../infrastructures/http';
import { FplFixtureDataService } from '../types';
import { mapEventFixtureResponseToDomain } from './mappers/fixture/fixture.mapper';

export const createFplFixtureDataService = (
  client: HTTPClient,
  logger: Logger,
): FplFixtureDataService => {
  let cachedFixturesResponse: EventFixturesResponse | null = null;

  const fetchAndValidateFixtures = (
    eventId: EventId,
  ): TE.TaskEither<DataLayerError, EventFixturesResponse> => {
    logger.info({ operation: 'fetchAndValidateEventFixtures' }, 'Fetching FPL fixtures data');

    return pipe(
      client.get<EventFixturesResponse>(apiConfig.endpoints.event.fixtures({ eventId: eventId })),
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
                errorMessage: parsed.error.message,
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
        cachedFixturesResponse = parsed.data;
        return TE.right(parsed.data);
      }),
    );
  };

  const getFplFixtureDataInternal = (
    eventId: EventId,
  ): TE.TaskEither<DataLayerError, EventFixturesResponse> => {
    if (cachedFixturesResponse) {
      return TE.right(cachedFixturesResponse);
    }
    return fetchAndValidateFixtures(eventId);
  };

  const getFixtures = (eventId: EventId): TE.TaskEither<DataLayerError, RawEventFixtures> =>
    pipe(
      getFplFixtureDataInternal(eventId),
      TE.chain((fixturesData) =>
        pipe(
          fixturesData,
          TE.traverseArray((fixtureResponse) =>
            pipe(
              mapEventFixtureResponseToDomain(fixtureResponse),
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
    getFixtures,
  };
};
