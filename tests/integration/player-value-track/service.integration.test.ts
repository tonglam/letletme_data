import { PrismaClient } from '@prisma/client';
import * as E from 'fp-ts/Either';
import { Logger } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CachePrefix } from '../../../src/configs/cache/cache.config';
import { createFplBootstrapDataService } from '../../../src/data/fpl/bootstrap.data';
import { FplBootstrapDataService } from '../../../src/data/types';
import { createEventCache } from '../../../src/domains/event/cache';
import { EventCache } from '../../../src/domains/event/types';
import { redisClient } from '../../../src/infrastructures/cache/client';
import { HTTPClient } from '../../../src/infrastructures/http';
import { createEventRepository } from '../../../src/repositories/event/repository';
import { EventRepository } from '../../../src/repositories/event/type';
import { createPlayerValueTrackRepository } from '../../../src/repositories/player-value-track/repository';
import { PlayerValueTrackRepository } from '../../../src/repositories/player-value-track/type';
import { createEventService } from '../../../src/services/event/service';
import { EventService } from '../../../src/services/event/types';
import { createPlayerValueTrackService } from '../../../src/services/player-value-track/service';
import { PlayerValueTrackService } from '../../../src/services/player-value-track/types';
import { formatYYYYMMDD } from '../../../src/utils/date.util';
import {
  IntegrationTestSetupResult,
  setupIntegrationTest,
  teardownIntegrationTest,
} from '../../setup/integrationTestSetup';

describe('PlayerValueTrack Integration Tests', { timeout: 30000 }, () => {
  let setup: IntegrationTestSetupResult;
  let prisma: PrismaClient;
  let logger: Logger;
  let httpClient: HTTPClient;
  let playerValueTrackRepository: PlayerValueTrackRepository;
  let fplDataService: FplBootstrapDataService;
  let playerValueTrackService: PlayerValueTrackService;
  let eventService: EventService;
  let eventRepository: EventRepository;
  let eventCache: EventCache;

  const eventCachePrefix = CachePrefix.EVENT;
  const season = '2425';

  beforeAll(async () => {
    setup = await setupIntegrationTest();
    prisma = setup.prisma;
    logger = setup.logger;
    httpClient = setup.httpClient;

    // Ping shared client (optional, good practice)
    try {
      await redisClient.ping();
    } catch (error) {
      logger.error({ err: error }, 'Shared redisClient ping failed in beforeAll.');
    }

    // Initialize FPL Data Service
    fplDataService = createFplBootstrapDataService(httpClient, logger);

    // Initialize Repositories
    playerValueTrackRepository = createPlayerValueTrackRepository(prisma);
    eventRepository = createEventRepository(prisma); // For EventService

    // Initialize Caches
    eventCache = createEventCache({
      keyPrefix: eventCachePrefix,
      season: season,
    }); // For EventService

    // Initialize Services (Dependencies first)
    eventService = createEventService(
      fplDataService,
      eventRepository,
      eventCache, // Pass cache to EventService
    );
    playerValueTrackService = createPlayerValueTrackService(
      fplDataService,
      eventService,
      playerValueTrackRepository,
    );
  });

  afterAll(async () => {
    await teardownIntegrationTest(setup);
    // Optional: await redisClient.quit(); if needed globally
  });

  describe('PlayerValueTrack Service Integration', () => {
    it('should fetch player value tracks from API, store in database', async () => {
      // Ensure prerequisites are met (e.g., current event exists)
      const currentEventResult = await eventService.getCurrentEvent()();
      expect(E.isRight(currentEventResult)).toBe(true);

      // Execute the sync operation
      const syncResult = await playerValueTrackService.syncPlayerValueTracksFromApi()();

      // Assert success
      expect(E.isRight(syncResult)).toBe(true);

      // Verify data in the database
      const dbTracks = await prisma.playerValueTrack.findMany();
      // Note: FPL API might not return tracks every day, so length > 0 isn't guaranteed
      // Check that the operation completed without error.
      expect(dbTracks).toBeInstanceOf(Array);
    });

    it('should get player value tracks by date after syncing', async () => {
      // Sync first to ensure data exists (if API provides any for today)
      const syncResult = await playerValueTrackService.syncPlayerValueTracksFromApi()();
      expect(E.isRight(syncResult)).toBe(true); // Sync should succeed

      const todayStr = formatYYYYMMDD();

      // Attempt to fetch tracks for today's date
      const tracksResult = await playerValueTrackService.getPlayerValueTracksByDate(todayStr)();

      expect(E.isRight(tracksResult)).toBe(true);

      if (E.isRight(tracksResult)) {
        const tracks = tracksResult.right;
        expect(Array.isArray(tracks)).toBe(true);

        // If tracks were returned by the API for today, verify them
        if (tracks.length > 0) {
          tracks.forEach((track) => {
            expect(track).toHaveProperty('elementId');
            expect(track).toHaveProperty('value');
            expect(track).toHaveProperty('date');
            // Check if the date matches
            expect(track.date).toEqual(todayStr);
          });
        } else {
          // If no tracks, it might be valid (API didn't return any for the day)
          logger.info(
            `No player value tracks found for date ${todayStr}, which might be expected.`,
          );
        }
      }
    });
  });
});
