import { getCurrentSeason } from '../utils/conditions';
import { logDebug, logError } from '../utils/logger';
import { CACHE_TTL, redisSingleton } from './singleton';

import type { Phase } from '../types';

export const phasesCache = {
  // Store all phases in a single hash (efficient batch operation)
  async set(phases: Phase[]): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();
      const season = getCurrentSeason();
      const key = `Phase:${season}`;

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
        pipeline.expire(key, CACHE_TTL.PHASES);
      }

      await pipeline.exec();
      logDebug('Phases cache updated (hash)', { count: phases.length, season });
    } catch (error) {
      logError('Phases cache set error', error);
      throw error;
    }
  },

  async clear(): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();
      const season = getCurrentSeason();
      const key = `Phase:${season}`;
      await redis.del(key);
      logDebug('Phases cache cleared', { season });
    } catch (error) {
      logError('Phases cache clear error', error);
      throw error;
    }
  },
};
