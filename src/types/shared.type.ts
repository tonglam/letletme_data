/**
 * Shared types used across multiple modules
 */

export enum QueueOperation {
  ADD_JOB = 'ADD_JOB',
  REMOVE_JOB = 'REMOVE_JOB',
  PROCESS_JOB = 'PROCESS_JOB',
  PAUSE_QUEUE = 'PAUSE_QUEUE',
  RESUME_QUEUE = 'RESUME_QUEUE',
  CLEAN_QUEUE = 'CLEAN_QUEUE',
  CREATE_WORKER = 'CREATE_WORKER',
  START_WORKER = 'START_WORKER',
  STOP_WORKER = 'STOP_WORKER',
  GET_WORKER = 'GET_WORKER',
  GET_QUEUE = 'GET_QUEUE',
  CREATE_SCHEDULE = 'CREATE_SCHEDULE',
  CLEANUP_JOBS = 'CLEANUP_JOBS',
  GET_JOB_STATUS = 'GET_JOB_STATUS',
  GET_QUEUE_METRICS = 'GET_QUEUE_METRICS',
}

export interface ErrorDetails {
  [key: string]: unknown;
}

export interface BaseError {
  readonly name: string;
  readonly message: string;
  readonly code: string;
  readonly timestamp: Date;
  readonly stack?: string;
  readonly cause?: Error;
  readonly details?: ErrorDetails;
}
