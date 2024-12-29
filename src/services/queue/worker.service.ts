// Worker service interface for managing queue workers
import * as TE from 'fp-ts/TaskEither';

export interface WorkerService {
  readonly start: () => TE.TaskEither<Error, void>;
  readonly stop: () => TE.TaskEither<Error, void>;
}
