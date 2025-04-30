import { createEventCache } from 'domain/event/cache';
import { EventCache } from 'domain/event/types';
import { createEventFixtureCache } from 'domain/event-fixture/cache';
import { EventFixtureCache } from 'domain/event-fixture/types';
import { createTeamCache } from 'domain/team/cache';
import { TeamCache } from 'domain/team/types';
import { createTeamFixtureCache } from 'domain/team-fixture/cache';
import { TeamFixtureCache } from 'domain/team-fixture/types';

import { beforeAll, describe, expect, it } from 'bun:test';
import { CachePrefix, DefaultTTL } from 'config/cache/cache.config';
import { createFplBootstrapDataService } from 'data/fpl/bootstrap.data';
import { createFplFixtureDataService } from 'data/fpl/fixture.data';
import { FplBootstrapDataService, FplFixtureDataService } from 'data/types';
import { db } from 'db/index';
import * as playerValueTrackSchema from 'db/schema/player-value-track';
import { desc } from 'drizzle-orm';
import * as E from 'fp-ts/Either';
import { redisClient } from 'infrastructure/cache/client';
import { Logger } from 'pino';
import { createEventRepository } from 'repository/event/repository';
import { EventRepository } from 'repository/event/types';
import { createEventFixtureRepository } from 'repository/event-fixture/repository';
import { EventFixtureRepository } from 'repository/event-fixture/types';
import { createPlayerValueTrackRepository } from 'repository/player-value-track/repository';
import { PlayerValueTrackRepository } from 'repository/player-value-track/types';
import { createEventService } from 'service/event/service';
import { EventService } from 'service/event/types';
import { createFixtureService } from 'service/fixture/service';
import { FixtureService } from 'service/fixture/types';
import { createPlayerValueTrackService } from 'service/player-value-track/service';
import { PlayerValueTrackService } from 'service/player-value-track/types';
import { IntegrationTestSetupResult, setupIntegrationTest } from 'tests/setup/integrationTestSetup';
import { formatYYYYMMDD } from 'utils/date.util';

describe('PlayerValueTrack Service Integration Tests', () => {
  let setup: IntegrationTestSetupResult;
  let logger: Logger;
  let playerValueTrackRepository: PlayerValueTrackRepository;
  let fplDataService: FplBootstrapDataService;
  let fplFixtureDataService: FplFixtureDataService;
  let playerValueTrackService: PlayerValueTrackService;
  let eventService: EventService;
  let eventRepository: EventRepository;
  let eventCache: EventCache;
  let fixtureService: FixtureService;
  let eventFixtureRepository: EventFixtureRepository;
  let eventFixtureCache: EventFixtureCache;
  let teamFixtureCache: TeamFixtureCache;
  let teamCache: TeamCache;

  const eventCachePrefix = CachePrefix.EVENT;
  const eventFixtureCachePrefix = CachePrefix.EVENT_FIXTURE;
  const teamFixtureCachePrefix = CachePrefix.TEAM_FIXTURE;
  const teamCachePrefix = CachePrefix.TEAM;
  const season = '2425';

  beforeAll(async () => {
    setup = await setupIntegrationTest();
    logger = setup.logger;

    try {
      await redisClient.ping();
      logger.info('Shared redisClient ping successful in beforeAll.');
    } catch (error) {
      logger.error({ err: error }, 'Shared redisClient ping failed in beforeAll.');
    }

    fplDataService = createFplBootstrapDataService();
    fplFixtureDataService = createFplFixtureDataService();

    playerValueTrackRepository = createPlayerValueTrackRepository();
    eventRepository = createEventRepository();
    eventFixtureRepository = createEventFixtureRepository();

    eventCache = createEventCache({
      keyPrefix: eventCachePrefix,
      season: season,
      ttlSeconds: DefaultTTL.EVENT,
    });
    eventFixtureCache = createEventFixtureCache({
      keyPrefix: eventFixtureCachePrefix,
      season: season,
      ttlSeconds: DefaultTTL.EVENT_FIXTURE,
    });
    teamFixtureCache = createTeamFixtureCache({
      keyPrefix: teamFixtureCachePrefix,
      season: season,
      ttlSeconds: DefaultTTL.TEAM_FIXTURE,
    });
    teamCache = createTeamCache({
      keyPrefix: teamCachePrefix,
      season: season,
      ttlSeconds: DefaultTTL.TEAM,
    });

    fixtureService = createFixtureService(
      fplFixtureDataService,
      eventFixtureRepository,
      eventFixtureCache,
      teamFixtureCache,
      teamCache,
    );
    eventService = createEventService(fplDataService, eventRepository, eventCache, fixtureService);

    playerValueTrackService = createPlayerValueTrackService(
      fplDataService,
      playerValueTrackRepository,
      eventService,
    );
  });

  describe('PlayerValueTrack Service Operations', () => {
    it('should sync player value tracks from the FPL API and store them', async () => {
      const currentEventResult = await eventService.getCurrentEvent()();
      if (E.isLeft(currentEventResult)) {
        throw new Error(
          `Failed to get current event before syncing: ${currentEventResult.left.message}`,
        );
      }
      expect(E.isRight(currentEventResult)).toBe(true);
      logger.info('Prerequisite: Current event fetched successfully.');

      const syncResult = await playerValueTrackService.syncPlayerValueTracksFromApi()();

      if (E.isLeft(syncResult)) {
        logger.error({ error: syncResult.left }, 'Sync operation failed unexpectedly.');
      }
      expect(E.isRight(syncResult)).toBe(true);

      const dbTracks = await db
        .select()
        .from(playerValueTrackSchema.playerValueTracks)
        .orderBy(desc(playerValueTrackSchema.playerValueTracks.date))
        .limit(10);

      expect(dbTracks).toBeInstanceOf(Array);
      logger.info(
        `Checked database after sync. Found ${dbTracks.length} recent tracks (API might return none on some days).`,
      );
    });

    it('should retrieve player value tracks for a specific date after syncing', async () => {
      const syncResult = await playerValueTrackService.syncPlayerValueTracksFromApi()();
      if (E.isLeft(syncResult)) {
        logger.error(
          { error: syncResult.left },
          'Sync operation failed unexpectedly at start of second test.',
        );
      }
      expect(E.isRight(syncResult)).toBe(true);

      const todayStr = formatYYYYMMDD();

      const tracksResult = await playerValueTrackService.getPlayerValueTracksByDate(todayStr)();

      expect(E.isRight(tracksResult)).toBe(true);

      if (E.isRight(tracksResult)) {
        const tracks = tracksResult.right;
        expect(Array.isArray(tracks)).toBe(true);

        if (tracks.length > 0) {
          logger.info(`Found ${tracks.length} player value tracks for date ${todayStr}.`);
          tracks.forEach((track) => {
            expect(track).toHaveProperty('elementId');
            expect(track).toHaveProperty('value');
            expect(track).toHaveProperty('date', todayStr);
          });
        } else {
          logger.warn(
            `No player value tracks found for date ${todayStr}. This might be expected if the FPL API reported no changes.`,
          );
        }
      } else {
        logger.error({ error: tracksResult.left }, `Failed to get tracks for date ${todayStr}`);
        expect(tracksResult.left).toBeUndefined();
      }
    });
  });
});
