import { Elysia, t } from 'elysia';
import { PlayerId } from 'types/domain/player.type';
import { TeamId } from 'types/domain/team.type';
import { unwrapOrThrow } from 'utils/response.util';

import { DecoratedDependencies } from '../dependencies';

const isoDatePattern = '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'; // YYYY-MM-DD

export const playerValuesApi = (dependencies: DecoratedDependencies) =>
  new Elysia({ prefix: '/player-values' })
    .get(
      '/:elementId',
      ({ params }) =>
        unwrapOrThrow(
          dependencies.playerValueService.getPlayerValuesByElement(
            Number(params.elementId) as PlayerId,
          ),
        ),
      {
        params: t.Object({ elementId: t.Numeric() }),
      },
    )
    .get(
      '/change-date/:changeDate',
      ({ params }) =>
        unwrapOrThrow(
          dependencies.playerValueService.getPlayerValuesByChangeDate(params.changeDate),
        ),
      {
        params: t.Object({ changeDate: t.String({ pattern: isoDatePattern }) }),
      },
    )
    .get(
      '/team/:teamId',
      ({ params }) =>
        unwrapOrThrow(
          dependencies.playerValueService.getPlayerValuesByTeam(Number(params.teamId) as TeamId),
        ),
      {
        params: t.Object({ teamId: t.Numeric() }),
      },
    )
    .post('/sync', () => unwrapOrThrow(dependencies.playerValueService.syncPlayerValuesFromApi()))
    .get(
      '/track/:date',
      ({ params }) =>
        unwrapOrThrow(dependencies.playerValueTrackService.getPlayerValueTracksByDate(params.date)),
      {
        params: t.Object({ date: t.String({ pattern: isoDatePattern }) }),
      },
    )
    .post('/track/sync', () =>
      unwrapOrThrow(dependencies.playerValueTrackService.syncPlayerValueTracksFromApi()),
    );
