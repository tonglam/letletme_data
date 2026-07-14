import { logDebug, logError } from '../utils/logger';
import { finalizeSeasonCacheWrite, getActiveCacheSeason } from './cache-season';
import { redisSingleton } from './singleton';

import type { Phase } from '../types';

export const phasesCache = {
  // Store all phases in a single hash (efficient batch operation)
  async set(phases: Phase[], season?: string): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();
      const activeSeason = season ?? (await getActiveCacheSeason());
      const key = `Phase:${activeSeason}`;

      // Use pipeline for atomic operation
      const pipeline = redis.pipeline();

      // Clear existing hash
      pipeline.del(key);

      if (phases.length > 0) {
        // Store each phase as a hash field (phase ID -> full phase JSON)
        const phaseFields: Record<string, string> = {};
        for (const phase of phases) {
          phaseFields[phase.id.toString()] = JSON.stringify(phase);
        }
        pipeline.hset(key, phaseFields);
      }

      await pipeline.exec();
      await finalizeSeasonCacheWrite(activeSeason, ['Phase']);
      logDebug('Phases cache updated (hash)', { count: phases.length, season: activeSeason });
    } catch (error) {
      logError('Phases cache set error', error);
      throw error;
    }
  },

  async clear(): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();
      const season = await getActiveCacheSeason();
      const key = `Phase:${season}`;
      await redis.del(key);
      logDebug('Phases cache cleared', { season });
    } catch (error) {
      logError('Phases cache clear error', error);
      throw error;
    }
  },
};
