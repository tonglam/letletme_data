import { DecoratedDependencies } from '@app/dependencies';
import { PlayerID, TeamID } from '@app/domain/shared/types/id.types';
import { PlayerTypeID } from '@app/domain/shared/types/type.types';
import { unwrapOrThrow } from '@app/utils/response.util';
import { Elysia, t } from 'elysia';

export const playerStatsApi = (dependencies: DecoratedDependencies) =>
  new Elysia({ prefix: '/player-stats' })
    .get('/', () => unwrapOrThrow(dependencies.playerStatService.getPlayerStats()))
    .get(
      '/:elementId',
      ({ params }) =>
        unwrapOrThrow(
          dependencies.playerStatService.getPlayerStat(Number(params.elementId) as PlayerID),
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
          dependencies.playerStatService.getPlayerStatsByTeam(Number(params.teamId) as TeamID),
        ),
      {
        params: t.Object({ teamId: t.Numeric() }),
      },
    )
    .post('/sync', () => unwrapOrThrow(dependencies.playerStatService.syncPlayerStatsFromApi()));
