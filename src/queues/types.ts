import { Job, Queue, Worker } from 'bullmq';
import { RedisOptions } from 'ioredis';
import {
  DailyJobType,
  JobOperationType,
  LiveJobType,
  MetaJobType,
  PostMatchJobType,
} from '../types/errors.type';

// Base job data interface
export interface BaseJobData {
  readonly type: string;
  readonly timestamp: Date;
  readonly data: Record<string, unknown>;
}

// Queue configuration interface
export interface QueueConfig {
  readonly name: string;
  readonly prefix: string;
  readonly connection: RedisOptions;
}

// Queue adapter interface
export interface QueueAdapter {
  readonly queue: Queue;
  addJob: <T extends BaseJobData>(data: T) => Promise<Job>;
  removeJob: (jobId: string) => Promise<void>;
  pauseQueue: () => Promise<void>;
  resumeQueue: () => Promise<void>;
  cleanQueue: () => Promise<void>;
}

// Worker adapter interface
export interface WorkerAdapter<T extends BaseJobData = BaseJobData> {
  readonly worker: Worker<T, void, string>;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  isRunning: () => boolean;
}

// Job processor type
export type JobProcessor<T extends BaseJobData> = (job: Job<T>) => Promise<void>;

// Job options type
export interface JobOptions {
  readonly priority?: number;
  readonly attempts?: number;
  readonly backoff?: {
    readonly type: 'exponential' | 'fixed';
    readonly delay: number;
  };
  readonly timeout?: number;
  readonly removeOnComplete?: boolean | number;
  readonly removeOnFail?: boolean | number;
}

// ============ Job Data Types ============

/**
 * Meta job data interface
 */
export interface MetaJobData extends BaseJobData {
  readonly type: MetaJobType;
  readonly data: {
    readonly operation: JobOperationType;
    readonly id?: number;
  };
}

/**
 * Live job data interface
 */
export interface LiveJobData extends BaseJobData {
  readonly type: LiveJobType;
  readonly data: {
    readonly matchId?: number;
    readonly gameweek?: number;
  };
}

/**
 * Post-match job data interface
 */
export interface PostMatchJobData extends BaseJobData {
  readonly type: PostMatchJobType;
  readonly data: {
    readonly matchId: number;
    readonly gameweek: number;
  };
}

/**
 * Daily job data interface
 */
export interface DailyJobData extends BaseJobData {
  readonly type: DailyJobType;
  readonly data: {
    readonly date: string;
    readonly options?: Record<string, unknown>;
  };
}
