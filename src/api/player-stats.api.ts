import { Elysia, t } from 'elysia';
import { ElementTypeId } from 'types/base.type';
import { PlayerId } from 'types/domain/player.type';
import { TeamId } from 'types/domain/team.type';
import { unwrapOrThrow } from 'utils/response.util';

import { DecoratedDependencies } from '../dependencies';

export const playerStatsApi = (dependencies: DecoratedDependencies) =>
  new Elysia({ prefix: '/player-stats' })
    .get('/', () => unwrapOrThrow(dependencies.playerStatService.getPlayerStats()))
    .get(
      '/:elementId',
      ({ params }) =>
        unwrapOrThrow(
          dependencies.playerStatService.getPlayerStat(Number(params.elementId) as PlayerId),
        ),
      {
        params: t.Object({
          elementId: t.Numeric(),
        }),
      },
    )
    .get(
      '/element-type/:elementTypeId',
      ({ params }) =>
        unwrapOrThrow(
          dependencies.playerStatService.getPlayerStatsByElementType(
            Number(params.elementTypeId) as ElementTypeId,
          ),
        ),
      {
        params: t.Object({
          elementTypeId: t.Numeric(),
        }),
      },
    )
    .get(
      '/team/:teamId',
      ({ params }) =>
        unwrapOrThrow(
          dependencies.playerStatService.getPlayerStatsByTeam(Number(params.teamId) as TeamId),
        ),
      {
        params: t.Object({ teamId: t.Numeric() }),
      },
    )
    .post('/sync', () => unwrapOrThrow(dependencies.playerStatService.syncPlayerStatsFromApi()));
