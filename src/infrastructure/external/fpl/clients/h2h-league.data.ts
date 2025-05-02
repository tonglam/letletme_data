import { H2hLeague, LeagueId } from '@app/domain/models/league.model';
import { apiConfig } from '@app/infrastructure/config/api.config';
import { FplH2hLeagueDataService } from '@app/infrastructure/external/fpl/clients/types';
import { mapH2hLeagueResponseToDomain } from '@app/infrastructure/external/fpl/mappers/league/h2h-league.mapper';
import {
  H2hLeagueResponse,
  H2hLeagueResponseSchema,
} from '@app/infrastructure/external/fpl/schemas/league/h2h-league.schema';
import { H2hResultResponses } from '@app/infrastructure/external/fpl/schemas/league/h2h-result.schema';
import { DataLayerError, DataLayerErrorCode } from '@app/shared/types/error.types';
import { createDataLayerError } from '@app/shared/utils/error.util';
import { FplApiContext, logFplApiCall, logFplApiError } from '@app/shared/utils/logger.util';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';

export const createFplH2hLeagueDataService = (): FplH2hLeagueDataService => {
  const fetchH2hLeaguePage = (
    leagueId: LeagueId,
    page: number,
  ): TE.TaskEither<DataLayerError, H2hLeagueResponse> => {
    const urlPath = apiConfig.endpoints.leagues.h2h({ leagueId, page });
    const context: FplApiContext = {
      service: 'FplH2hLeagueDataService',
      endpoint: urlPath,
      leagueId,
      page,
    };
    logFplApiCall(`Attempting to fetch FPL H2H league page ${page}`, context);

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

        const parsed = H2hLeagueResponseSchema.safeParse(data);
        if (!parsed.success) {
          throw {
            type: 'ValidationError',
            message: 'Invalid response data',
            validationError: parsed.error.format(),
            response: data,
          };
        }

        logFplApiCall(`FPL API call successful and validated for page ${page}`, { ...context });
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
                leagueId,
                page,
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
              message: `Invalid response data for H2H league page ${page}`,
              details: {
                leagueId,
                page,
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
          message: 'An unexpected error occurred during FPL H2H league fetch or processing',
          cause: error instanceof Error ? error : undefined,
          details: { leagueId, page, error },
        });
        logFplApiError(unexpectedError, { ...context, err: unexpectedError });
        return unexpectedError;
      },
    )();
  };

  const fetchH2hLeagueOnePage = (
    leagueId: LeagueId,
    page: number,
  ): TE.TaskEither<DataLayerError, H2hLeagueResponse> => pipe(fetchH2hLeaguePage(leagueId, page));

  const fetchAllH2hLeaguePages = (
    leagueId: LeagueId,
  ): TE.TaskEither<DataLayerError, H2hLeagueResponse> => {
    const loop = (
      currentPage: number,
      accumulatedResults: H2hResultResponses,
      baseResponse?: H2hLeagueResponse,
    ): TE.TaskEither<DataLayerError, H2hLeagueResponse> =>
      pipe(
        fetchH2hLeaguePage(leagueId, currentPage),
        TE.chain((pageResponse) => {
          const combinedResults = accumulatedResults.concat(pageResponse.standings.results);
          const currentBaseResponse = baseResponse ?? pageResponse;

          if (pageResponse.standings.has_next) {
            return loop(currentPage + 1, combinedResults, currentBaseResponse);
          } else {
            const finalResponse: H2hLeagueResponse = {
              ...currentBaseResponse,
              standings: {
                ...pageResponse.standings,
                has_next: false,
                results: combinedResults,
              },
            };

            const successContext: FplApiContext = {
              service: 'FplH2hLeagueDataService',
              endpoint: apiConfig.endpoints.leagues.h2h({ leagueId, page: 1 }),
              leagueId,
              totalPages: currentPage,
              totalResults: combinedResults.length,
            };

            logFplApiCall(
              `Successfully fetched all pages for H2H league ${leagueId}`,
              successContext,
            );

            return TE.right(finalResponse);
          }
        }),
        TE.mapLeft((error) => {
          return error;
        }),
      );

    return loop(1, []);
  };

  const getH2hLeagueInfo = (leagueId: LeagueId): TE.TaskEither<DataLayerError, H2hLeague> =>
    pipe(
      fetchH2hLeagueOnePage(leagueId, 1),
      TE.chain((h2hLeagueData) =>
        pipe(
          mapH2hLeagueResponseToDomain(leagueId, h2hLeagueData),
          E.mapLeft((mappingError: string) => {
            const error = createDataLayerError({
              code: DataLayerErrorCode.MAPPING_ERROR,
              message: `Failed to map H2H league ${leagueId}: ${mappingError}`,
              details: { leagueId, mappingError },
            });
            return error;
          }),
          TE.fromEither,
        ),
      ),
    );

  const getH2hLeague = (leagueId: LeagueId): TE.TaskEither<DataLayerError, H2hLeague> =>
    pipe(
      fetchAllH2hLeaguePages(leagueId),
      TE.chain((h2hLeagueData) =>
        pipe(
          mapH2hLeagueResponseToDomain(leagueId, h2hLeagueData),
          E.mapLeft((mappingError: string) => {
            const error = createDataLayerError({
              code: DataLayerErrorCode.MAPPING_ERROR,
              message: `Failed to map H2H league ${leagueId}: ${mappingError}`,
              details: { leagueId, mappingError },
            });
            return error;
          }),
          TE.fromEither,
        ),
      ),
    );

  return {
    getH2hLeagueInfo,
    getH2hLeague,
  };
};
