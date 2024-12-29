import { type RedisConnectionConfig } from '../../infrastructure/cache/types';

/**
 * Redis connection configuration
 * @const {RedisConnectionConfig}
 */
export const REDIS_CONFIG: RedisConnectionConfig = {
  host: process.env.REDIS_HOST ?? 'localhost',
  port: Number(process.env.REDIS_PORT ?? 6379),
  password: process.env.REDIS_PASSWORD,
  db: Number(process.env.REDIS_DB ?? 0),
};

/**
 * Redis client connection options
 * @const {Readonly<{url: string, database: number}>}
 */
export const REDIS_CLIENT_OPTIONS = {
  url: `redis://${REDIS_CONFIG.password ? `:${REDIS_CONFIG.password}@` : ''}${REDIS_CONFIG.host}:${
    REDIS_CONFIG.port
  }`,
  database: REDIS_CONFIG.db,
} as const;
