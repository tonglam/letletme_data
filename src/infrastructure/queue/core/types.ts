import { JobsOptions, Queue, QueueEvents } from 'bullmq';

/**
 * Base job data that all jobs must extend
 */
export interface BaseJobData {
  readonly type: string;
  readonly timestamp: Date;
  readonly priority?: number;
}

/**
 * Common job operations
 */
export type JobOperation = 'UPDATE' | 'SYNC' | 'DELETE';

/**
 * Common job options
 */
export interface JobOptions {
  readonly forceUpdate?: boolean;
  readonly validateOnly?: boolean;
  readonly targetIds?: ReadonlyArray<number>;
}

/**
 * Queue options type
 */
export interface QueueOptions {
  readonly name: string;
  readonly prefix?: string;
  readonly connection?: {
    readonly host: string;
    readonly port: number;
    readonly maxRetriesPerRequest?: number;
    readonly retryStrategy?: (times: number) => number;
  };
  readonly defaultJobOptions?: JobsOptions;
}

/**
 * Queue dependencies
 */
export interface QueueDependencies {
  readonly queue: Queue;
  readonly events: QueueEvents;
}

/**
 * Meta job data type
 */
export interface MetaJobData extends BaseJobData {
  readonly type: 'BOOTSTRAP' | 'PHASES';
  readonly data: {
    readonly operation: JobOperation;
    readonly id?: number;
    readonly options?: JobOptions;
  };
}
