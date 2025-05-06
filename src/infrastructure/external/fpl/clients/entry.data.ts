import { EntryInfo } from '@app/domain/models/entry-info.model';
import { EntryLeagueInfos } from '@app/domain/models/entry-league-info.model';
import { EntryID } from '@app/domain/shared/types/id.types';
import { LeagueTypes } from '@app/domain/shared/types/type.types';
import { apiConfig } from '@app/infrastructure/config/api.config';
import { FplEntryDataService } from '@app/infrastructure/external/fpl/clients/types';
import { mapEntryInfoResponseToEntryInfo } from '@app/infrastructure/external/fpl/mappers/entry/info.mapper';
import { mapLeagueInfoResponseToEntryLeague } from '@app/infrastructure/external/fpl/mappers/entry/league.mapper';
import {
  EntryResponse,
  EntryResponseSchema,
} from '@app/infrastructure/external/fpl/schemas/entry/entry.schema';
import { DataLayerError, DataLayerErrorCode } from '@app/types/error.types';
import { createDataLayerError } from '@app/utils/error.util';
import { FplApiContext, logFplApiCall, logFplApiError } from '@app/utils/logger.util';
import * as A from 'fp-ts/Array';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';

export const createFplEntryDataService = (): FplEntryDataService => {
  let cachedEntryResponse: EntryResponse | null = null;

  const fetchAndValidateEntries = (
    entryId: EntryID,
  ): TE.TaskEither<DataLayerError, EntryResponse> => {
    const urlPath = apiConfig.endpoints.entry.info({ entryId });
    const context: FplApiContext = {
      service: 'FplEntryDataService',
      endpoint: urlPath,
      entryId,
    };
    logFplApiCall('Attempting to fetch FPL entry data', context);

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

        const parsed = EntryResponseSchema.safeParse(data);
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
        });
        cachedEntryResponse = parsed.data;
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
              message: 'Invalid response data for entry',
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
          message: 'An unexpected error occurred during FPL entry fetch or processing',
          cause: error instanceof Error ? error : undefined,
          details: { entryId, error },
        });
        logFplApiError(unexpectedError, { ...context, err: unexpectedError });
        return unexpectedError;
      },
    )();
  };

  const getFplEntryDataInternal = (
    entryId: EntryID,
  ): TE.TaskEither<DataLayerError, EntryResponse> => {
    if (cachedEntryResponse) {
      return TE.right(cachedEntryResponse);
    }
    return fetchAndValidateEntries(entryId);
  };

  const getInfo = (entryId: EntryID): TE.TaskEither<DataLayerError, EntryInfo> =>
    pipe(
      getFplEntryDataInternal(entryId),
      TE.chain((entryData) =>
        pipe(
          mapEntryInfoResponseToEntryInfo(entryData),
          E.mapLeft((mappingError) =>
            createDataLayerError({
              code: DataLayerErrorCode.MAPPING_ERROR,
              message: `Failed to map entry response: ${mappingError}`,
            }),
          ),
          TE.fromEither,
        ),
      ),
    );

  const getLeagues = (entryId: EntryID): TE.TaskEither<DataLayerError, EntryLeagueInfos> =>
    pipe(
      getFplEntryDataInternal(entryId),
      TE.chain((entryData) =>
        pipe(
          E.Do,
          E.bind('classicLeagues', () =>
            pipe(
              entryData.leagues.classic,
              A.map((leagueInfo) =>
                mapLeagueInfoResponseToEntryLeague(entryId, LeagueTypes[0], leagueInfo),
              ),
              E.sequenceArray,
            ),
          ),
          E.bind('h2hLeagues', () =>
            pipe(
              entryData.leagues.h2h,
              A.map((leagueInfo) =>
                mapLeagueInfoResponseToEntryLeague(entryId, LeagueTypes[1], leagueInfo),
              ),
              E.sequenceArray,
            ),
          ),
          E.map(({ classicLeagues, h2hLeagues }) => A.concat([...classicLeagues])([...h2hLeagues])),
          E.mapLeft((mappingError) =>
            createDataLayerError({
              code: DataLayerErrorCode.MAPPING_ERROR,
              message: `Failed to map entry league response: ${mappingError}`,
            }),
          ),
          TE.fromEither,
        ),
      ),
    );

  return {
    getInfo,
    getLeagues,
  };
};
