import * as E from 'fp-ts/Either';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { Logger } from 'pino';
import { apiConfig } from 'src/configs/api/api.config';
import { mapPickResponseToEntryEventPick } from 'src/data/fpl/mappers/pick/pick.mapper';
import { PickResponse, PickResponseSchema } from 'src/data/fpl/schemas/pick/pick.schema';
import { FplPickDataService } from 'src/data/types';
import { HTTPClient } from 'src/infrastructures/http/client';
import { EntryEventPicks } from 'src/types/domain/entry-event-pick.type';
import { DataLayerError, DataLayerErrorCode } from 'src/types/error.type';
import { createDataLayerError } from 'src/utils/error.util';
export const createFplPickDataService = (
  client: HTTPClient,
  logger: Logger,
): FplPickDataService => {
  let cachedPickResponse: PickResponse | null = null;

  const fetchAndValidatePicks = (
    entry: number,
    event: number,
  ): TE.TaskEither<DataLayerError, PickResponse> => {
    logger.info({ operation: `fetchAndValidatePicks(${entry}, ${event})` }, 'Fetching FPL picks');

    return pipe(
      client.get<unknown>(apiConfig.endpoints.entry.picks({ entry: entry, event: event })),
      TE.mapLeft((apiError) => {
        logger.error(
          {
            operation: 'fetchAndValidatePicks',
            error: apiError,
            success: false,
          },
          'FPL API call failed',
        );
        return createDataLayerError({
          code: DataLayerErrorCode.FETCH_ERROR,
          message: 'Failed to fetch FPL picks',
          cause: apiError instanceof Error ? apiError : undefined,
          details: { apiError },
        });
      }),
      TE.chain((response) => {
        const parsed = PickResponseSchema.safeParse(response);
        if (!parsed.success) {
          logger.error(
            {
              operation: 'fetchAndValidatePicks',
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
              message: 'Failed to validate FPL picks',
              cause: parsed.error,
              details: { validationError: parsed.error.format() },
            }),
          );
        }
        logger.info(
          {
            operation: 'fetchAndValidatePicks',
            success: true,
          },
          'FPL picks fetched and validated',
        );
        cachedPickResponse = parsed.data;
        return TE.right(parsed.data);
      }),
    );
  };

  const getFplPickDataInternal = (
    entry: number,
    event: number,
  ): TE.TaskEither<DataLayerError, PickResponse> => {
    if (cachedPickResponse) {
      return TE.right(cachedPickResponse);
    }
    return fetchAndValidatePicks(entry, event);
  };

  const getPicks = (entry: number, event: number): TE.TaskEither<DataLayerError, EntryEventPicks> =>
    pipe(
      getFplPickDataInternal(entry, event),
      TE.chain((pickResponse) =>
        pipe(
          mapPickResponseToEntryEventPick(entry, event, pickResponse),
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
