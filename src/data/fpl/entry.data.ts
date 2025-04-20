import * as A from 'fp-ts/Array';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { Logger } from 'pino';
import { apiConfig } from 'src/configs/api/api.config';
import { mapEntryInfoResponseToEntryInfo } from 'src/data/fpl/mappers/entry/info.mapper';
import { mapLeagueInfoResponseToEntryLeague } from 'src/data/fpl/mappers/entry/league.mapper';
import { EntryResponse, EntryResponseSchema } from 'src/data/fpl/schemas/entry/entry.schema';
import { FplEntryDataService } from 'src/data/types';
import { HTTPClient } from 'src/infrastructures/http';
import { LeagueType } from 'src/types/base.type';
import { EntryInfos } from 'src/types/domain/entry-info.type';
import { EntryLeagueInfos } from 'src/types/domain/entry-league-info.type';
import { DataLayerError, DataLayerErrorCode } from 'src/types/error.type';
import { createDataLayerError } from 'src/utils/error.util';

export const createFplEntryDataService = (
  client: HTTPClient,
  logger: Logger,
): FplEntryDataService => {
  let cachedEntryResponse: EntryResponse | null = null;

  const fetchAndValidateEntries = (entry: number): TE.TaskEither<DataLayerError, EntryResponse> => {
    logger.info({ operation: `fetchAndValidateEntry(${entry})` }, 'Fetching FPL entry data');

    return pipe(
      client.get<unknown>(apiConfig.endpoints.entry.info({ entry: entry })),
      TE.mapLeft((apiError) => {
        logger.error(
          {
            operation: 'fetchAndValidateEntry',
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
        const parsed = EntryResponseSchema.safeParse(response);
        if (!parsed.success) {
          logger.error(
            {
              operation: 'fetchAndValidateEntry',
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
            operation: 'fetchAndValidateEntry',
            success: true,
          },
          'FPL API call successful and validated',
        );
        cachedEntryResponse = parsed.data;
        return TE.right(parsed.data);
      }),
    );
  };

  const getFplEntryDataInternal = (entry: number): TE.TaskEither<DataLayerError, EntryResponse> => {
    if (cachedEntryResponse) {
      return TE.right(cachedEntryResponse);
    }
    return fetchAndValidateEntries(entry);
  };

  const getEntryInfos = (entry: number): TE.TaskEither<DataLayerError, EntryInfos> =>
    pipe(
      getFplEntryDataInternal(entry),
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
          TE.map((mappedInfo) => [mappedInfo]),
        ),
      ),
    );

  const getEntryLeagues = (entry: number): TE.TaskEither<DataLayerError, EntryLeagueInfos> =>
    pipe(
      getFplEntryDataInternal(entry),
      TE.chain((entryData) =>
        pipe(
          E.Do,
          E.bind('classicLeagues', () =>
            pipe(
              entryData.leagues.classic,
              A.map((leagueInfo) =>
                mapLeagueInfoResponseToEntryLeague(entry, LeagueType.Classic, leagueInfo),
              ),
              E.sequenceArray,
            ),
          ),
          E.bind('h2hLeagues', () =>
            pipe(
              entryData.leagues.h2h,
              A.map((leagueInfo) =>
                mapLeagueInfoResponseToEntryLeague(entry, LeagueType.H2H, leagueInfo),
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
    getEntryInfos,
    getEntryLeagues,
  };
};
