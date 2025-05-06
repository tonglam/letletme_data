import { DecoratedDependencies } from '@app/dependencies';
import { TeamID } from '@app/domain/shared/types/id.types';
import { unwrapOrThrow } from '@app/utils/response.util';
import { Elysia, t } from 'elysia';

export const teamsApi = (dependencies: DecoratedDependencies) =>
  new Elysia({ prefix: '/teams' })
    .get('/', () => unwrapOrThrow(dependencies.teamService.getTeams()))
    .get(
      '/:id',
      ({ params }) => unwrapOrThrow(dependencies.teamService.getTeam(Number(params.id) as TeamID)),
      {
        params: t.Object({
          id: t.Numeric(),
        }),
      },
    )
    .post('/sync', () => unwrapOrThrow(dependencies.teamService.syncTeamsFromApi()));
