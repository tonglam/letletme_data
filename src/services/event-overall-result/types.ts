import * as TE from 'fp-ts/TaskEither';
import { WorkflowResult } from 'services/types';
import {
  EventOverallResult,
  EventOverallResults,
} from 'src/types/domain/event-overall-result.type';
import { EventId } from 'src/types/domain/event.type';
import { ServiceError } from 'src/types/error.type';

export interface EventOverallResultServiceOperations {
  readonly findEventOverallResultById: (
    id: EventId,
  ) => TE.TaskEither<ServiceError, EventOverallResult>;
  readonly findAllEventOverallResults: () => TE.TaskEither<ServiceError, EventOverallResults>;
  readonly syncEventOverallResultsFromApi: (eventId: EventId) => TE.TaskEither<ServiceError, void>;
}

export interface EventOverallResultService {
  readonly getEventOverallResult: (id: EventId) => TE.TaskEither<ServiceError, EventOverallResult>;
  readonly getAllEventOverallResults: () => TE.TaskEither<ServiceError, EventOverallResults>;
  readonly syncEventOverallResultsFromApi: (eventId: EventId) => TE.TaskEither<ServiceError, void>;
}

export interface EventOverallResultWorkflowOperations {
  readonly syncEventOverallResults: (
    eventId: EventId,
  ) => TE.TaskEither<ServiceError, WorkflowResult>;
}
