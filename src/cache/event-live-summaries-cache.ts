import { getActiveCacheSeason } from './cache-season';
import { parseHashValues } from './hash-read';
import { logDebug, logError, logInfo } from '../utils/logger';
import { redisSingleton } from './singleton';

import type { EventLiveSummary } from '../domain/event-live-summaries';

/**
 * Event Live Summary Cache Operations
 * Pattern: EventLiveSummary:season -> hash of elementId -> season summary data
 */
export const eventLiveSummaryCache = {
  async get(): Promise<EventLiveSummary[] | null> {
    try {
      const redis = await redisSingleton.getClient();
      const key = `EventLiveSummary:${await getActiveCacheSeason()}`;
      const hash = await redis.hgetall(key);

      if (!hash || Object.keys(hash).length === 0) {
        logDebug('Event live summary cache miss', { key });
        return null;
      }

      const summaries = parseHashValues<EventLiveSummary>(hash, { key });
      logDebug('Event live summary cache hit', { key, count: summaries.length });
      return summaries;
    } catch (error) {
      logError('Event live summary cache get error', error);
      return null;
    }
  },

  async set(summaries: EventLiveSummary[]): Promise<void> {
    try {
      if (summaries.length === 0) {
        logInfo('No event live summary data to cache');
        return;
      }

      const redis = await redisSingleton.getClient();
      const key = `EventLiveSummary:${await getActiveCacheSeason()}`;

      const hashData: Record<string, string> = {};
      for (const summary of summaries) {
        hashData[summary.elementId.toString()] = JSON.stringify(summary);
      }

      await redis.del(key);
      await redis.hset(key, hashData);

      logInfo('Event live summaries cached', { key, count: summaries.length });
    } catch (error) {
      logError('Event live summary cache set error', error, { count: summaries.length });
      throw error;
    }
  },

  async clear(): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();
      const key = `EventLiveSummary:${await getActiveCacheSeason()}`;
      await redis.del(key);

      logInfo('Event live summary cache cleared', { key });
    } catch (error) {
      logError('Failed to clear event live summary cache', error);
      throw error;
    }
  },
};
