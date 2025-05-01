import { Elysia, t } from 'elysia';
import { TeamId } from 'types/domain/team.type';
import { unwrapOrThrow } from 'utils/response.util';

import { DecoratedDependencies } from '../dependencies';

export const teamsApi = (dependencies: DecoratedDependencies) =>
  new Elysia({ prefix: '/teams' })
    .get('/', () => unwrapOrThrow(dependencies.teamService.getTeams()))
    .get(
      '/:id',
      ({ params }) => unwrapOrThrow(dependencies.teamService.getTeam(Number(params.id) as TeamId)),
      {
        params: t.Object({
          id: t.Numeric(),
        }),
      },
    )
    .post('/sync', () => unwrapOrThrow(dependencies.teamService.syncTeamsFromApi()));
