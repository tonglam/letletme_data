import { JobsOptions, Queue, QueueEvents } from 'bullmq';
import * as TE from 'fp-ts/TaskEither';
import { Logger } from 'pino';

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

/**
 * Monitor metrics for a queue
 */
export interface QueueMetrics {
  readonly activeJobs: number;
  readonly waitingJobs: number;
  readonly completedJobs: number;
  readonly failedJobs: number;
  readonly delayedJobs: number;
  readonly processingTime: number;
  readonly errorRate: number;
  readonly throughput: number;
}

/**
 * Job status type
 */
export type JobStatus = 'waiting' | 'active' | 'completed' | 'failed' | 'delayed';

/**
 * Monitor metrics for a job
 */
export interface JobMetricsData {
  readonly jobId: string;
  readonly type: string;
  readonly status: JobStatus;
  readonly duration: number;
  readonly attempts: number;
  readonly timestamp: Date;
  readonly progress: number;
}

/**
 * Mutable job metrics for internal use
 */
export interface MutableJobMetrics {
  status: JobStatus;
  duration: number;
  progress: number;
  readonly jobId: string;
  readonly type: string;
  readonly attempts: number;
  readonly timestamp: Date;
}

/**
 * Monitor configuration
 */
export interface MonitorConfig {
  readonly metricsInterval: number;
  readonly historySize: number;
}

/**
 * Monitor operations interface
 */
export interface MonitorOperations {
  readonly start: () => TE.TaskEither<Error, void>;
  readonly stop: () => TE.TaskEither<Error, void>;
  readonly getMetrics: () => TE.TaskEither<Error, QueueMetrics>;
  readonly getJobMetrics: (jobId: string) => TE.TaskEither<Error, JobMetricsData | null>;
}

/**
 * Monitor dependencies
 */
export interface MonitorDependencies {
  readonly queue: Queue;
  readonly events: QueueEvents;
  readonly logger: Logger;
  readonly config?: MonitorConfig;
}

/**
 * Queue event data types
 */
export interface QueueEventData {
  active: { jobId: string; type: string; timestamp: Date };
  completed: { jobId: string; returnvalue: string };
  failed: { jobId: string; failedReason: string };
  progress: { jobId: string; data: number };
}

/**
 * Queue event listener type
 */
export type QueueEventListener<K extends keyof QueueEventData> = (data: QueueEventData[K]) => void;

/**
 * Queue event emitter type
 */
export type QueueEventEmitter = {
  on<K extends keyof QueueEventData>(event: K, listener: QueueEventListener<K>): void;
  emit<K extends keyof QueueEventData>(event: K, data: QueueEventData[K]): boolean;
};
