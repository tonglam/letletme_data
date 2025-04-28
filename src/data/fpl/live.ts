import { apiConfig } from 'configs/api/api.config';
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
import { HTTPClient } from 'infrastructures/http';
import { Logger } from 'pino';
import { EventLiveExplains } from 'types/domain/event-live-explain.type';
import { RawEventLives } from 'types/domain/event-live.type';
import { EventId } from 'types/domain/event.type';
import { DataLayerError, DataLayerErrorCode } from 'types/error.type';
import { createDataLayerError } from 'utils/error.util';

export const createFplLiveDataService = (
  client: HTTPClient,
  logger: Logger,
): FplLiveDataService => {
  let cachedEventResponse: EventLiveResponse | null = null;

  const fetchAndValidateEvents = (
    eventId: EventId,
  ): TE.TaskEither<DataLayerError, EventLiveResponse> => {
    logger.info({ operation: `fetchAndValidateEvent(${eventId})` }, 'Fetching FPL event data');

    return pipe(
      client.get<EventLiveResponse>(apiConfig.endpoints.event.live({ eventId: eventId })),
      TE.mapLeft((apiError) => {
        logger.error(
          {
            operation: 'fetchAndValidateEventLive',
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
        const parsed = EventLiveResponseSchema.safeParse(response);
        if (!parsed.success) {
          logger.error(
            {
              operation: 'fetchAndValidateEventLive',
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
              message: 'Invalid event live data received from FPL API',
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
            operation: 'fetchAndValidateEventLive',
            success: true,
          },
          'FPL API call successful and validated',
        );
        cachedEventResponse = parsed.data;
        return TE.right(parsed.data);
      }),
    );
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
