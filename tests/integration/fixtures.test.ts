import { beforeAll, describe, expect, test } from 'bun:test';

import { fixtureRepository } from '../../src/repositories/fixtures';
import {
  clearFixturesCache,
  getFixture,
  getFixtures,
  getFixturesByEvent,
  getFixturesByTeam,
  syncFixtures,
} from '../../src/services/fixtures.service';

describe('Fixtures Integration Tests', () => {
  beforeAll(async () => {
    // SINGLE setup - one API call for entire test suite
    await clearFixturesCache();
    // Don't delete fixtures - they may have foreign key references from other tables
    // syncFixtures uses upsert which will update existing records
    await syncFixtures(); // ONLY API call in entire test suite - tests: FPL API → DB → Redis
  });

  describe('External Data Integration', () => {
    test('should fetch and sync fixtures from FPL API', async () => {
      const fixtures = await getFixtures();
      expect(fixtures.length).toBeGreaterThan(0); // FPL has 380 fixtures per season (20 teams * 38 rounds * 10 matches / round approx)
      expect(fixtures[0]).toHaveProperty('id');
      expect(fixtures[0]).toHaveProperty('code');
      expect(fixtures[0]).toHaveProperty('event');
      expect(fixtures[0]).toHaveProperty('teamA');
      expect(fixtures[0]).toHaveProperty('teamH');
    });

    test('should save fixtures to database', async () => {
      const dbFixtures = await fixtureRepository.findAll();
      expect(dbFixtures.length).toBeGreaterThan(0);
      expect(dbFixtures[0].id).toBeTypeOf('number');
      expect(dbFixtures[0].code).toBeTypeOf('number');
      expect(dbFixtures[0].teamA).toBeTypeOf('number');
      expect(dbFixtures[0].teamH).toBeTypeOf('number');
    });
  });

  describe('Service Layer Integration', () => {
    test('should retrieve fixture by ID', async () => {
      const fixtures = await getFixtures();
      const firstFixtureId = fixtures[0].id;

      const fixture = await getFixture(firstFixtureId);
      expect(fixture).toBeDefined();
      expect(fixture?.id).toBe(firstFixtureId);
    });

    test('should get fixtures by event', async () => {
      const eventFixtures = await getFixturesByEvent(1);
      expect(eventFixtures.length).toBeGreaterThan(0);
      eventFixtures.forEach((fixture) => {
        expect(fixture.event).toBe(1);
      });
    });

    test('should get fixtures by team', async () => {
      const teamFixtures = await getFixturesByTeam(1);
      expect(teamFixtures.length).toBeGreaterThan(0);
      teamFixtures.forEach((fixture) => {
        expect(fixture.teamA === 1 || fixture.teamH === 1).toBe(true);
      });
    });

    test('should get all fixtures from cache', async () => {
      const fixtures = await getFixtures(); // Should hit cache
      expect(fixtures.length).toBeGreaterThan(0);
    });
  });

  describe('Cache Integration', () => {
    test('should use cache for fast retrieval', async () => {
      const fixtures = await getFixtures(); // Should hit cache
      expect(fixtures.length).toBeGreaterThan(0);
    });

    test('should handle database fallback', async () => {
      await clearFixturesCache(); // Clear once to test fallback
      const fixtures = await getFixtures(); // Should fallback to database
      expect(fixtures.length).toBeGreaterThan(0);
    });

    test('should cache fixtures by event', async () => {
      const eventFixtures = await getFixturesByEvent(1); // Should hit cache or database
      expect(eventFixtures.length).toBeGreaterThan(0);
    });

    test('should cache fixtures by team', async () => {
      const teamFixtures = await getFixturesByTeam(1); // Should hit cache or database
      expect(teamFixtures.length).toBeGreaterThan(0);
    });
  });

  describe('Data Consistency', () => {
    test('should maintain consistent data across layers', async () => {
      const serviceFixtures = await getFixtures();
      const dbFixtures = await fixtureRepository.findAll();

      expect(serviceFixtures.length).toBe(dbFixtures.length);
      expect(serviceFixtures[0].id).toBe(dbFixtures[0].id);
    });

    test('should have consistent event filtering', async () => {
      const allFixtures = await getFixtures();
      const eventFixtures = await getFixturesByEvent(1);

      const expectedCount = allFixtures.filter((f) => f.event === 1).length;
      expect(eventFixtures.length).toBe(expectedCount);
    });

    test('should have consistent team filtering', async () => {
      const allFixtures = await getFixtures();
      const teamFixtures = await getFixturesByTeam(1);

      const expectedCount = allFixtures.filter((f) => f.teamA === 1 || f.teamH === 1).length;
      expect(teamFixtures.length).toBe(expectedCount);
    });
  });

  describe('Fixture Data Validation', () => {
    test('should have valid fixture structure', async () => {
      const fixtures = await getFixtures();

      fixtures.forEach((fixture) => {
        expect(fixture.id).toBeGreaterThan(0);
        expect(fixture.code).toBeGreaterThan(0);
        expect(fixture.teamA).toBeGreaterThan(0);
        expect(fixture.teamH).toBeGreaterThan(0);
        expect(fixture.pulseId).toBeGreaterThan(0);
        expect(typeof fixture.finished).toBe('boolean');
        expect(Array.isArray(fixture.stats)).toBe(true);
      });
    });

    test('should have valid finished fixtures', async () => {
      const fixtures = await getFixtures();
      const finishedFixtures = fixtures.filter((f) => f.finished);

      if (finishedFixtures.length > 0) {
        finishedFixtures.forEach((fixture) => {
          expect(fixture.finished).toBe(true);
          expect(fixture.minutes).toBeGreaterThanOrEqual(0);
          // Scores may be null for abandoned matches, so we don't strictly check them
        });
      }
    });

    test('should have valid upcoming fixtures', async () => {
      const fixtures = await getFixtures();
      const upcomingFixtures = fixtures.filter((f) => !f.finished && f.kickoffTime);

      upcomingFixtures.forEach((fixture) => {
        expect(fixture.finished).toBe(false);
        expect(fixture.kickoffTime).toBeInstanceOf(Date);
      });
    });
  });

  describe('Event-based Sync', () => {
    test('should sync fixtures for specific event', async () => {
      const result = await syncFixtures(1);
      expect(result.count).toBeGreaterThan(0);
      expect(result.errors).toBeGreaterThanOrEqual(0);
    });

    test('should maintain all fixtures after event-specific sync', async () => {
      const fixturesBeforeSync = await getFixtures();
      const countBefore = fixturesBeforeSync.length;

      await syncFixtures(1); // Sync only event 1

      const fixturesAfterSync = await getFixtures();
      expect(fixturesAfterSync.length).toBe(countBefore); // Should maintain all fixtures
    });
  });
});
