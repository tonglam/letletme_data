import * as TE from 'fp-ts/TaskEither';
import { WorkflowResult } from 'service/types';
import { EventFixtures } from 'types/domain/event-fixture.type';
import { EventId } from 'types/domain/event.type';
import { TeamFixtures } from 'types/domain/team-fixture.type';
import { TeamId } from 'types/domain/team.type';
import { ServiceError } from 'types/error.type';

export interface FixtureServiceOperations {
  readonly mapTeamEventFixtures: (
    eventFixtures: EventFixtures,
  ) => TE.TaskEither<ServiceError, TeamFixtures>;
  readonly findFixturesByTeamId: (teamId: TeamId) => TE.TaskEither<ServiceError, TeamFixtures>;
  readonly findFixturesByEventId: (eventId: EventId) => TE.TaskEither<ServiceError, EventFixtures>;
  readonly findFixtures: () => TE.TaskEither<ServiceError, EventFixtures>;
  readonly isMatchDay: (eventId: EventId) => TE.TaskEither<ServiceError, boolean>;
  readonly isAfterMatchDay: (eventId: EventId) => TE.TaskEither<ServiceError, boolean>;
  readonly isMatchTime: (eventId: EventId) => TE.TaskEither<ServiceError, boolean>;
  readonly isSelectTime: (eventId: EventId) => TE.TaskEither<ServiceError, boolean>;
  readonly findAllMatchDays: (eventId: EventId) => TE.TaskEither<ServiceError, ReadonlyArray<Date>>;
  readonly findAllAfterMatchDays: (
    eventId: EventId,
  ) => TE.TaskEither<ServiceError, ReadonlyArray<Date>>;
  readonly syncEventFixturesFromApi: (eventId: EventId) => TE.TaskEither<ServiceError, void>;
  readonly syncFixturesFromApi: () => TE.TaskEither<ServiceError, void>;
}

export interface FixtureService {
  readonly getFixturesByTeamId: (teamId: TeamId) => TE.TaskEither<ServiceError, TeamFixtures>;
  readonly getFixturesByEventId: (eventId: EventId) => TE.TaskEither<ServiceError, EventFixtures>;
  readonly getFixtures: () => TE.TaskEither<ServiceError, EventFixtures>;
  readonly isMatchDay: (eventId: EventId) => TE.TaskEither<ServiceError, boolean>;
  readonly isAfterMatchDay: (eventId: EventId) => TE.TaskEither<ServiceError, boolean>;
  readonly isMatchTime: (eventId: EventId) => TE.TaskEither<ServiceError, boolean>;
  readonly isSelectTime: (eventId: EventId) => TE.TaskEither<ServiceError, boolean>;
  readonly getMatchDays: (eventId: EventId) => TE.TaskEither<ServiceError, ReadonlyArray<Date>>;
  readonly getAfterMatchDays: (
    eventId: EventId,
  ) => TE.TaskEither<ServiceError, ReadonlyArray<Date>>;
  readonly syncEventFixturesFromApi: (eventId: EventId) => TE.TaskEither<ServiceError, void>;
  readonly syncFixturesFromApi: () => TE.TaskEither<ServiceError, void>;
}

export interface FixtureWorkflowsOperations {
  readonly syncFixtures: () => TE.TaskEither<ServiceError, WorkflowResult>;
}
