import { apiConfig } from 'configs/api/api.config';
import { mapEntryInfoResponseToEntryInfo } from 'data/fpl/mappers/entry/info.mapper';
import { mapLeagueInfoResponseToEntryLeague } from 'data/fpl/mappers/entry/league.mapper';
import { EntryResponse, EntryResponseSchema } from 'data/fpl/schemas/entry/entry.schema';
import { FplEntryDataService } from 'data/types';
import * as A from 'fp-ts/Array';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { HTTPClient } from 'infrastructures/http';
import { Logger } from 'pino';
import { LeagueType } from 'types/base.type';
import { EntryId } from 'types/domain/entry-info.type';
import { EntryInfos } from 'types/domain/entry-info.type';
import { EntryLeagueInfos } from 'types/domain/entry-league-info.type';
import { DataLayerError, DataLayerErrorCode } from 'types/error.type';
import { createDataLayerError } from 'utils/error.util';

export const createFplEntryDataService = (
  client: HTTPClient,
  logger: Logger,
): FplEntryDataService => {
  let cachedEntryResponse: EntryResponse | null = null;

  const fetchAndValidateEntries = (
    entryId: EntryId,
  ): TE.TaskEither<DataLayerError, EntryResponse> => {
    logger.info({ operation: `fetchAndValidateEntry(${entryId})` }, 'Fetching FPL entry data');

    return pipe(
      client.get<EntryResponse>(apiConfig.endpoints.entry.info({ entryId })),
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

  const getFplEntryDataInternal = (
    entryId: EntryId,
  ): TE.TaskEither<DataLayerError, EntryResponse> => {
    if (cachedEntryResponse) {
      return TE.right(cachedEntryResponse);
    }
    return fetchAndValidateEntries(entryId);
  };

  const getInfos = (entryId: EntryId): TE.TaskEither<DataLayerError, EntryInfos> =>
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
          TE.map((mappedInfo) => [mappedInfo]),
        ),
      ),
    );

  const getLeagues = (entryId: EntryId): TE.TaskEither<DataLayerError, EntryLeagueInfos> =>
    pipe(
      getFplEntryDataInternal(entryId),
      TE.chain((entryData) =>
        pipe(
          E.Do,
          E.bind('classicLeagues', () =>
            pipe(
              entryData.leagues.classic,
              A.map((leagueInfo) =>
                mapLeagueInfoResponseToEntryLeague(entryId, LeagueType.Classic, leagueInfo),
              ),
              E.sequenceArray,
            ),
          ),
          E.bind('h2hLeagues', () =>
            pipe(
              entryData.leagues.h2h,
              A.map((leagueInfo) =>
                mapLeagueInfoResponseToEntryLeague(entryId, LeagueType.H2h, leagueInfo),
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
    getInfos,
    getLeagues,
  };
};
