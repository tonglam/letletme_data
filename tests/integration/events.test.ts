import { beforeAll, describe, expect, test } from 'bun:test';

import { eventRepository } from '../../src/repositories/events';
import {
  clearEventsCache,
  getCurrentEvent,
  getEvent,
  getEvents,
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
    test('should fetch and sync events from FPL API', async () => {
      const events = await getEvents();
      expect(events.length).toBeGreaterThan(0); // FPL has 38 gameweeks
      expect(events[0]).toHaveProperty('id');
      expect(events[0]).toHaveProperty('name');
      expect(events[0]).toHaveProperty('deadlineTime');
    });

    test('should save events to database', async () => {
      const dbEvents = await eventRepository.findAll();
      expect(dbEvents.length).toBeGreaterThan(0);
      expect(dbEvents[0].id).toBeTypeOf('number');
      expect(dbEvents[0].name).toBeTypeOf('string');
    });
  });

  describe('Service Layer Integration', () => {
    test('should retrieve event by ID', async () => {
      const event = await getEvent(1);
      expect(event).toBeDefined();
      expect(event?.id).toBe(1);
    });

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

    test('should get all events from cache', async () => {
      const events = await getEvents(); // Should hit cache
      expect(events.length).toBeGreaterThan(0);
    });
  });

  describe('Cache Integration', () => {
    test('should use cache for fast retrieval', async () => {
      const events = await getEvents(); // Should hit cache
      expect(events.length).toBeGreaterThan(0);
    });

    test('should handle database fallback', async () => {
      await clearEventsCache(); // Clear once to test fallback
      const events = await getEvents(); // Should fallback to database
      expect(events.length).toBeGreaterThan(0);
    });
  });

  describe('Data Consistency', () => {
    test('should maintain consistent data across layers', async () => {
      const serviceEvents = await getEvents();
      const dbEvents = await eventRepository.findAll();

      expect(serviceEvents.length).toBe(dbEvents.length);
      expect(serviceEvents[0].id).toBe(dbEvents[0].id);
    });
  });
});
