import { apiConfig } from 'config/api/api.config';
import { mapEntryHistoryResponseToDomain } from 'data/fpl/mappers/history/history.mapper';
import {
  EntryHistoryResponse,
  EntryHistoryResponseSchema,
} from 'data/fpl/schemas/history/history.schema';
import { FplHistoryDataService } from 'data/types';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { EntryHistoryInfos } from 'types/domain/entry-history-info.type';
import { EntryId } from 'types/domain/entry-info.type';
import { DataLayerError, DataLayerErrorCode } from 'types/error.type';
import { createDataLayerError } from 'utils/error.util';
import { FplApiContext, logFplApiCall, logFplApiError } from 'utils/logger.util';

export const createFplHistoryDataService = (): FplHistoryDataService => {
  let cachedHistoryResponse: EntryHistoryResponse | null = null;

  const fetchAndValidateHistories = (
    entryId: EntryId,
  ): TE.TaskEither<DataLayerError, EntryHistoryResponse> => {
    const urlPath = apiConfig.endpoints.entry.history({ entryId });
    const context: FplApiContext = {
      service: 'FplHistoryDataService',
      endpoint: urlPath,
      entryId,
    };
    logFplApiCall('Attempting to fetch FPL entry history', context);

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

        const parsed = EntryHistoryResponseSchema.safeParse(data);
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
          entryId,
          success: true,
          historyInfosCount: parsed.data.past.length,
        });
        cachedHistoryResponse = parsed.data;
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
              message: 'Invalid response data for entry history',
              details: {
                entryId,
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
          message: 'An unexpected error occurred during FPL history fetch or processing',
          cause: error instanceof Error ? error : undefined,
          details: { entryId, error },
        });
        logFplApiError(unexpectedError, { ...context, err: unexpectedError });
        return unexpectedError;
      },
    )();
  };

  const getFplHistoryDataInternal = (
    entryId: EntryId,
  ): TE.TaskEither<DataLayerError, EntryHistoryResponse> => {
    if (cachedHistoryResponse) {
      return TE.right(cachedHistoryResponse);
    }
    return fetchAndValidateHistories(entryId);
  };

  const getHistories = (entryId: EntryId): TE.TaskEither<DataLayerError, EntryHistoryInfos> =>
    pipe(
      getFplHistoryDataInternal(entryId),
      TE.chain((historyData) =>
        pipe(
          historyData.past,
          TE.traverseArray((historyInfoResponse) =>
            pipe(
              mapEntryHistoryResponseToDomain(entryId, historyInfoResponse),
              E.mapLeft((mappingError) =>
                createDataLayerError({
                  code: DataLayerErrorCode.MAPPING_ERROR,
                  message: `Failed to map entry history info: ${mappingError}`,
                }),
              ),
              TE.fromEither,
            ),
          ),
        ),
      ),
    );

  return {
    getHistories,
  };
};
