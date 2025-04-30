import { Elysia, t } from 'elysia';
import { ElementTypeId } from 'types/base.type';
import { PlayerId } from 'types/domain/player.type';
import { TeamId } from 'types/domain/team.type';
import { unwrapOrThrow } from 'utils/response.util';

import { DecoratedDependencies } from '@/dependencies';

export const playersApi = (dependencies: DecoratedDependencies) =>
  new Elysia({ prefix: '/players' })
    .get('/', () => unwrapOrThrow(dependencies.playerService.getPlayers()))
    .get(
      '/element-type/:elementTypeId',
      ({ params }) =>
        unwrapOrThrow(
          dependencies.playerService.getPlayersByElementType(
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
          dependencies.playerService.getPlayersByTeamId(Number(params.teamId) as TeamId),
        ),
      {
        params: t.Object({
          teamId: t.Numeric(),
        }),
      },
    )
    .get(
      '/:id',
      ({ params }) =>
        unwrapOrThrow(dependencies.playerService.getPlayer(Number(params.id) as PlayerId)),
      {
        params: t.Object({
          id: t.Numeric(),
        }),
      },
    )
    .post('/sync', () => unwrapOrThrow(dependencies.playerService.syncPlayersFromApi()));
