import { createEventFixtureCache } from 'domain/event-fixture/cache';
import { type EventFixtureCache } from 'domain/event-fixture/types';
import { createTeamCache } from 'domain/team/cache';
import { type TeamCache } from 'domain/team/types';
import { createTeamFixtureCache } from 'domain/team-fixture/cache';
import { type TeamFixtureCache } from 'domain/team-fixture/types';

import { beforeAll, describe, expect, it } from 'bun:test';
import { CachePrefix, DefaultTTL } from 'config/cache/cache.config';
import { createFplFixtureDataService } from 'data/fpl/fixture.data';
import { type FplFixtureDataService } from 'data/types';
import * as E from 'fp-ts/Either';
import { redisClient } from 'infrastructure/cache/client';
import { type Logger } from 'pino';
import { createEventFixtureRepository } from 'repository/event-fixture/repository';
import { type EventFixtureRepository } from 'repository/event-fixture/types';
import { createFixtureService } from 'service/fixture/service';
import { type FixtureService } from 'service/fixture/types';
import { type EventFixture } from 'types/domain/event-fixture.type';
import { type EventId } from 'types/domain/event.type';
import { type TeamFixture } from 'types/domain/team-fixture.type';
import { type TeamId } from 'types/domain/team.type';

// Test Setup
import {
  type IntegrationTestSetupResult,
  setupIntegrationTest,
} from '../setup/integrationTestSetup';

describe('Fixture Service (EventFixture focus) Integration Tests', () => {
  let setup: IntegrationTestSetupResult;
  let db: IntegrationTestSetupResult['db'];
  let logger: Logger;
  let eventFixtureRepository: EventFixtureRepository;
  let eventFixtureCache: EventFixtureCache;
  let teamFixtureCache: TeamFixtureCache;
  let teamCache: TeamCache;
  let fplDataService: FplFixtureDataService;
  let fixtureService: FixtureService;

  const cachePrefixEventFixture = CachePrefix.EVENT_FIXTURE;
  const cachePrefixTeamFixture = CachePrefix.TEAM_FIXTURE;
  const cachePrefixTeam = CachePrefix.TEAM;
  const season = '2425';
  const eventId = 1 as EventId;

  let knownTeamId: TeamId | null = null;

  beforeAll(async () => {
    setup = await setupIntegrationTest();
    db = setup.db;
    logger = setup.logger;

    try {
      await redisClient.ping();
    } catch (error) {
      logger.error({ err: error }, 'Shared redisClient ping failed in beforeAll.');
    }

    eventFixtureRepository = createEventFixtureRepository();
    eventFixtureCache = createEventFixtureCache({
      keyPrefix: cachePrefixEventFixture,
      season: season,
      ttlSeconds: DefaultTTL.EVENT_FIXTURE,
    });
    teamFixtureCache = createTeamFixtureCache({
      keyPrefix: cachePrefixTeamFixture,
      season: season,
      ttlSeconds: DefaultTTL.TEAM_FIXTURE,
    });
    teamCache = createTeamCache({
      keyPrefix: cachePrefixTeam,
      season: season,
      ttlSeconds: DefaultTTL.TEAM,
    });
    fplDataService = createFplFixtureDataService();
    fixtureService = createFixtureService(
      fplDataService,
      eventFixtureRepository,
      eventFixtureCache,
      teamFixtureCache,
      teamCache,
    );

    const syncResult = await fixtureService.syncEventFixturesFromApi(eventId)();
    if (E.isLeft(syncResult)) {
      throw new Error('Initial fixture sync failed in beforeAll');
    }

    const dbFixtures = await db.query.eventFixtures.findMany({
      where: (fixturesTable, { eq }) => eq(fixturesTable.eventId, eventId),
      limit: 1,
    });
    if (dbFixtures.length > 0 && dbFixtures[0].teamHId !== null) {
      knownTeamId = dbFixtures[0].teamHId as TeamId;
    } else {
      logger.warn('Could not find a known team ID from synced fixtures in beforeAll');
    }
  });

  describe('Fixture Service Integration - Event Fixture Handling', () => {
    it('should have synced event fixtures successfully in beforeAll', async () => {
      const dbFixtures = await db.query.eventFixtures.findMany({
        where: (fixturesTable, { eq }) => eq(fixturesTable.eventId, eventId),
      });
      expect(dbFixtures.length).toBeGreaterThan(0);

      const cacheKeyEventFixture = `${cachePrefixEventFixture}::${season}::${eventId}`;
      const keyExistsEventFixture = await redisClient.exists(cacheKeyEventFixture);
      expect(keyExistsEventFixture).toBe(1);

      if (knownTeamId) {
        const cacheKeyTeamFixture = `${cachePrefixTeamFixture}::${season}::${knownTeamId}`;
        const keyExistsTeamFixture = await redisClient.exists(cacheKeyTeamFixture);
        expect(keyExistsTeamFixture).toBe(1);
      }
    });

    it('should get event fixtures by event ID', async () => {
      const getFixturesResult = await fixtureService.getFixturesByEventId(eventId)();
      expect(E.isRight(getFixturesResult)).toBe(true);

      if (E.isRight(getFixturesResult) && Array.isArray(getFixturesResult.right)) {
        const fixtures: EventFixture[] = getFixturesResult.right;
        expect(fixtures).toBeDefined();
        expect(fixtures.length).toBeGreaterThan(0);
        const firstFixture = fixtures[0];
        expect(firstFixture).toHaveProperty('id');
        expect(firstFixture).toHaveProperty('eventId', eventId);
        expect(firstFixture).toHaveProperty('teamHId');
        expect(firstFixture).toHaveProperty('teamAId');
      } else {
        throw new Error(
          `Expected Right<EventFixture[]> but got different result: ${JSON.stringify(getFixturesResult)}`,
        );
      }
    });

    it('should get team fixtures by team ID', async () => {
      if (!knownTeamId) {
        console.warn('Skipping test: getFixturesByTeamId - No knownTeamId found.');
        return;
      }

      const getTeamFixturesResult = await fixtureService.getFixturesByTeamId(knownTeamId)();
      expect(E.isRight(getTeamFixturesResult)).toBe(true);

      if (E.isRight(getTeamFixturesResult) && Array.isArray(getTeamFixturesResult.right)) {
        const teamFixtures: TeamFixture[] = getTeamFixturesResult.right;
        expect(teamFixtures).toBeDefined();
        expect(teamFixtures.length).toBeGreaterThan(0);
        teamFixtures.forEach((fixture) => {
          expect(fixture).toHaveProperty('teamId', knownTeamId);
          expect(fixture).toHaveProperty('eventId');
          expect(fixture).toHaveProperty('opponentTeamId');
        });
      } else {
        throw new Error(
          `Expected Right<TeamFixture[]> but got different result: ${JSON.stringify(getTeamFixturesResult)}`,
        );
      }
    });

    it('should get all event fixtures', async () => {
      const getAllFixturesResult = await fixtureService.getFixtures()();
      expect(E.isRight(getAllFixturesResult)).toBe(true);

      if (E.isRight(getAllFixturesResult) && Array.isArray(getAllFixturesResult.right)) {
        const allFixtures: EventFixture[] = getAllFixturesResult.right;
        expect(allFixtures).toBeDefined();
        expect(allFixtures.length).toBeGreaterThan(0);
        const firstFixture = allFixtures[0];
        expect(firstFixture).toHaveProperty('id');
        expect(firstFixture).toHaveProperty('eventId');
      } else {
        throw new Error(
          `Expected Right<EventFixture[]> but got different result: ${JSON.stringify(getAllFixturesResult)}`,
        );
      }
    });
  });
});
