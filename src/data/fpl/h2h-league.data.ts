import { apiConfig } from 'configs/api/api.config';
import { mapH2hLeagueResponseToDomain } from 'data/fpl/mappers/league/h2h-league.mapper';
import {
  H2hLeagueResponse,
  H2hLeagueResponseSchema,
} from 'data/fpl/schemas/league/h2h-league.schema';
import { H2hResultResponses } from 'data/fpl/schemas/league/h2h-result.schema';
import { FplH2hLeagueDataService } from 'data/types';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { HTTPClient } from 'infrastructures/http';
import { Logger } from 'pino';
import { H2hLeague, LeagueId } from 'types/domain/league.type';
import { DataLayerError, DataLayerErrorCode } from 'types/error.type';
import { createDataLayerError } from 'utils/error.util';

export const createFplH2hLeagueDataService = (
  client: HTTPClient,
  logger: Logger,
): FplH2hLeagueDataService => {
  const fetchH2hLeaguePage = (
    leagueId: LeagueId,
    page: number,
  ): TE.TaskEither<DataLayerError, H2hLeagueResponse> => {
    logger.info(
      { operation: `fetchH2hLeaguePage(${leagueId}, ${page})` },
      `Fetching FPL H2H league data page ${page}`,
    );
    return pipe(
      client.get<H2hLeagueResponse>(
        apiConfig.endpoints.leagues.h2h({ leagueId: leagueId, page: page }),
      ),
      TE.mapLeft((apiError) => {
        logger.error(
          { operation: 'fetchH2hLeaguePage', leagueId, page, error: apiError, success: false },
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
        const parsed = H2hLeagueResponseSchema.safeParse(response);
        if (!parsed.success) {
          logger.error(
            {
              operation: 'fetchH2hLeaguePage',
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
              message: `Invalid H2H league data received from FPL API on page ${page} for league ${leagueId}`,
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
          { operation: 'fetchH2hLeaguePage', leagueId, page, success: true },
          `FPL API call successful and validated for page ${page}`,
        );
        return TE.right(parsed.data);
      }),
    );
  };

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
            logger.info(
              {
                operation: 'fetchAllH2hLeaguePages',
                leagueId,
                totalPages: currentPage,
                totalResults: combinedResults.length,
                success: true,
              },
              `Successfully fetched all pages for H2H league ${leagueId}`,
            );
            return TE.right(finalResponse);
          }
        }),
        TE.mapLeft((error) => {
          logger.error(
            {
              operation: 'fetchAllH2hLeaguePages',
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
      { operation: `fetchAllH2hLeaguePages(${leagueId})` },
      `Fetching all pages for FPL H2H league data ${leagueId}`,
    );
    return loop(1, []);
  };

  const getH2hLeague = (leagueId: LeagueId): TE.TaskEither<DataLayerError, H2hLeague> =>
    pipe(
      fetchAllH2hLeaguePages(leagueId),
      TE.chain((h2hLeagueData) =>
        pipe(
          mapH2hLeagueResponseToDomain(leagueId, h2hLeagueData),
          E.mapLeft((mappingError) => {
            logger.error(
              { operation: 'getH2hLeague', leagueId, error: mappingError, success: false },
              'Failed to map H2H league data to domain model',
            );
            return createDataLayerError({
              code: DataLayerErrorCode.MAPPING_ERROR,
              message: `Failed to map H2H league ${leagueId}: ${mappingError}`,
              details: { leagueId, mappingError },
            });
          }),
          TE.fromEither,
        ),
      ),
    );

  return {
    getH2hLeague,
  };
};
