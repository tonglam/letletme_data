import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { Logger } from 'pino';
import { apiConfig } from 'src/configs/api/api.config';
import { mapTransferResponseToEntryEventTransfer } from 'src/data/fpl/mappers/transfer/transfer.mapper';
import {
  TransferResponseSchema,
  TransfersResponse,
} from 'src/data/fpl/schemas/transfer/transfer.schema';
import { FplTransferDataService } from 'src/data/types';
import { HTTPClient } from 'src/infrastructures/http';
import { RawEntryEventTransfers } from 'src/types/domain/entry-event-transfer.type';
import { EntryId } from 'src/types/domain/entry-info.type';
import { EventId } from 'src/types/domain/event.type';
import { DataLayerError, DataLayerErrorCode } from 'src/types/error.type';
import { createDataLayerError } from 'src/utils/error.util';
import { z } from 'zod';

export const createFplTransferDataService = (
  client: HTTPClient,
  logger: Logger,
): FplTransferDataService => {
  let cachedTransferResponse: TransfersResponse | null = null;

  const fetchAndValidateTransfers = (
    entryId: EntryId,
    eventId: EventId,
  ): TE.TaskEither<DataLayerError, TransfersResponse> => {
    logger.info(
      { operation: `fetchAndValidateTransfers(${entryId}, ${eventId})` },
      'Fetching FPL transfers',
    );

    return pipe(
      client.get<TransfersResponse>(
        apiConfig.endpoints.entry.transfers({ entryId: entryId, eventId: eventId }),
      ),
      TE.mapLeft((apiError) => {
        logger.error(
          {
            operation: 'fetchAndValidateTransfers',
            error: apiError,
            success: false,
          },
          'FPL API call failed',
        );
        return createDataLayerError({
          code: DataLayerErrorCode.FETCH_ERROR,
          message: 'Failed to fetch FPL transfers',
          cause: apiError instanceof Error ? apiError : undefined,
          details: { apiError },
        });
      }),
      TE.chain((response) => {
        const parsed = z.array(TransferResponseSchema).safeParse(response);
        if (!parsed.success) {
          logger.error(
            {
              operation: 'fetchAndValidateTransfers',
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
              message: 'Failed to validate FPL transfers',
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
            operation: 'fetchAndValidateTransfers',
            success: true,
          },
          'FPL transfers fetched and validated',
        );
        cachedTransferResponse = parsed.data;
        return TE.right(parsed.data);
      }),
    );
  };

  const getTransfersInternal = (
    entryId: EntryId,
    eventId: EventId,
  ): TE.TaskEither<DataLayerError, TransfersResponse> => {
    if (cachedTransferResponse) {
      return TE.right(cachedTransferResponse);
    }
    return fetchAndValidateTransfers(entryId, eventId);
  };

  const getTransfers = (
    entryId: EntryId,
    eventId: EventId,
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
