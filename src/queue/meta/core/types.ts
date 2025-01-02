import * as TE from 'fp-ts/TaskEither';
import { QueueError } from '../../../types/errors.type';

export interface MetaService {
  readonly startWorker: () => TE.TaskEither<QueueError, void>;
  readonly stopWorker: () => TE.TaskEither<QueueError, void>;
}
