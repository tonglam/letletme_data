import * as TE from 'fp-ts/TaskEither';
import { WorkflowResult } from 'services/types';
import { EventLiveExplain } from 'types/domain/event-live-explain.type';
import { EventId } from 'types/domain/event.type';
import { PlayerId } from 'types/domain/player.type';
import { ServiceError } from 'types/error.type';

export interface EventLiveExplainServiceOperations {
  readonly findEventLiveExplainByElementId: (
    elementId: PlayerId,
    eventId: EventId,
  ) => TE.TaskEither<ServiceError, EventLiveExplain>;
  readonly syncEventLiveExplainsFromApi: (eventId: EventId) => TE.TaskEither<ServiceError, void>;
}

export interface EventLiveExplainService {
  readonly getEventLiveExplainByElementId: (
    elementId: PlayerId,
    eventId: EventId,
  ) => TE.TaskEither<ServiceError, EventLiveExplain>;
  readonly syncEventLiveExplainsFromApi: (eventId: EventId) => TE.TaskEither<ServiceError, void>;
}

export interface EventLiveExplainWorkflowsOperations {
  readonly syncEventLiveExplains: (eventId: EventId) => TE.TaskEither<ServiceError, WorkflowResult>;
}
