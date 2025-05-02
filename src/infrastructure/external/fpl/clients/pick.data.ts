import { RawEntryEventPicks } from '@app/domain/models/entry-event-pick.model';
import { EntryID, EventID } from '@app/domain/types/id.types';
import { apiConfig } from '@app/infrastructure/config/api.config';
import { FplPickDataService } from '@app/infrastructure/external/fpl/clients/types';
import { mapPickResponseToEntryEventPick } from '@app/infrastructure/external/fpl/mappers/pick/pick.mapper';
import {
  PickResponse,
  PickResponseSchema,
} from '@app/infrastructure/external/fpl/schemas/pick/pick.schema';
import { DataLayerError, DataLayerErrorCode } from '@app/shared/types/error.types';
import { createDataLayerError } from '@app/shared/utils/error.util';
import { FplApiContext, logFplApiCall, logFplApiError } from '@app/shared/utils/logger.util';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';

export const createFplPickDataService = (): FplPickDataService => {
  let cachedPickResponse: PickResponse | null = null;

  const fetchAndValidatePicks = (
    entryId: EntryID,
    eventId: EventID,
  ): TE.TaskEither<DataLayerError, PickResponse> => {
    const urlPath = apiConfig.endpoints.entry.picks({ entryId, eventId });
    const context: FplApiContext = {
      service: 'FplPickDataService',
      endpoint: urlPath,
      entryId,
      eventId,
    };
    logFplApiCall('Attempting to fetch FPL picks', context);

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

        const parsed = PickResponseSchema.safeParse(data);
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

        logFplApiCall('FPL picks fetched and validated', {
          ...context,
        });
        cachedPickResponse = parsed.data;
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
                entryId,
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
              message: 'Invalid response data for picks',
              details: {
                entryId,
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
          message: 'An unexpected error occurred during FPL picks fetch or processing',
          cause: error instanceof Error ? error : undefined,
          details: { entryId, eventId, error },
        });
        logFplApiError(unexpectedError, { ...context, err: unexpectedError });
        return unexpectedError;
      },
    )();
  };

  const getFplPickDataInternal = (
    entryId: EntryID,
    eventId: EventID,
  ): TE.TaskEither<DataLayerError, PickResponse> => {
    if (cachedPickResponse) {
      return TE.right(cachedPickResponse);
    }
    return fetchAndValidatePicks(entryId, eventId);
  };

  const getPicks = (
    entryId: EntryID,
    eventId: EventID,
  ): TE.TaskEither<DataLayerError, RawEntryEventPicks> =>
    pipe(
      getFplPickDataInternal(entryId, eventId),
      TE.chain((pickResponse) =>
        pipe(
          mapPickResponseToEntryEventPick(entryId, eventId, pickResponse),
          E.mapLeft((mappingError) =>
            createDataLayerError({
              code: DataLayerErrorCode.MAPPING_ERROR,
              message: `Failed to map entry event pick: ${mappingError}`,
            }),
          ),
          TE.fromEither,
          TE.map((mappedPick) => [mappedPick]),
        ),
      ),
    );

  return {
    getPicks,
  };
};
