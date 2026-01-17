import { beforeAll, describe, expect, test } from 'bun:test';

import { eventRepository } from '../../src/repositories/events';
import {
  clearEventsCache,
  getCurrentEvent,
  getNextEvent,
  syncEvents,
} from '../../src/services/events.service';

describe('Events Integration Tests', () => {
  beforeAll(async () => {
    // SINGLE setup - one API call for entire test suite
    await clearEventsCache();
    // Don't delete events - they may have foreign key references from other tables
    // syncEvents uses upsert which will update existing records
    await syncEvents(); // ONLY API call in entire test suite - tests: FPL API → DB → Redis
  });

  describe('External Data Integration', () => {
    test('should save current event to database', async () => {
      const currentEvent = await eventRepository.findCurrent();
      expect(currentEvent).toBeDefined();
      expect(currentEvent?.isCurrent).toBe(true);
    });

    test('should save next event to database', async () => {
      const nextEvent = await eventRepository.findNext();
      expect(nextEvent).toBeDefined();
      expect(nextEvent?.isNext).toBe(true);
    });
  });

  describe('Service Layer Integration', () => {
    test('should get current event', async () => {
      const currentEvent = await getCurrentEvent();
      expect(currentEvent).toBeDefined();
      expect(currentEvent?.isCurrent).toBe(true);
    });

    test('should get next event', async () => {
      const nextEvent = await getNextEvent();
      expect(nextEvent).toBeDefined();
      expect(nextEvent?.isNext).toBe(true);
    });
  });
});
