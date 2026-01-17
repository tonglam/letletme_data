import { getCurrentSeason } from '../utils/conditions';
import { logDebug, logError } from '../utils/logger';
import { CACHE_TTL, redisSingleton } from './singleton';

import type { Team } from '../types';

export const teamsCache = {
  // Store all teams in a single hash (efficient batch operation)
  async set(teams: Team[]): Promise<void> {
    try {
      const redis = await redisSingleton.getClient();
      const season = getCurrentSeason();
      const key = `Team:${season}`;

      // Use pipeline for atomic operation
      const pipeline = redis.pipeline();

      // Clear existing hash
      pipeline.del(key);

      if (teams.length > 0) {
        // Store each team as a hash field (team ID -> full team JSON)
        const teamFields: Record<string, string> = {};
        for (const team of teams) {
          teamFields[team.id.toString()] = JSON.stringify(team);
        }
        pipeline.hset(key, teamFields);
        pipeline.expire(key, CACHE_TTL.TEAMS);
      }

      await pipeline.exec();
      logDebug('Teams cache updated (hash)', { count: teams.length, season });
    } catch (error) {
      logError('Teams cache set error', error);
      throw error;
    }
  },
};
