import { getCurrentSeason } from '../utils/conditions';
import { logDebug, logError, logInfo } from '../utils/logger';
import { CACHE_TTL, redisSingleton } from './singleton';

import type { EventOverallResultData } from '../domain/event-overall-results';

/**
 * Event Overall Result Cache Operations
 * Pattern: EventOverallResult:season -> hash of eventId -> result data
 */
export const eventOverallResultCache = {
  async getAll(): Promise<EventOverallResultData[] | null> {
    try {
      const redis = await redisSingleton.getClient();
      const key = `EventOverallResult:${getCurrentSeason()}`;
      const hash = await redis.hgetall(key);

      if (!hash || Object.keys(hash).length === 0) {
        logDebug('Event overall result cache miss');
        return null;
      }

      const results = Object.values(hash).map(
        (value) => JSON.parse(value) as EventOverallResultData,
      );
      results.sort((a, b) => a.event - b.event);
      logDebug('Event overall result cache hit', { count: results.length });
      return results;
    } catch (error) {
      logError('Event overall result cache get error', error);
      return null;
    }
  },

  async setAll(results: EventOverallResultData[]): Promise<void> {
    try {
      if (results.length === 0) {
        logInfo('No event overall results to cache');
        return;
      }

      const redis = await redisSingleton.getClient();
      const key = `EventOverallResult:${getCurrentSeason()}`;

      const hashData: Record<string, string> = {};
      for (const result of results) {
        hashData[result.event.toString()] = JSON.stringify(result);
      }

      await redis.del(key);
      await redis.hset(key, hashData);
      await redis.expire(key, CACHE_TTL.EVENT_OVERALL_RESULT);

      logInfo('Event overall results cached', { count: results.length });
    } catch (error) {
      logError('Event overall result cache set error', error, { count: results.length });
      throw error;
    }
  },
};
