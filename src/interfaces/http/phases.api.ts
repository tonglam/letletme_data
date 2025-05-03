import { DecoratedDependencies } from '@app/dependencies';
import { PhaseID } from '@app/domain/shared/types/id.types';
import { unwrapOrThrow } from '@app/shared/utils/response.util';
import { Elysia, t } from 'elysia';

export const phasesApi = (dependencies: DecoratedDependencies) =>
  new Elysia({ prefix: '/phases' })
    .get('/', () => unwrapOrThrow(dependencies.phaseService.getPhases()))
    .get(
      '/:id',
      ({ params }) =>
        unwrapOrThrow(dependencies.phaseService.getPhase(Number(params.id) as PhaseID)),
      {
        params: t.Object({
          id: t.Numeric(),
        }),
      },
    )
    .post('/sync', () => unwrapOrThrow(dependencies.phaseService.syncPhasesFromApi()));
