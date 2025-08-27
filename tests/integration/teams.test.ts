import { beforeAll, describe, expect, test } from 'bun:test';

import { teamRepository } from '../../src/repositories/teams';
import { clearTeamsCache, getTeam, getTeams, syncTeams } from '../../src/services/teams.service';

describe('Teams Integration Tests', () => {
  beforeAll(async () => {
    // SINGLE setup - one API call for entire test suite
    await clearTeamsCache();
    await teamRepository.deleteAll();
    await syncTeams(); // ONLY API call in entire test suite - tests: FPL API → DB → Redis
  });

  describe('External Data Integration', () => {
    test('should fetch and sync teams from FPL API', async () => {
      const teams = await getTeams();
      expect(teams.length).toBe(20); // Premier League has 20 teams
      expect(teams[0]).toHaveProperty('id');
      expect(teams[0]).toHaveProperty('name');
      expect(teams[0]).toHaveProperty('shortName');
    });

    test('should save teams to database', async () => {
      const dbTeams = await teamRepository.findAll();
      expect(dbTeams.length).toBe(20);
      expect(dbTeams[0].id).toBeTypeOf('number');
      expect(dbTeams[0].name).toBeTypeOf('string');
    });
  });

  describe('Service Layer Integration', () => {
    test('should retrieve team by ID', async () => {
      const team = await getTeam(1);
      expect(team).toBeDefined();
      expect(team?.id).toBe(1);
      expect(team?.name).toBeTypeOf('string');
    });

    test('should get all teams from cache', async () => {
      const teams = await getTeams(); // Should hit cache
      expect(teams.length).toBe(20);
      expect(teams[0]).toHaveProperty('id');
      expect(teams[0]).toHaveProperty('name');
      expect(teams[0]).toHaveProperty('shortName');
    });
  });

  describe('Cache Integration', () => {
    test('should use cache for fast retrieval', async () => {
      const teams = await getTeams(); // Should hit cache
      expect(teams.length).toBe(20);
    });

    test('should handle database fallback', async () => {
      await clearTeamsCache(); // Clear once to test fallback
      const teams = await getTeams(); // Should fallback to database
      expect(teams.length).toBe(20);
    });
  });

  describe('Data Consistency', () => {
    test('should maintain consistent data across layers', async () => {
      const serviceTeams = await getTeams();
      const dbTeams = await teamRepository.findAll();

      expect(serviceTeams.length).toBe(dbTeams.length);
      expect(serviceTeams[0].id).toBe(dbTeams[0].id);
      expect(serviceTeams[0].name).toBe(dbTeams[0].name);
    });
  });
});
