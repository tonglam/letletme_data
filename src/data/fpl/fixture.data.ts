import { apiConfig } from 'config/api/api.config';
import { mapEventFixtureResponseToDomain } from 'data/fpl/mappers/fixture/fixture.mapper';
import {
  EventFixturesResponse,
  EventFixturesResponseSchema,
} from 'data/fpl/schemas/fixture/fixture.schema';
import { FplFixtureDataService } from 'data/types';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { RawEventFixtures } from 'types/domain/event-fixture.type';
import { EventId } from 'types/domain/event.type';
import { DataLayerError, DataLayerErrorCode } from 'types/error.type';
import { createDataLayerError } from 'utils/error.util';
import { FplApiContext, logFplApiCall, logFplApiError } from 'utils/logger.util';

export const createFplFixtureDataService = (): FplFixtureDataService => {
  let cachedFixturesResponse: EventFixturesResponse | null = null;

  const fetchAndValidateFixtures = (
    eventId: EventId,
  ): TE.TaskEither<DataLayerError, EventFixturesResponse> => {
    const urlPath = apiConfig.endpoints.event.fixtures({ eventId });
    const context: FplApiContext = {
      service: 'FplFixtureDataService',
      endpoint: urlPath,
      eventId,
    };
    logFplApiCall('Attempting to fetch FPL fixtures data', context);

    return TE.tryCatchK(
      async () => {
        const fullUrl = `${apiConfig.baseUrl}${urlPath}`;
        const response = await fetch(fullUrl);

        if (!response.ok) {
          throw {
            type: 'HttpError',
            status: response.status,
            statusText: response.statusText,
            url: fullUrl,
          };
        }

        const data: unknown = await response.json();

        const parsed = EventFixturesResponseSchema.safeParse(data);
        if (!parsed.success) {
          throw {
            type: 'ValidationError',
            message: 'Invalid response data',
            validationError: parsed.error.format(),
            response: data,
          };
        }

        logFplApiCall('FPL API call successful and validated', {
          ...context,
          eventId,
          success: true,
          fixtureCount: parsed.data.length,
        });
        cachedFixturesResponse = parsed.data;
        return parsed.data;
      },
      (error: unknown): DataLayerError => {
        if (typeof error === 'object' && error !== null && 'type' in error) {
          const errorObj = error as { type: string };

          if (
            errorObj.type === 'HttpError' &&
            'status' in error &&
            typeof error.status === 'number' &&
            'statusText' in error &&
            typeof error.statusText === 'string' &&
            'url' in error &&
            typeof error.url === 'string'
          ) {
            const httpError = createDataLayerError({
              code: DataLayerErrorCode.FETCH_ERROR,
              message: `FPL API HTTP Error: ${error.status} ${error.statusText}`,
              details: {
                eventId,
                status: error.status,
                statusText: error.statusText,
                url: error.url,
              },
            });
            logFplApiError(httpError, { ...context, err: httpError });
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
              message: 'Invalid response data for event fixtures',
              details: {
                eventId,
                validationError: error.validationError,
                response: error.response,
              },
            });
            logFplApiError(validationError, { ...context, err: validationError });
            return validationError;
          }
        }

        const unexpectedError = createDataLayerError({
          code: DataLayerErrorCode.FETCH_ERROR,
          message: 'An unexpected error occurred during FPL fixtures fetch or processing',
          cause: error instanceof Error ? error : undefined,
          details: { eventId, error },
        });
        logFplApiError(unexpectedError, { ...context, err: unexpectedError });
        return unexpectedError;
      },
    )();
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
