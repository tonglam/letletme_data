import { Request } from 'express';
import { TaskEither } from 'fp-ts/lib/TaskEither';

import { EventFixtures } from '../../types/domain/event-fixture.type';
import { TeamFixtures } from '../../types/domain/team-fixture.type';
import { APIError } from '../../types/error.type';

export interface FixtureHandlerResponse {
  readonly getFixtures: () => TaskEither<APIError, EventFixtures>;
  readonly syncFixtures: (req: Request) => TaskEither<APIError, void>;
  readonly getFixturesByTeamId: (req: Request) => TaskEither<APIError, TeamFixtures>;
  readonly getFixturesByEventId: (req: Request) => TaskEither<APIError, EventFixtures>;
}
