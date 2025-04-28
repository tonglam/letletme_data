import { apiConfig } from 'configs/api/api.config';
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
import { HTTPClient } from 'infrastructures/http/types';
import { Logger } from 'pino';
import { ClassicLeague, LeagueId } from 'types/domain/league.type';
import { DataLayerError, DataLayerErrorCode } from 'types/error.type';
import { createDataLayerError } from 'utils/error.util';

export const createFplClassicLeagueDataService = (
  client: HTTPClient,
  logger: Logger,
): FplClassicLeagueDataService => {
  const fetchClassicLeaguePage = (
    leagueId: LeagueId,
    page: number,
  ): TE.TaskEither<DataLayerError, ClassicLeagueResponse> => {
    logger.info(
      { operation: `fetchClassicLeaguePage(${leagueId}, ${page})` },
      `Fetching FPL classic league data page ${page}`,
    );
    return pipe(
      client.get<ClassicLeagueResponse>(
        apiConfig.endpoints.leagues.classic({ leagueId: leagueId, page: page }),
      ),
      TE.mapLeft((apiError) => {
        logger.error(
          { operation: 'fetchClassicLeaguePage', leagueId, page, error: apiError, success: false },
          'FPL API call failed',
        );
        return createDataLayerError({
          code: DataLayerErrorCode.FETCH_ERROR,
          message: `Failed to fetch page ${page} for league ${leagueId} from FPL API`,
          cause: apiError instanceof Error ? apiError : undefined,
          details: { apiError, leagueId, page },
        });
      }),
      TE.chain((response) => {
        const parsed = ClassicLeagueResponseSchema.safeParse(response);
        if (!parsed.success) {
          logger.error(
            {
              operation: 'fetchClassicLeaguePage',
              leagueId,
              page,
              error: { message: 'Invalid response data', validationError: parsed.error.errors },
              response: response,
              success: false,
            },
            `FPL API response validation failed for page ${page}`,
          );
          return TE.left(
            createDataLayerError({
              code: DataLayerErrorCode.VALIDATION_ERROR,
              message: `Invalid classic league data received from FPL API on page ${page} for league ${leagueId}`,
              cause: undefined,
              details: {
                leagueId,
                page,
                errorMessage: parsed.error.message,
                validationError: parsed.error.format(),
              },
            }),
          );
        }
        logger.info(
          { operation: 'fetchClassicLeaguePage', leagueId, page, success: true },
          `FPL API call successful and validated for page ${page}`,
        );
        return TE.right(parsed.data);
      }),
    );
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
            logger.info(
              {
                operation: 'fetchAllClassicLeaguePages',
                leagueId,
                totalPages: currentPage,
                totalResults: combinedResults.length,
                success: true,
              },
              `Successfully fetched all pages for classic league ${leagueId}`,
            );
            return TE.right(finalResponse);
          }
        }),
        TE.mapLeft((error) => {
          logger.error(
            {
              operation: 'fetchAllClassicLeaguePages',
              leagueId,
              currentPage,
              error,
              success: false,
            },
            `Error encountered while fetching page ${currentPage} for league ${leagueId}`,
          );
          return error;
        }),
      );

    logger.info(
      { operation: `fetchAllClassicLeaguePages(${leagueId})` },
      `Fetching all pages for FPL classic league data ${leagueId}`,
    );
    return loop(1, []);
  };

  const getClassicLeague = (leagueId: LeagueId): TE.TaskEither<DataLayerError, ClassicLeague> =>
    pipe(
      fetchAllClassicLeaguePages(leagueId),
      TE.chain((classicLeagueData) =>
        pipe(
          mapClassicLeagueResponseToDomain(leagueId, classicLeagueData),
          E.mapLeft((mappingError) => {
            logger.error(
              { operation: 'getClassicLeague', leagueId, error: mappingError, success: false },
              'Failed to map classic league data to domain model',
            );
            return createDataLayerError({
              code: DataLayerErrorCode.MAPPING_ERROR,
              message: `Failed to map classic league ${leagueId}: ${mappingError}`,
              details: { leagueId, mappingError },
            });
          }),
          TE.fromEither,
        ),
      ),
    );

  return {
    getClassicLeague,
  };
};
