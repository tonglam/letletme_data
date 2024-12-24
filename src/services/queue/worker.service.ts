import * as TE from 'fp-ts/TaskEither';

/**
 * Worker service interface
 */
export interface WorkerService {
  readonly start: () => TE.TaskEither<Error, void>;
  readonly stop: () => TE.TaskEither<Error, void>;
}
