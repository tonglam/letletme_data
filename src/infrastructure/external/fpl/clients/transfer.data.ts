import { RawEntryEventTransfers } from '@app/domain/models/entry-event-transfer.model';
import { EntryID, EventID } from '@app/domain/types/id.types';
import { apiConfig } from '@app/infrastructure/config/api.config';
import { FplTransferDataService } from '@app/infrastructure/external/fpl/clients/types';
import { mapTransferResponseToEntryEventTransfer } from '@app/infrastructure/external/fpl/mappers/transfer/transfer.mapper';
import {
  TransferResponseSchema,
  TransfersResponse,
} from '@app/infrastructure/external/fpl/schemas/transfer/transfer.schema';
import { DataLayerError, DataLayerErrorCode } from '@app/shared/types/error.types';
import { createDataLayerError } from '@app/shared/utils/error.util';
import { FplApiContext, logFplApiCall, logFplApiError } from '@app/shared/utils/logger.util';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { z } from 'zod';

export const createFplTransferDataService = (): FplTransferDataService => {
  let cachedTransferResponse: TransfersResponse | null = null;

  const fetchAndValidateTransfers = (
    entryId: EntryID,
    eventId: EventID,
  ): TE.TaskEither<DataLayerError, TransfersResponse> => {
    const urlPath = apiConfig.endpoints.entry.transfers({ entryId, eventId });
    const context: FplApiContext = {
      service: 'FplTransferDataService',
      endpoint: urlPath,
      entryId,
      eventId,
    };
    logFplApiCall('Attempting to fetch FPL transfers', context);

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

        const parsed = z.array(TransferResponseSchema).safeParse(data);
        if (!parsed.success) {
          throw {
            type: 'ValidationError',
            message: 'Invalid response data',
            validationError: parsed.error.format(),
            response: data,
          };
        }

        logFplApiCall('FPL transfers fetched and validated', {
          ...context,
          entryId,
          eventId,
        });
        cachedTransferResponse = parsed.data;
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
              message: 'Invalid response data for transfers',
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
          message: 'An unexpected error occurred during FPL transfers fetch or processing',
          cause: error instanceof Error ? error : undefined,
          details: { entryId, eventId, error },
        });
        logFplApiError(unexpectedError, { ...context, err: unexpectedError });
        return unexpectedError;
      },
    )();
  };

  const getTransfersInternal = (
    entryId: EntryID,
    eventId: EventID,
  ): TE.TaskEither<DataLayerError, TransfersResponse> => {
    if (cachedTransferResponse) {
      return TE.right(cachedTransferResponse);
    }
    return fetchAndValidateTransfers(entryId, eventId);
  };

  const getTransfers = (
    entryId: EntryID,
    eventId: EventID,
  ): TE.TaskEither<DataLayerError, RawEntryEventTransfers> =>
    pipe(
      getTransfersInternal(entryId, eventId),
      TE.chain((transfersData) =>
        pipe(
          transfersData,
          TE.traverseArray((transferResponse) =>
            pipe(
              mapTransferResponseToEntryEventTransfer(transferResponse),
              E.mapLeft((mappingError) =>
                createDataLayerError({
                  code: DataLayerErrorCode.MAPPING_ERROR,
                  message: `Failed to map entry event transfer: ${mappingError}`,
                }),
              ),
              TE.fromEither,
            ),
          ),
        ),
      ),
    );

  return {
    getTransfers,
  };
};
