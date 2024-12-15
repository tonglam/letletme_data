import { Job } from 'bullmq';
import * as E from 'fp-ts/Either';
import { QueueName, QueuePriority } from '../infrastructure/queue/config';

export interface JobData {
  readonly id: string;
  readonly type: string;
  readonly payload: unknown;
  readonly timestamp: number;
}

export interface JobResult<T> {
  readonly success: boolean;
  readonly data?: T;
  readonly error?: Error;
  readonly duration: number;
}

export interface JobOptions {
  readonly priority?: QueuePriority;
  readonly attempts?: number;
  readonly backoff?: {
    readonly type: 'fixed' | 'exponential';
    readonly delay: number;
  };
  readonly timeout?: number;
}

export interface IJob<TData = unknown, TResult = unknown> {
  readonly execute: (data: TData, job?: Job) => Promise<E.Either<Error, TResult>>;
  readonly validate?: (data: TData) => E.Either<Error, TData>;
  readonly onComplete?: (result: TResult) => Promise<void>;
  readonly onFailed?: (error: Error) => Promise<void>;
}

export interface JobMetadata {
  readonly queue: QueueName;
  readonly priority: QueuePriority;
  readonly schedule?: string;
  readonly timeout: number;
}

export type JobHandler<TData = unknown, TResult = unknown> = (
  data: TData,
  job?: Job,
) => Promise<E.Either<Error, TResult>>;

export interface JobDefinition<TData = unknown, TResult = unknown> {
  readonly metadata: JobMetadata;
  readonly handler: JobHandler<TData, TResult>;
  readonly validate?: (data: TData) => E.Either<Error, TData>;
  readonly onComplete?: (result: TResult) => Promise<void>;
  readonly onFailed?: (error: Error) => Promise<void>;
}
