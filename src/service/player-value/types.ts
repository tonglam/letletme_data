import * as TE from 'fp-ts/TaskEither';
import { ElementType } from '../../types/base.type';
import { ElementResponse } from '../../types/element.type';
import { ServiceError } from '../../types/error.type';
import { PlayerValue, PlayerValues } from '../../types/player-value.type';

export interface WorkflowContext {
  readonly workflowId: string;
  readonly startTime: Date;
}

export interface WorkflowResult<T> {
  readonly context: WorkflowContext;
  readonly result: T;
  readonly duration: number;
}

export interface PriceChange {
  readonly elementId: number;
  readonly oldPrice: number;
  readonly newPrice: number;
  readonly elementType: ElementType;
  readonly eventId: number;
}

export interface PlayerValueService {
  readonly getPlayerValues: () => TE.TaskEither<ServiceError, PlayerValues>;
  readonly getPlayerValue: (id: string) => TE.TaskEither<ServiceError, PlayerValue | null>;
  readonly savePlayerValues: (values: PlayerValues) => TE.TaskEither<ServiceError, PlayerValues>;
  readonly syncPlayerValuesFromApi: () => TE.TaskEither<ServiceError, PlayerValues>;
}

export interface PlayerValueServiceDependencies {
  readonly bootstrapApi: {
    readonly getBootstrapElements: () => TE.TaskEither<ServiceError, readonly ElementResponse[]>;
  };
}

export interface PlayerValueServiceOperations {
  readonly findAllPlayerValues: () => TE.TaskEither<ServiceError, PlayerValues>;
  readonly findPlayerValueById: (id: string) => TE.TaskEither<ServiceError, PlayerValue | null>;
  readonly syncPlayerValuesFromApi: (
    bootstrapApi: PlayerValueServiceDependencies['bootstrapApi'],
  ) => TE.TaskEither<ServiceError, PlayerValues>;
}

export type PlayerValueServiceWithWorkflows = PlayerValueService & {
  readonly workflows: {
    readonly syncPlayerValues: () => TE.TaskEither<ServiceError, WorkflowResult<PlayerValues>>;
  };
};
