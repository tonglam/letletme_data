import { createClient } from 'redis';
import { Option, some, none } from 'fp-ts/Option';
import { CacheStrategy } from '../events/types';

export class RedisCache implements CacheStrategy {
  private client;

  constructor(redisUrl: string) {
    this.client = createClient({
      url: redisUrl
    });

    this.client.on('error', (err) => console.error('Redis Client Error:', err));
    this.client.connect();
  }

  async get<T>(key: string): Promise<Option<T>> {
    try {
      const value = await this.client.get(key);
      if (!value) {
        return none;
      }
      return some(JSON.parse(value) as T);
    } catch (error) {
      console.error('Redis get error:', error);
      return none;
    }
  }

  async set<T>(key: string, value: T, ttl?: number): Promise<void> {
    try {
      const stringValue = JSON.stringify(value);
      if (ttl) {
        await this.client.setEx(key, ttl, stringValue);
      } else {
        await this.client.set(key, stringValue);
      }
    } catch (error) {
      console.error('Redis set error:', error);
      throw error;
    }
  }

  async invalidate(pattern: string): Promise<void> {
    try {
      const keys = await this.client.keys(pattern);
      if (keys.length > 0) {
        await this.client.del(keys);
      }
    } catch (error) {
      console.error('Redis invalidate error:', error);
      throw error;
    }
  }

  async clear(): Promise<void> {
    try {
      await this.client.flushDb();
    } catch (error) {
      console.error('Redis clear error:', error);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    try {
      await this.client.quit();
    } catch (error) {
      console.error('Redis disconnect error:', error);
      throw error;
    }
  }
}
