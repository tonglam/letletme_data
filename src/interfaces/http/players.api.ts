import { DecoratedDependencies } from '@app/dependencies';
import { PlayerID, TeamID } from '@app/domain/shared/types/id.types';
import { PlayerTypeID } from '@app/domain/shared/types/type.types';
import { unwrapOrThrow } from '@app/utils/response.util';
import { Elysia, t } from 'elysia';

export const playersApi = (dependencies: DecoratedDependencies) =>
  new Elysia({ prefix: '/players' })
    .get('/', () => unwrapOrThrow(dependencies.playerService.getPlayers()))
    .get(
      '/element-type/:elementTypeId',
      ({ params }) =>
        unwrapOrThrow(
          dependencies.playerService.getPlayersByElementType(
            Number(params.elementTypeId) as PlayerTypeID,
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
          dependencies.playerService.getPlayersByTeamId(Number(params.teamId) as TeamID),
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
        unwrapOrThrow(dependencies.playerService.getPlayer(Number(params.id) as PlayerID)),
      {
        params: t.Object({
          id: t.Numeric(),
        }),
      },
    )
    .post('/sync', () => unwrapOrThrow(dependencies.playerService.syncPlayersFromApi()));
