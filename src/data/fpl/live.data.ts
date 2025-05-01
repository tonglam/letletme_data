import { apiConfig } from 'config/api/api.config';
import { mapEventLiveExplainResponseToDomain } from 'data/fpl/mappers/live/explain.mapper';
import { mapEventLiveResponseToDomain } from 'data/fpl/mappers/live/live.mapper';
import {
  EventLiveResponseSchema,
  EventLiveResponse,
} from 'data/fpl/schemas/live/event-live.schema';
import { LiveResponse } from 'data/fpl/schemas/live/live.schema';
import { FplLiveDataService } from 'data/types';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as RA from 'fp-ts/ReadonlyArray';
import * as TE from 'fp-ts/TaskEither';
import { EventLiveExplains } from 'types/domain/event-live-explain.type';
import { RawEventLives } from 'types/domain/event-live.type';
import { EventId } from 'types/domain/event.type';
import { DataLayerError, DataLayerErrorCode } from 'types/error.type';
import { createDataLayerError } from 'utils/error.util';

export const createFplLiveDataService = (): FplLiveDataService => {
  let cachedEventResponse: EventLiveResponse | null = null;

  const fetchAndValidateEvents = (
    eventId: EventId,
  ): TE.TaskEither<DataLayerError, EventLiveResponse> => {
    const urlPath = apiConfig.endpoints.event.live({ eventId });

    return TE.tryCatchK(
      async () => {
        const fullUrl = `${apiConfig.baseUrl}${urlPath}`;

        const response = await fetch(fullUrl);

        if (!response.ok) {
          const errorDetails = {
            type: 'HttpError',
            status: response.status,
            statusText: response.statusText,
            url: fullUrl,
          };
          throw errorDetails;
        }

        const data: unknown = await response.json();

        const parsed = EventLiveResponseSchema.safeParse(data);
        if (!parsed.success) {
          const validationErrorDetails = {
            type: 'ValidationError',
            message: 'Invalid response data',
            validationError: parsed.error.format(),
          };
          throw validationErrorDetails;
        }

        // Restore cache assignment
        cachedEventResponse = parsed.data;
        return parsed.data;
      },
      (error: unknown): DataLayerError => {
        if (typeof error === 'object' && error !== null && 'type' in error) {
          const errorObj = error as {
            type: string;
            status?: number;
            statusText?: string;
            url?: string;
            validationError?: unknown;
          };
          if (errorObj.type === 'HttpError') {
            return createDataLayerError({
              code: DataLayerErrorCode.FETCH_ERROR,
              message: `FPL API HTTP Error: ${errorObj.status} ${errorObj.statusText}`,
              details: {
                eventId,
                status: errorObj.status,
                statusText: errorObj.statusText,
                url: errorObj.url,
              },
            });
          }
          if (errorObj.type === 'ValidationError') {
            return createDataLayerError({
              code: DataLayerErrorCode.VALIDATION_ERROR,
              message: 'Invalid response data for event live',
              details: { eventId, validationError: errorObj.validationError },
            });
          }
        }
        const unexpectedError = createDataLayerError({
          code: DataLayerErrorCode.FETCH_ERROR,
          message: 'An unexpected error occurred during FPL event live fetch/validation',
          cause: error instanceof Error ? error : undefined,
          details: { eventId, error },
        });
        return unexpectedError;
      },
    )();
  };

  const getFplEventDataInternal = (
    eventId: EventId,
  ): TE.TaskEither<DataLayerError, EventLiveResponse> => {
    if (cachedEventResponse && cachedEventResponse.elements[0]?.explain[0]?.fixture === eventId) {
      return TE.right(cachedEventResponse);
    }
    return fetchAndValidateEvents(eventId);
  };

  const getLives = (eventId: EventId): TE.TaskEither<DataLayerError, RawEventLives> =>
    pipe(
      getFplEventDataInternal(eventId),
      TE.chain((eventData) =>
        pipe(
          eventData.elements,
          TE.traverseArray((element) =>
            pipe(
              mapEventLiveResponseToDomain(eventId, element.id, element.stats as LiveResponse),
              E.mapLeft((mappingError) =>
                createDataLayerError({
                  code: DataLayerErrorCode.MAPPING_ERROR,
                  message: `Failed to map event live for element ${element.id}: ${mappingError}`,
                  details: { eventId, elementId: element.id, elementStats: element.stats },
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
          eventData.elements,
          TE.traverseArray((element) =>
            pipe(
              element.explain.map((explainResponse) =>
                mapEventLiveExplainResponseToDomain(eventId, element.id, explainResponse),
              ),
              E.sequenceArray,
              E.mapLeft((mappingError) =>
                createDataLayerError({
                  code: DataLayerErrorCode.MAPPING_ERROR,
                  message: `Failed to map one or more explains for element ${element.id}: ${mappingError}`,
                  details: { eventId, elementId: element.id, explains: element.explain },
                }),
              ),
              TE.fromEither,
            ),
          ),
          TE.map(RA.flatten),
        ),
      ),
    );

  return {
    getLives,
    getExplains,
  };
};
