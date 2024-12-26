import * as E from 'fp-ts/Either';
import type { RedisClientType, RedisDefaultModules } from 'redis';
import type { Cache } from './types';

export const createRedisCache = (client: RedisClientType<RedisDefaultModules>): Cache => ({
  get:
    <T>(key: string) =>
    async () => {
      try {
        const value = await client.get(key);
        return value ? E.right(JSON.parse(value) as T) : E.left(new Error(`Key ${key} not found`));
      } catch (error) {
        return E.left(error instanceof Error ? error : new Error('Unknown error'));
      }
    },

  set:
    <T>(key: string, value: T) =>
    async () => {
      try {
        await client.set(key, JSON.stringify(value));
        return E.right(undefined);
      } catch (error) {
        return E.left(error instanceof Error ? error : new Error('Unknown error'));
      }
    },

  del: (key: string) => async () => {
    try {
      await client.del(key);
      return E.right(undefined);
    } catch (error) {
      return E.left(error instanceof Error ? error : new Error('Unknown error'));
    }
  },
});
