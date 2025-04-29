import { mapClassicLeagueResponseToDomain } from 'data/fpl/mappers/league/classic-league.mapper';
import {
  ClassicLeagueResponse,
  ClassicLeagueResponseSchema,
} from 'data/fpl/schemas/league/classic-league.schema';
import { ClassicResultResponses } from 'data/fpl/schemas/league/classic-result.schema';
import { FplClassicLeagueDataService } from 'data/types';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { apiConfig } from 'src/config/api/api.config';
import { ClassicLeague, LeagueId } from 'types/domain/league.type';
import { DataLayerError, DataLayerErrorCode } from 'types/error.type';
import { createDataLayerError } from 'utils/error.util';
import { FplApiContext, logFplApiCall, logFplApiError } from 'utils/logger.util';

export const createFplClassicLeagueDataService = (): FplClassicLeagueDataService => {
  const fetchClassicLeaguePage = (
    leagueId: LeagueId,
    page: number,
  ): TE.TaskEither<DataLayerError, ClassicLeagueResponse> => {
    const urlPath = apiConfig.endpoints.leagues.classic({ leagueId, page });
    const context: FplApiContext = {
      service: 'FplClassicLeagueDataService',
      endpoint: urlPath,
      leagueId,
      page,
    };
    logFplApiCall(`Attempting to fetch FPL classic league page ${page}`, context);

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

        const parsed = ClassicLeagueResponseSchema.safeParse(data);
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
              message: `Invalid response data for classic league page ${page}`,
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
          message: 'An unexpected error occurred during FPL classic league fetch or processing',
          cause: error instanceof Error ? error : undefined,
          details: { leagueId, page, error },
        });
        logFplApiError(unexpectedError, { ...context, err: unexpectedError });
        return unexpectedError;
      },
    )();
  };

  const fetchAllClassicLeaguePages = (
    leagueId: LeagueId,
  ): TE.TaskEither<DataLayerError, ClassicLeagueResponse> => {
    const loop = (
      currentPage: number,
      accumulatedResults: ClassicResultResponses,
      baseResponse?: ClassicLeagueResponse,
    ): TE.TaskEither<DataLayerError, ClassicLeagueResponse> =>
      pipe(
        fetchClassicLeaguePage(leagueId, currentPage),
        TE.chain((pageResponse) => {
          const combinedResults = accumulatedResults.concat(pageResponse.standings.results);
          const currentBaseResponse = baseResponse ?? pageResponse;

          if (pageResponse.standings.has_next) {
            return loop(currentPage + 1, combinedResults, currentBaseResponse);
          } else {
            const finalResponse: ClassicLeagueResponse = {
              ...currentBaseResponse,
              standings: {
                ...pageResponse.standings,
                has_next: false,
                results: combinedResults,
              },
            };

            const successContext: FplApiContext = {
              service: 'FplClassicLeagueDataService',
              endpoint: apiConfig.endpoints.leagues.classic({ leagueId, page: 1 }),
              leagueId,
              totalPages: currentPage,
              totalResults: combinedResults.length,
            };

            logFplApiCall(
              `Successfully fetched all pages for classic league ${leagueId}`,
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

  const getClassicLeague = (leagueId: LeagueId): TE.TaskEither<DataLayerError, ClassicLeague> =>
    pipe(
      fetchAllClassicLeaguePages(leagueId),
      TE.chain((classicLeagueData) =>
        pipe(
          mapClassicLeagueResponseToDomain(leagueId, classicLeagueData),
          E.mapLeft((mappingError: string) => {
            const error = createDataLayerError({
              code: DataLayerErrorCode.MAPPING_ERROR,
              message: `Failed to map classic league ${leagueId}: ${mappingError}`,
              details: { leagueId, mappingError },
            });
            return error;
          }),
          TE.fromEither,
        ),
      ),
    );

  return {
    getClassicLeague,
  };
};
