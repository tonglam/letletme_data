import { DecoratedDependencies } from '@app/dependencies';
import { EntryID } from '@app/domain/types/id.types';
import { unwrapOrThrow } from '@app/shared/utils/response.util';
import { Elysia, t } from 'elysia';

export const entriesApi = (dependencies: DecoratedDependencies) =>
  new Elysia({ prefix: '/entries/:entryId' })
    .get(
      '/',
      ({ params }) =>
        unwrapOrThrow(
          dependencies.entryInfoService.getEntryInfo(Number(params.entryId) as EntryID),
        ),
      {
        params: t.Object({
          entryId: t.Numeric(),
        }),
      },
    )
    .post(
      '/sync',
      ({ params }) =>
        unwrapOrThrow(
          dependencies.entryInfoService.syncEntryInfoFromApi(Number(params.entryId) as EntryID),
        ),
      {
        params: t.Object({
          entryId: t.Numeric(),
        }),
      },
    )
    .get(
      '/leagues',
      ({ params }) =>
        unwrapOrThrow(
          dependencies.entryLeagueInfoService.getEntryLeagueInfo(Number(params.entryId) as EntryID),
        ),
      {
        params: t.Object({
          entryId: t.Numeric(),
        }),
      },
    )
    .post(
      '/leagues/sync',
      ({ params }) =>
        unwrapOrThrow(
          dependencies.entryLeagueInfoService.syncEntryLeagueInfosFromApi(
            Number(params.entryId) as EntryID,
          ),
        ),
      {
        params: t.Object({
          entryId: t.Numeric(),
        }),
      },
    )
    .get(
      '/history',
      ({ params }) =>
        unwrapOrThrow(
          dependencies.entryHistoryInfoService.getEntryHistoryInfo(
            Number(params.entryId) as EntryID,
          ),
        ),
      {
        params: t.Object({
          entryId: t.Numeric(),
        }),
      },
    )
    .post(
      '/history/sync',
      ({ params }) =>
        unwrapOrThrow(
          dependencies.entryHistoryInfoService.syncEntryHistoryInfosFromApi(
            Number(params.entryId) as EntryID,
          ),
        ),
      {
        params: t.Object({
          entryId: t.Numeric(),
        }),
      },
    );
