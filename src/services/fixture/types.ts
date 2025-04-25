import * as TE from 'fp-ts/TaskEither';
import { WorkflowResult } from 'services/types';
import { EventFixtures } from 'src/types/domain/event-fixture.type';
import { EventId } from 'src/types/domain/event.type';
import { TeamFixtures } from 'src/types/domain/team-fixture.type';
import { TeamId } from 'src/types/domain/team.type';
import { ServiceError } from 'src/types/error.type';

export interface FixtureServiceOperations {
  readonly mapTeamEventFixtures: (
    eventFixtures: EventFixtures,
  ) => TE.TaskEither<ServiceError, TeamFixtures>;
  readonly findFixturesByTeamId: (teamId: TeamId) => TE.TaskEither<ServiceError, TeamFixtures>;
  readonly findFixturesByEventId: (eventId: EventId) => TE.TaskEither<ServiceError, EventFixtures>;
  readonly findFixtures: () => TE.TaskEither<ServiceError, EventFixtures>;
  readonly syncEventFixturesFromApi: (eventId: EventId) => TE.TaskEither<ServiceError, void>;
}

export interface FixtureService {
  readonly getFixturesByTeamId: (teamId: TeamId) => TE.TaskEither<ServiceError, TeamFixtures>;
  readonly getFixturesByEventId: (eventId: EventId) => TE.TaskEither<ServiceError, EventFixtures>;
  readonly getFixtures: () => TE.TaskEither<ServiceError, EventFixtures>;
  readonly syncEventFixturesFromApi: (eventId: EventId) => TE.TaskEither<ServiceError, void>;
}

export interface FixtureWorkflowsOperations {
  readonly syncEventFixtures: (eventId: EventId) => TE.TaskEither<ServiceError, WorkflowResult>;
  readonly syncFixtures: () => TE.TaskEither<ServiceError, WorkflowResult>;
}
