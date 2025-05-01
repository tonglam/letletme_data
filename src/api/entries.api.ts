import { Elysia, t } from 'elysia';
import { EntryId } from 'types/domain/entry-info.type';
import { unwrapOrThrow } from 'utils/response.util';

import { DecoratedDependencies } from '../dependencies';

export const entriesApi = (dependencies: DecoratedDependencies) =>
  new Elysia({ prefix: '/entries/:entryId' })
    .get(
      '/',
      ({ params }) =>
        unwrapOrThrow(
          dependencies.entryInfoService.getEntryInfo(Number(params.entryId) as EntryId),
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
          dependencies.entryInfoService.syncEntryInfoFromApi(Number(params.entryId) as EntryId),
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
          dependencies.entryLeagueInfoService.getEntryLeagueInfo(Number(params.entryId) as EntryId),
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
            Number(params.entryId) as EntryId,
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
            Number(params.entryId) as EntryId,
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
            Number(params.entryId) as EntryId,
          ),
        ),
      {
        params: t.Object({
          entryId: t.Numeric(),
        }),
      },
    );
