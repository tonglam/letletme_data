import { Elysia, t } from 'elysia';
import { EntryId } from 'types/domain/entry-info.type';
import { unwrapOrThrow } from 'utils/response.util';

import { DecoratedDependencies } from '@/dependencies';

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
    .post('/sync', () => unwrapOrThrow(dependencies.entryInfoService.syncEntryInfosFromApi()))
    .post(
      '/leagues/sync',
      () => unwrapOrThrow(dependencies.entryLeagueInfoService.syncEntryLeagueInfosFromApi()),
      {
        params: t.Object({
          entryId: t.Numeric(),
        }),
      },
    );
