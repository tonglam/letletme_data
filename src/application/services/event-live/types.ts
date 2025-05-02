import * as TE from 'fp-ts/TaskEither';
import { WorkflowResult } from 'service/types';
import { EventLive, EventLives } from 'types/domain/event-live.type';
import { EventId } from 'types/domain/event.type';
import { PlayerId } from 'types/domain/player.type';
import { TeamId } from 'types/domain/team.type';
import { ServiceError } from 'types/error.type';

export interface EventLiveServiceOperations {
  readonly findEventLives: (eventId: EventId) => TE.TaskEither<ServiceError, EventLives>;
  readonly findEventLiveByElementId: (
    eventId: EventId,
    elementId: PlayerId,
  ) => TE.TaskEither<ServiceError, EventLive>;
  readonly findEventLivesByTeamId: (
    eventId: EventId,
    teamId: TeamId,
  ) => TE.TaskEither<ServiceError, EventLives>;
  readonly syncEventLiveCacheFromApi: (eventId: EventId) => TE.TaskEither<ServiceError, void>;
  readonly syncEventLivesFromApi: (eventId: EventId) => TE.TaskEither<ServiceError, void>;
}

export interface EventLiveService {
  readonly getEventLives: (eventId: EventId) => TE.TaskEither<ServiceError, EventLives>;
  readonly getEventLiveByElementId: (
    eventId: EventId,
    elementId: PlayerId,
  ) => TE.TaskEither<ServiceError, EventLive>;
  readonly getEventLivesByTeamId: (
    eventId: EventId,
    teamId: TeamId,
  ) => TE.TaskEither<ServiceError, EventLives>;
  readonly syncEventLiveCacheFromApi: (eventId: EventId) => TE.TaskEither<ServiceError, void>;
  readonly syncEventLivesFromApi: (eventId: EventId) => TE.TaskEither<ServiceError, void>;
}

export interface EventLiveWorkflowsOperations {
  readonly syncEventLiveCache: (eventId: EventId) => TE.TaskEither<ServiceError, WorkflowResult>;
  readonly syncEventLives: (eventId: EventId) => TE.TaskEither<ServiceError, WorkflowResult>;
}
