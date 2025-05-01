import { Elysia, t } from 'elysia';
import { EventId } from 'types/domain/event.type';
import { unwrapOrThrow } from 'utils/response.util';

import { DecoratedDependencies } from '../dependencies';

export const eventsApi = (dependencies: DecoratedDependencies) =>
  new Elysia({ prefix: '/events' })
    .get('/', () => unwrapOrThrow(dependencies.eventService.getEvents()))
    .get(
      '/:id',
      ({ params }) =>
        unwrapOrThrow(dependencies.eventService.getEvent(Number(params.id) as EventId)),
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
