import * as E from 'fp-ts/Either';
import { createBootstrapApiAdapter } from '../../src/domain/bootstrap/adapter';
import type { FPLEndpoints } from '../../src/infrastructure/http/fpl/types';
import type { EventResponse } from '../../src/types/event.type';
import bootstrapData from '../data/bootstrap.json';

describe('Event Domain Tests', () => {
  let mockClient: FPLEndpoints;
  let bootstrapAdapter: ReturnType<typeof createBootstrapApiAdapter>;

  beforeEach(() => {
    // Mock FPL client with real bootstrap data
    mockClient = {
      bootstrap: {
        getBootstrapStatic: jest.fn().mockResolvedValue(E.right(bootstrapData)),
      },
      element: {
        getElementSummary: jest.fn(),
      },
      entry: {
        getEntry: jest.fn(),
        getEntryTransfers: jest.fn(),
        getEntryHistory: jest.fn(),
      },
      event: {
        getLive: jest.fn(),
        getPicks: jest.fn(),
        getFixtures: jest.fn(),
      },
      leagues: {
        getClassicLeague: jest.fn(),
        getH2hLeague: jest.fn(),
        getCup: jest.fn(),
      },
    };

    bootstrapAdapter = createBootstrapApiAdapter(mockClient);
  });

  describe('Event Domain Operations', () => {
    it('should transform API response to domain model', async () => {
      const eventsEither = await bootstrapAdapter.getBootstrapEvents()();
      expect(E.isRight(eventsEither)).toBe(true);
      if (E.isLeft(eventsEither)) return;

      const events = eventsEither.right;
      expect(events.length).toBeGreaterThan(0);
      const event = events[0];
      expect(event).toMatchObject({
        id: expect.any(Number),
        name: expect.any(String),
        deadline_time: expect.any(String),
        finished: expect.any(Boolean),
        data_checked: expect.any(Boolean),
      });
    });

    it('should validate event state transitions', async () => {
      const eventsEither = await bootstrapAdapter.getBootstrapEvents()();
      expect(E.isRight(eventsEither)).toBe(true);
      if (E.isLeft(eventsEither)) return;

      const events = eventsEither.right;

      // Find previous, current, and next events
      const previousEvent = events.find((e: EventResponse) => e.is_previous);
      const currentEvent = events.find((e: EventResponse) => e.is_current);
      const nextEvent = events.find((e: EventResponse) => e.is_next);

      // Verify only one event in each state
      expect(events.filter((e: EventResponse) => e.is_previous)).toHaveLength(1);
      expect(events.filter((e: EventResponse) => e.is_current)).toHaveLength(1);
      expect(events.filter((e: EventResponse) => e.is_next)).toHaveLength(1);

      // Verify state exclusivity
      expect(previousEvent?.is_current || previousEvent?.is_next).toBe(false);
      expect(currentEvent?.is_previous || currentEvent?.is_next).toBe(false);
      expect(nextEvent?.is_previous || nextEvent?.is_current).toBe(false);
    });

    it('should enforce business logic constraints', async () => {
      const eventsEither = await bootstrapAdapter.getBootstrapEvents()();
      expect(E.isRight(eventsEither)).toBe(true);
      if (E.isLeft(eventsEither)) return;

      const events = eventsEither.right;

      events.forEach((event: EventResponse) => {
        // Finished events should be in the past
        if (event.finished) {
          expect(event.deadline_time_epoch).toBeLessThan(Date.now() / 1000);
        }

        // Future events should not be finished or data_checked
        if (event.deadline_time_epoch > Date.now() / 1000) {
          expect(event.finished).toBe(false);
          expect(event.data_checked).toBe(false);
        }
      });
    });

    it('should handle optional fields correctly', async () => {
      const eventsEither = await bootstrapAdapter.getBootstrapEvents()();
      expect(E.isRight(eventsEither)).toBe(true);
      if (E.isLeft(eventsEither)) return;

      const events = eventsEither.right;

      events.forEach((event: EventResponse) => {
        // Required fields should always be present
        expect(event.id).toBeDefined();
        expect(event.name).toBeDefined();
        expect(event.deadline_time).toBeDefined();

        // Optional fields should be handled gracefully
        expect(() => event.top_element_info).not.toThrow();
        expect(() => event.chip_plays).not.toThrow();
        expect(Array.isArray(event.chip_plays)).toBe(true);
      });
    });
  });

  describe('Event Aggregates', () => {
    it('should validate event relationships', async () => {
      const eventsEither = await bootstrapAdapter.getBootstrapEvents()();
      expect(E.isRight(eventsEither)).toBe(true);
      if (E.isLeft(eventsEither)) return;

      const events = eventsEither.right;

      // Verify we have the expected number of events
      expect(events.length).toBe(38);

      // Verify sequential IDs
      events.forEach((event: EventResponse, index: number) => {
        expect(event.id).toBe(index + 1);
      });

      // Verify gameweek naming convention
      events.forEach((event: EventResponse, index: number) => {
        expect(event.name).toBe(`Gameweek ${index + 1}`);
      });

      // Verify chronological order of deadlines
      for (let i = 1; i < events.length; i++) {
        expect(events[i].deadline_time_epoch).toBeGreaterThan(events[i - 1].deadline_time_epoch);
      }
    });
  });
});
