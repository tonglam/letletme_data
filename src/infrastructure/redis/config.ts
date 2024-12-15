import { ConnectionOptions, QueueOptions } from 'bullmq';
import { Redis, RedisOptions } from 'ioredis';

export const redisOptions: RedisOptions = {
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD,
  db: parseInt(process.env.REDIS_DB || '0', 10),
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  retryStrategy: (times: number) => Math.min(times * 50, 2000),
};

export const createBullMQConfig = (client: Redis): QueueOptions => ({
  connection: client as unknown as ConnectionOptions,
});
