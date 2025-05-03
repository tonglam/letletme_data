import { DecoratedDependencies } from '@app/dependencies';
import { EventID, TeamID } from '@app/domain/shared/types/id.types';
import { unwrapOrThrow } from '@app/shared/utils/response.util';
import { Elysia, t } from 'elysia';

export const fixturesApi = (dependencies: DecoratedDependencies) =>
  new Elysia({ prefix: '/fixtures' })
    .get('/', () => unwrapOrThrow(dependencies.fixtureService.getFixtures()))
    .get(
      '/:eventId',
      ({ params }) =>
        unwrapOrThrow(
          dependencies.fixtureService.getFixturesByEventId(Number(params.eventId) as EventID),
        ),
      {
        params: t.Object({ eventId: t.Numeric() }),
      },
    )
    .get(
      '/:eventId/match-days',
      ({ params }) =>
        unwrapOrThrow(dependencies.fixtureService.getMatchDays(Number(params.eventId) as EventID)),
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
          dependencies.fixtureService.getFixturesByTeamId(Number(params.teamId) as TeamID),
        ),
      {
        params: t.Object({ teamId: t.Numeric() }),
      },
    )
    .post(
      '/:eventId/sync',
      ({ params }) =>
        unwrapOrThrow(
          dependencies.fixtureService.syncEventFixturesFromApi(Number(params.eventId) as EventID),
        ),
      {
        params: t.Object({
          eventId: t.Numeric(),
        }),
      },
    );
