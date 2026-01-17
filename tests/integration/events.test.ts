import { beforeAll, describe, expect, test } from 'bun:test';

import { eventRepository } from '../../src/repositories/events';
import { getCurrentEvent, getNextEvent, syncEvents } from '../../src/services/events.service';

describe('Events Integration Tests', () => {
  beforeAll(async () => {
    // Sync events once for all tests
    await syncEvents();
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

    test('should have valid event structure', async () => {
      const currentEvent = await eventRepository.findCurrent();
      expect(currentEvent).toBeDefined();
      expect(typeof currentEvent?.id).toBe('number');
      expect(typeof currentEvent?.name).toBe('string');
      expect(typeof currentEvent?.finished).toBe('boolean');
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

    test('should sync events successfully', async () => {
      const result = await syncEvents();
      expect(result.count).toBeGreaterThan(0);
      expect(result.errors).toBeGreaterThanOrEqual(0);
    });
  });
});
