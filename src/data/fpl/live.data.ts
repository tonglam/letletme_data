import { mapEventLiveExplainResponseToDomain } from 'data/fpl/mappers/live/explain.mapper';
import { mapEventLiveResponseToDomain } from 'data/fpl/mappers/live/live.mapper';
import {
  EventLiveResponseSchema,
  EventLiveResponse,
} from 'data/fpl/schemas/live/event-live.schema';
import { FplLiveDataService } from 'data/types';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { apiConfig } from 'src/config/api/api.config';
import { EventLiveExplains } from 'types/domain/event-live-explain.type';
import { RawEventLives } from 'types/domain/event-live.type';
import { EventId } from 'types/domain/event.type';
import { DataLayerError, DataLayerErrorCode } from 'types/error.type';
import { createDataLayerError } from 'utils/error.util';
import { FplApiContext, logFplApiCall, logFplApiError } from 'utils/logger.util';

export const createFplLiveDataService = (): FplLiveDataService => {
  let cachedEventResponse: EventLiveResponse | null = null;

  const fetchAndValidateEvents = (
    eventId: EventId,
  ): TE.TaskEither<DataLayerError, EventLiveResponse> => {
    const urlPath = apiConfig.endpoints.event.live({ eventId });
    const context: FplApiContext = {
      service: 'FplLiveDataService',
      endpoint: urlPath,
      eventId,
    };
    logFplApiCall('Attempting to fetch FPL event live data', context);

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

        const parsed = EventLiveResponseSchema.safeParse(data);
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
        });
        cachedEventResponse = parsed.data;
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
              message: 'Invalid response data for event live',
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
          message: 'An unexpected error occurred during FPL event live fetch or processing',
          cause: error instanceof Error ? error : undefined,
          details: { eventId, error },
        });
        logFplApiError(unexpectedError, { ...context, err: unexpectedError });
        return unexpectedError;
      },
    )();
  };

  const getFplEventDataInternal = (
    eventId: EventId,
  ): TE.TaskEither<DataLayerError, EventLiveResponse> => {
    if (cachedEventResponse) {
      return TE.right(cachedEventResponse);
    }
    return fetchAndValidateEvents(eventId);
  };

  const getLives = (eventId: EventId): TE.TaskEither<DataLayerError, RawEventLives> =>
    pipe(
      getFplEventDataInternal(eventId),
      TE.chain((eventData) =>
        pipe(
          eventData.elements.map((element) => element.stats),
          TE.traverseArray((element) =>
            pipe(
              mapEventLiveResponseToDomain(eventId, element.stats),
              E.mapLeft((mappingError) =>
                createDataLayerError({
                  code: DataLayerErrorCode.MAPPING_ERROR,
                  message: `Failed to map event live: ${mappingError}`,
                }),
              ),
              TE.fromEither,
            ),
          ),
        ),
      ),
    );

  const getExplains = (eventId: EventId): TE.TaskEither<DataLayerError, EventLiveExplains> =>
    pipe(
      getFplEventDataInternal(eventId),
      TE.chain((eventData) =>
        pipe(
          eventData.elements.flatMap((element) => element.explain),
          TE.traverseArray((explainResponse) =>
            pipe(
              mapEventLiveExplainResponseToDomain(eventId, explainResponse),
              E.mapLeft((mappingError) =>
                createDataLayerError({
                  code: DataLayerErrorCode.MAPPING_ERROR,
                  message: `Failed to map event live explain: ${mappingError}`,
                }),
              ),
              TE.fromEither,
            ),
          ),
        ),
      ),
    );

  return {
    getLives,
    getExplains,
  };
};
