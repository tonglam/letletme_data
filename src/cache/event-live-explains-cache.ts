import type Redis from 'ioredis';

import { safeValidateEventLiveExplain } from '../domain/event-live-explains';
import { logDebug, logError, logInfo } from '../utils/logger';
import { getActiveCacheSeason } from './cache-season';
import { redisSingleton } from './singleton';

import type { EventLiveExplain } from '../domain/event-live-explains';
import type { EventId } from '../types/base.type';

type LegacyEventLiveExplain = Omit<
  EventLiveExplain,
  'defensiveContribution' | 'defensiveContributionPoints'
>;

type EventLiveExplainCacheDependencies = {
  getRedisClient: () => Promise<Redis>;
  getSeason: () => Promise<string>;
};

function serializeLegacyExplain(explain: EventLiveExplain): LegacyEventLiveExplain {
  return {
    eventId: explain.eventId,
    elementId: explain.elementId,
    bonus: explain.bonus,
    minutes: explain.minutes,
    minutesPoints: explain.minutesPoints,
    goalsScored: explain.goalsScored,
    goalsScoredPoints: explain.goalsScoredPoints,
    assists: explain.assists,
    assistsPoints: explain.assistsPoints,
    cleanSheets: explain.cleanSheets,
    cleanSheetsPoints: explain.cleanSheetsPoints,
    goalsConceded: explain.goalsConceded,
    goalsConcededPoints: explain.goalsConcededPoints,
    ownGoals: explain.ownGoals,
    ownGoalsPoints: explain.ownGoalsPoints,
    penaltiesSaved: explain.penaltiesSaved,
    penaltiesSavedPoints: explain.penaltiesSavedPoints,
    penaltiesMissed: explain.penaltiesMissed,
    penaltiesMissedPoints: explain.penaltiesMissedPoints,
    yellowCards: explain.yellowCards,
    yellowCardsPoints: explain.yellowCardsPoints,
    redCards: explain.redCards,
    redCardsPoints: explain.redCardsPoints,
    saves: explain.saves,
    savesPoints: explain.savesPoints,
  };
}

function parseValidatedHash(
  hash: Record<string, string>,
  key: string,
  eventId: EventId,
): Map<number, EventLiveExplain> {
  const explains = new Map<number, EventLiveExplain>();
  for (const [field, raw] of Object.entries(hash)) {
    try {
      const explain = safeValidateEventLiveExplain(JSON.parse(raw));
      if (!explain || explain.eventId !== eventId || String(explain.elementId) !== field) {
        logError(
          'Skipping invalid event live explain cache field',
          new Error('identity mismatch'),
          {
            key,
            eventId,
            field,
          },
        );
        continue;
      }
      explains.set(explain.elementId, explain);
    } catch (error) {
      logError('Skipping corrupt event live explain cache field', error, { key, eventId, field });
    }
  }
  return explains;
}

/**
 * Event live explain cache operations.
 *
 * EventLiveExplain is a frozen consumer contract and intentionally omits the
 * 2025/26 defensive-contribution fields. EventLiveExplainV2 is the additive
 * complete shape. Internal readers prefer V2 per player and fall back to the
 * legacy hash, whose missing V2 fields are normalized to null by the schema.
 */
export function createEventLiveExplainCache(dependencies: EventLiveExplainCacheDependencies) {
  return {
    async getByEventId(eventId: EventId): Promise<EventLiveExplain[] | null> {
      try {
        const redis = await dependencies.getRedisClient();
        const season = await dependencies.getSeason();
        const legacyKey = `EventLiveExplain:${season}:${eventId}`;
        const v2Key = `EventLiveExplainV2:${season}:${eventId}`;
        const [v2Hash, legacyHash] = await Promise.all([
          redis.hgetall(v2Key),
          redis.hgetall(legacyKey),
        ]);

        const explains = parseValidatedHash(v2Hash, v2Key, eventId);
        for (const [elementId, explain] of parseValidatedHash(legacyHash, legacyKey, eventId)) {
          if (!explains.has(elementId)) explains.set(elementId, explain);
        }
        if (explains.size === 0) {
          logDebug('Event live explain cache miss', { eventId, season });
          return null;
        }

        logDebug('Event live explain cache hit', { eventId, season, count: explains.size });
        return [...explains.values()];
      } catch (error) {
        logError('Event live explain cache get error', error, { eventId });
        return null;
      }
    },

    async set(eventId: EventId, explains: EventLiveExplain[]): Promise<void> {
      try {
        if (explains.length === 0) {
          logInfo('No event live explain data to cache', { eventId });
          return;
        }

        const redis = await dependencies.getRedisClient();
        const season = await dependencies.getSeason();
        const legacyKey = `EventLiveExplain:${season}:${eventId}`;
        const v2Key = `EventLiveExplainV2:${season}:${eventId}`;
        const legacyHash: Record<string, string> = {};
        const v2Hash: Record<string, string> = {};
        for (const explain of explains) {
          const field = explain.elementId.toString();
          legacyHash[field] = JSON.stringify(serializeLegacyExplain(explain));
          v2Hash[field] = JSON.stringify(explain);
        }

        const results = await redis
          .multi()
          .del(legacyKey, v2Key)
          .hset(legacyKey, legacyHash)
          .hset(v2Key, v2Hash)
          .exec();
        if (!results) throw new Error('Event live explain cache transaction was aborted');
        const commandError = results.find(([error]) => error !== null)?.[0];
        if (commandError) throw commandError;

        logInfo('Event live explains cached', { eventId, season, count: explains.length });
      } catch (error) {
        logError('Event live explain cache set error', error, { eventId, count: explains.length });
        throw error;
      }
    },

    async clearByEventId(eventId: EventId): Promise<void> {
      try {
        const redis = await dependencies.getRedisClient();
        const season = await dependencies.getSeason();
        await redis.del(
          `EventLiveExplain:${season}:${eventId}`,
          `EventLiveExplainV2:${season}:${eventId}`,
        );

        logInfo('Event live explain cache cleared', { eventId, season });
      } catch (error) {
        logError('Failed to clear event live explain cache', error, { eventId });
        throw error;
      }
    },
  };
}

export const eventLiveExplainCache = createEventLiveExplainCache({
  getRedisClient: () => redisSingleton.getClient(),
  getSeason: getActiveCacheSeason,
});
