import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();
import { beforeAll, describe, expect, test } from 'bun:test';

import { eventRepository } from '../../src/repositories/events';
import { getCurrentEvent, getNextEvent, syncEvents } from '../../src/services/events.service';

describe('Events Integration Tests', () => {
  beforeAll(async () => {
    // Sync events once for all tests
    await syncEvents();
  });

  describe('External Data Integration', () => {
    test('should preserve the current or preseason next event marker', async () => {
      const currentEvent = await eventRepository.findCurrent();
      if (currentEvent) {
        expect(currentEvent.isCurrent).toBe(true);
        return;
      }

      const nextEvent = await eventRepository.findNext();
      expect(nextEvent).toBeDefined();
      expect(nextEvent?.isNext).toBe(true);
      expect(nextEvent?.finished).toBe(false);
    });

    test('should save next event to database when FPL marks one', async () => {
      // End of season: bootstrap may have is_current=GW38 finished and no is_next.
      const nextEvent = await eventRepository.findNext();
      if (!nextEvent) {
        const current = await eventRepository.findCurrent();
        expect(current?.finished).toBe(true);
        return;
      }
      expect(nextEvent.isNext).toBe(true);
    });

    test('should have valid event structure', async () => {
      const event = (await eventRepository.findCurrent()) ?? (await eventRepository.findNext());
      expect(event).toBeDefined();
      expect(typeof event?.id).toBe('number');
      expect(typeof event?.name).toBe('string');
      expect(typeof event?.finished).toBe('boolean');
    });
  });

  describe('Service Layer Integration', () => {
    test('should get the current event when FPL marks one', async () => {
      const currentEvent = await getCurrentEvent();
      if (currentEvent) {
        expect(currentEvent.isCurrent).toBe(true);
        return;
      }

      const nextEvent = await getNextEvent();
      expect(nextEvent?.isNext).toBe(true);
    });

    test('should get next event when FPL marks one', async () => {
      const nextEvent = await getNextEvent();
      if (!nextEvent) {
        const current = await getCurrentEvent();
        expect(current?.finished).toBe(true);
        return;
      }
      expect(nextEvent.isNext).toBe(true);
    });

    test('should sync events successfully', async () => {
      const result = await syncEvents();
      expect(result.count).toBeGreaterThan(0);
      expect(result.errors).toBeGreaterThanOrEqual(0);
    });
  });
});
