import { Worker } from 'bullmq';
import * as TE from 'fp-ts/TaskEither';
import { QueueError } from './errors.type';
import { BaseJobData } from './job.types';
import { WorkerStateData } from './worker.types';

export enum QueueOperation {
  ADD_JOB = 'ADD_JOB',
  GET_JOB = 'GET_JOB',
  REMOVE_JOB = 'REMOVE_JOB',
  CLEAN_QUEUE = 'CLEAN_QUEUE',
  CLOSE_QUEUE = 'CLOSE_QUEUE',
  GET_WORKER = 'GET_WORKER',
  START_WORKER = 'START_WORKER',
  STOP_WORKER = 'STOP_WORKER',
  RESET_WORKER = 'RESET_WORKER',
  PROCESS_JOB = 'PROCESS_JOB',
}

export interface WorkerAdapter<T extends BaseJobData> {
  worker: Worker<T>;
  start: () => TE.TaskEither<QueueError, void>;
  stop: () => TE.TaskEither<QueueError, void>;
  isRunning: () => boolean;
  getState: () => WorkerStateData;
  reset: () => TE.TaskEither<QueueError, void>;
}
