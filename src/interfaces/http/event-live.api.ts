import { DecoratedDependencies } from '@app/dependencies';
import { EventID, PlayerID, TeamID } from '@app/domain/shared/types/id.types';
import { unwrapOrThrow } from '@app/shared/utils/response.util';
import { Elysia, t } from 'elysia';

export const eventLivesApi = (dependencies: DecoratedDependencies) =>
  new Elysia({ prefix: '/event-live/:eventId' })
    .get(
      '/',
      ({ params }) =>
        unwrapOrThrow(
          dependencies.eventLiveService.getEventLives(Number(params.eventId) as EventID),
        ),
      {
        params: t.Object({ eventId: t.Numeric() }),
      },
    )
    .get(
      '/:elementId',
      ({ params }) =>
        unwrapOrThrow(
          dependencies.eventLiveService.getEventLiveByElementId(
            Number(params.eventId) as EventID,
            Number(params.elementId) as PlayerID,
          ),
        ),
      {
        params: t.Object({ eventId: t.Numeric(), elementId: t.Numeric() }),
      },
    )
    .get(
      '/team/:teamId',
      ({ params }) =>
        unwrapOrThrow(
          dependencies.eventLiveService.getEventLivesByTeamId(
            Number(params.eventId) as EventID,
            Number(params.teamId) as TeamID,
          ),
        ),
      {
        params: t.Object({ eventId: t.Numeric(), teamId: t.Numeric() }),
      },
    )
    .get(
      '/explain/:elementId',
      ({ params }) =>
        unwrapOrThrow(
          dependencies.eventLiveExplainService.getEventLiveExplainByElementId(
            Number(params.eventId) as EventID,
            Number(params.elementId) as PlayerID,
          ),
        ),
      {
        params: t.Object({ eventId: t.Numeric(), elementId: t.Numeric() }),
      },
    )
    .get(
      '/overall-result',
      ({ params }) =>
        unwrapOrThrow(
          dependencies.eventOverallResultService.getEventOverallResult(
            Number(params.eventId) as EventID,
          ),
        ),
      {
        params: t.Object({ eventId: t.Numeric() }),
      },
    )
    .post(
      '/sync',
      ({ params }) =>
        unwrapOrThrow(
          dependencies.eventLiveService.syncEventLivesFromApi(Number(params.eventId) as EventID),
        ),
      {
        params: t.Object({ eventId: t.Numeric() }),
      },
    )
    .post(
      '/sync-cache',
      ({ params }) =>
        unwrapOrThrow(
          dependencies.eventLiveService.syncEventLiveCacheFromApi(
            Number(params.eventId) as EventID,
          ),
        ),
      {
        params: t.Object({ eventId: t.Numeric() }),
      },
    )
    .post(
      '/explain/sync',
      ({ params }) =>
        unwrapOrThrow(
          dependencies.eventLiveExplainService.syncEventLiveExplainsFromApi(
            Number(params.eventId) as EventID,
          ),
        ),
      {
        params: t.Object({ eventId: t.Numeric() }),
      },
    )
    .post(
      '/overall-result/sync',
      ({ params }) =>
        unwrapOrThrow(
          dependencies.eventOverallResultService.syncEventOverallResultsFromApi(
            Number(params.eventId) as EventID,
          ),
        ),
      {
        params: t.Object({ eventId: t.Numeric() }),
      },
    );
