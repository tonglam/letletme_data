import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { Logger } from 'pino';
import { apiConfig } from 'src/configs/api/api.config';
import { mapEntryHistoryResponseToDomain } from 'src/data/fpl/mappers/history/history.mapper';
import {
  EntryHistoryResponse,
  EntryHistoryResponseSchema,
} from 'src/data/fpl/schemas/history/history.schema';
import { HTTPClient } from 'src/infrastructures/http';
import { EntryHistoryInfos } from 'src/types/domain/entry-history-info.type';
import { DataLayerError, DataLayerErrorCode } from 'src/types/error.type';
import { createDataLayerError } from 'src/utils/error.util';

import { FplHistoryDataService } from '../types';

export const createFplHistoryDataService = (
  client: HTTPClient,
  logger: Logger,
): FplHistoryDataService => {
  let cachedHistoryResponse: EntryHistoryResponse | null = null;

  const fetchAndValidateHistories = (
    entry: number,
  ): TE.TaskEither<DataLayerError, EntryHistoryResponse> => {
    logger.info({ operation: `fetchAndValidateHistory(${entry})` }, 'Fetching FPL entry history');

    return pipe(
      client.get<unknown>(apiConfig.endpoints.entry.history({ entry: entry })),
      TE.mapLeft((apiError) => {
        logger.error(
          {
            operation: 'fetchAndValidateHistory',
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
        const parsed = EntryHistoryResponseSchema.safeParse(response);
        if (!parsed.success) {
          logger.error(
            {
              operation: 'fetchAndValidateHistory',
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
              cause: parsed.error,
              details: {
                errorMessage: parsed.error.message,
                validationError: parsed.error.format(),
              },
            }),
          );
        }
        logger.info(
          {
            operation: 'fetchAndValidateHistory',
            success: true,
            historyInfosCount: parsed.data.past.length,
          },
          'FPL API call successful and validated',
        );
        cachedHistoryResponse = parsed.data;
        return TE.right(parsed.data);
      }),
    );
  };

  const getFplHistoryDataInternal = (
    entry: number,
  ): TE.TaskEither<DataLayerError, EntryHistoryResponse> => {
    if (cachedHistoryResponse) {
      return TE.right(cachedHistoryResponse);
    }
    return fetchAndValidateHistories(entry);
  };

  const getHistoryInfos = (entry: number): TE.TaskEither<DataLayerError, EntryHistoryInfos> =>
    pipe(
      getFplHistoryDataInternal(entry),
      TE.chain((historyData) =>
        pipe(
          historyData.past,
          TE.traverseArray((historyInfoResponse) =>
            pipe(
              mapEntryHistoryResponseToDomain(entry, historyInfoResponse),
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
    getHistoryInfos: getHistoryInfos,
  };
};
