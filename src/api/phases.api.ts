import { Elysia, t } from 'elysia';
import { PhaseId } from 'types/domain/phase.type';
import { unwrapOrThrow } from 'utils/response.util';

import { DecoratedDependencies } from '@/dependencies';

export const phasesApi = (dependencies: DecoratedDependencies) =>
  new Elysia({ prefix: '/phases' })
    .get('/', () => unwrapOrThrow(dependencies.phaseService.getPhases()))
    .get(
      '/:id',
      ({ params }) =>
        unwrapOrThrow(dependencies.phaseService.getPhase(Number(params.id) as PhaseId)),
      {
        params: t.Object({
          id: t.Numeric(),
        }),
      },
    )
    .post('/sync', () => unwrapOrThrow(dependencies.phaseService.syncPhasesFromApi()));
