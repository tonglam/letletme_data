import { DecoratedDependencies } from '@app/dependencies';
import { EventID } from '@app/domain/shared/types/id.types';
import { unwrapOrThrow } from '@app/utils/response.util';
import { Elysia, t } from 'elysia';

export const eventsApi = (dependencies: DecoratedDependencies) =>
  new Elysia({ prefix: '/events' })
    .get('/', () => unwrapOrThrow(dependencies.eventService.getEvents()))
    .get(
      '/:id',
      ({ params }) =>
        unwrapOrThrow(dependencies.eventService.getEvent(Number(params.id) as EventID)),
      {
        params: t.Object({
          id: t.Numeric(),
        }),
      },
    )
    .get('/deadline-dates', () => unwrapOrThrow(dependencies.eventService.getDeadlineDates()))
    .get('/current', () => unwrapOrThrow(dependencies.eventService.getCurrentEvent()))
    .get('/last', () => unwrapOrThrow(dependencies.eventService.getLastEvent()))
    .get('/next', () => unwrapOrThrow(dependencies.eventService.getNextEvent()))
    .post('/sync', () => unwrapOrThrow(dependencies.eventService.syncEventsFromApi()));
