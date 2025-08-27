import { beforeAll, describe, expect, test } from 'bun:test';

import { phaseRepository } from '../../src/repositories/phases';
import {
  clearPhasesCache,
  getPhase,
  getPhases,
  syncPhases,
} from '../../src/services/phases.service';

describe('Phases Integration Tests', () => {
  beforeAll(async () => {
    // SINGLE setup - one API call for entire test suite
    await clearPhasesCache();
    await phaseRepository.deleteAll();
    await syncPhases(); // ONLY API call in entire test suite - tests: FPL API → DB → Redis
  });

  describe('External Data Integration', () => {
    test('should fetch and sync phases from FPL API', async () => {
      const phases = await getPhases();
      expect(phases.length).toBeGreaterThan(0); // FPL has multiple phases
      expect(phases[0]).toHaveProperty('id');
      expect(phases[0]).toHaveProperty('name');
      expect(phases[0]).toHaveProperty('startEvent');
      expect(phases[0]).toHaveProperty('stopEvent');
    });

    test('should save phases to database', async () => {
      const dbPhases = await phaseRepository.findAll();
      expect(dbPhases.length).toBeGreaterThan(0);
      expect(dbPhases[0].id).toBeTypeOf('number');
      expect(dbPhases[0].name).toBeTypeOf('string');
      expect(dbPhases[0].startEvent).toBeTypeOf('number');
    });
  });

  describe('Service Layer Integration', () => {
    test('should retrieve phase by ID', async () => {
      const phase = await getPhase(1);
      expect(phase).toBeDefined();
      expect(phase?.id).toBe(1);
      expect(phase?.name).toBeTypeOf('string');
    });

    test('should get all phases from cache', async () => {
      const phases = await getPhases(); // Should hit cache
      expect(phases.length).toBeGreaterThan(0);
      expect(phases[0]).toHaveProperty('startEvent');
      expect(phases[0]).toHaveProperty('stopEvent');
    });
  });

  describe('Cache Integration', () => {
    test('should use cache for fast retrieval', async () => {
      const phases = await getPhases(); // Should hit cache
      expect(phases.length).toBeGreaterThan(0);
    });

    test('should handle database fallback', async () => {
      await clearPhasesCache(); // Clear once to test fallback
      const phases = await getPhases(); // Should fallback to database
      expect(phases.length).toBeGreaterThan(0);
    });
  });

  describe('Data Consistency', () => {
    test('should maintain consistent data across layers', async () => {
      const servicePhases = await getPhases();
      const dbPhases = await phaseRepository.findAll();

      expect(servicePhases.length).toBe(dbPhases.length);
      expect(servicePhases[0].id).toBe(dbPhases[0].id);
      expect(servicePhases[0].name).toBe(dbPhases[0].name);
    });
  });

  describe('Phase Business Logic', () => {
    test('should have valid phase structure', async () => {
      const phases = await getPhases();
      expect(phases.length).toBeGreaterThan(0);

      for (const phase of phases) {
        expect(phase.id).toBeTypeOf('number');
        expect(phase.name).toBeTypeOf('string');
        expect(phase.startEvent).toBeTypeOf('number');
        expect(phase.stopEvent).toBeTypeOf('number');
        expect(phase.startEvent).toBeGreaterThan(0);
        expect(phase.stopEvent).toBeGreaterThanOrEqual(phase.startEvent);
      }
    });

    test('should handle phase queries correctly', async () => {
      const phases = await getPhases();
      const firstPhase = phases[0];

      expect(firstPhase).toBeDefined();
      expect(firstPhase.startEvent).toBeLessThanOrEqual(firstPhase.stopEvent);
    });
  });
});
