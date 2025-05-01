import { Elysia, t } from 'elysia';
import { EventId } from 'types/domain/event.type';
import { TeamId } from 'types/domain/team.type';
import { unwrapOrThrow } from 'utils/response.util';

import { DecoratedDependencies } from '../dependencies';

export const fixturesApi = (dependencies: DecoratedDependencies) =>
  new Elysia({ prefix: '/fixtures' })
    .get('/', () => unwrapOrThrow(dependencies.fixtureService.getFixtures()))
    .get(
      '/:eventId',
      ({ params }) =>
        unwrapOrThrow(
          dependencies.fixtureService.getFixturesByEventId(Number(params.eventId) as EventId),
        ),
      {
        params: t.Object({ eventId: t.Numeric() }),
      },
    )
    .get(
      '/:eventId/match-days',
      ({ params }) =>
        unwrapOrThrow(dependencies.fixtureService.getMatchDays(Number(params.eventId) as EventId)),
      {
        params: t.Object({
          eventId: t.Numeric(),
        }),
      },
    )
    .get(
      '/team/:teamId',
      ({ params }) =>
        unwrapOrThrow(
          dependencies.fixtureService.getFixturesByTeamId(Number(params.teamId) as TeamId),
        ),
      {
        params: t.Object({ teamId: t.Numeric() }),
      },
    )
    .post(
      '/:eventId/sync',
      ({ params }) =>
        unwrapOrThrow(
          dependencies.fixtureService.syncEventFixturesFromApi(Number(params.eventId) as EventId),
        ),
      {
        params: t.Object({
          eventId: t.Numeric(),
        }),
      },
    );
