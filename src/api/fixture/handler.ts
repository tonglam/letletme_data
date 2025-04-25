import { Request } from 'express';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { FixtureService } from 'services/fixture/types';
import { FixtureHandlerResponse } from 'src/api/fixture/types';
import { EventFixtures } from 'src/types/domain/event-fixture.type';
import { EventId } from 'src/types/domain/event.type';
import { TeamFixtures } from 'src/types/domain/team-fixture.type';
import { TeamId } from 'src/types/domain/team.type';

import { APIError, APIErrorCode, createAPIError } from '../../types/error.type';
import { toAPIError } from '../../utils/error.util';

export const createFixtureHandlers = (fixtureService: FixtureService): FixtureHandlerResponse => {
  const getFixtures = (): TE.TaskEither<APIError, EventFixtures> => {
    return pipe(fixtureService.getFixtures(), TE.mapLeft(toAPIError));
  };

  const getFixturesByTeamId = (req: Request): TE.TaskEither<APIError, TeamFixtures> => {
    const teamId = Number(req.params.id);
    if (isNaN(teamId) || teamId <= 0) {
      return TE.left(
        createAPIError({ code: APIErrorCode.VALIDATION_ERROR, message: 'Invalid team ID' }),
      );
    }
    return pipe(fixtureService.getFixturesByTeamId(teamId as TeamId), TE.mapLeft(toAPIError));
  };

  const getFixturesByEventId = (req: Request): TE.TaskEither<APIError, EventFixtures> => {
    const eventId = Number(req.params.id);
    if (isNaN(eventId) || eventId <= 0) {
      return TE.left(
        createAPIError({ code: APIErrorCode.VALIDATION_ERROR, message: 'Invalid event ID' }),
      );
    }
    return pipe(fixtureService.getFixturesByEventId(eventId as EventId), TE.mapLeft(toAPIError));
  };

  return {
    getFixtures,
    getFixturesByTeamId,
    getFixturesByEventId,
  };
};
