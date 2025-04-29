import * as TE from 'fp-ts/TaskEither';
import { WorkflowResult } from 'service/types';
import { EventOverallResult } from 'types/domain/event-overall-result.type';
import { EventId } from 'types/domain/event.type';
import { ServiceError } from 'types/error.type';

export interface EventOverallResultServiceOperations {
  readonly findEventOverallResultById: (
    eventId: EventId,
  ) => TE.TaskEither<ServiceError, EventOverallResult>;
  readonly syncEventOverallResultsFromApi: (eventId: EventId) => TE.TaskEither<ServiceError, void>;
}

export interface EventOverallResultService {
  readonly getEventOverallResult: (id: EventId) => TE.TaskEither<ServiceError, EventOverallResult>;
  readonly syncEventOverallResultsFromApi: (eventId: EventId) => TE.TaskEither<ServiceError, void>;
}

export interface EventOverallResultWorkflowOperations {
  readonly syncEventOverallResults: (
    eventId: EventId,
  ) => TE.TaskEither<ServiceError, WorkflowResult>;
}
