import { Redis } from 'ioredis';

/**
 * Queue connection configuration type
 */
export type QueueConnection =
  | Redis
  | {
      host: string;
      port: number;
      password?: string;
      retryStrategy?: (times: number) => number;
    };

/**
 * Queue configuration type
 */
export interface QueueConfig {
  readonly connection: QueueConnection;
}

/**
 * Base job data interface
 */
export interface BaseJobData {
  readonly type: string;
  readonly timestamp: Date;
  readonly data: unknown;
}
