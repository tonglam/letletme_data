import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { Logger } from 'pino';
import { apiConfig } from 'src/configs/api/api.config';
import { mapEventLiveExplainResponseToDomain } from 'src/data/fpl/mappers/event/explain.mapper';
import { EventResponse, EventResponseSchema } from 'src/data/fpl/schemas/event/event.schema';
import { FplEventDataService } from 'src/data/types';
import { HTTPClient } from 'src/infrastructures/http/types';
import { EventLiveExplains } from 'src/types/domain/event-live-explain.type';
import { EventLives } from 'src/types/domain/event-live.type';
import { DataLayerError, DataLayerErrorCode } from 'src/types/error.type';
import { createDataLayerError } from 'src/utils/error.util';

import { mapEventLiveResponseToDomain } from './mappers/event/live.mapper';

export const createFplEventDataService = (
  client: HTTPClient,
  logger: Logger,
): FplEventDataService => {
  let cachedEventResponse: EventResponse | null = null;

  const fetchAndValidateEvents = (event: number): TE.TaskEither<DataLayerError, EventResponse> => {
    logger.info({ operation: `fetchAndValidateEvent(${event})` }, 'Fetching FPL event data');

    return pipe(
      client.get<unknown>(apiConfig.endpoints.event.live({ event: event })),
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
        const parsed = EventResponseSchema.safeParse(response);
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

  const getFplEventDataInternal = (event: number): TE.TaskEither<DataLayerError, EventResponse> => {
    if (cachedEventResponse) {
      return TE.right(cachedEventResponse);
    }
    return fetchAndValidateEvents(event);
  };

  const getLives = (event: number): TE.TaskEither<DataLayerError, EventLives> =>
    pipe(
      getFplEventDataInternal(event),
      TE.chain((eventData) =>
        pipe(
          eventData.elements.map((element) => element.stats),
          TE.traverseArray((element) =>
            pipe(
              mapEventLiveResponseToDomain(event, element.stats),
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

  const getExplains = (event: number): TE.TaskEither<DataLayerError, EventLiveExplains> =>
    pipe(
      getFplEventDataInternal(event),
      TE.chain((eventData) =>
        pipe(
          eventData.elements.flatMap((element) => element.explain),
          TE.traverseArray((explainResponse) =>
            pipe(
              mapEventLiveExplainResponseToDomain(event, explainResponse),
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
