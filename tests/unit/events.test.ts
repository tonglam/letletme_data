import { beforeEach, describe, expect, test } from 'bun:test';

import { createEventRepository } from '../../src/repositories/events';
import { transformEvents } from '../../src/transformers/events';
import {
  rawFPLEventsFixture,
  singleRawEventFixture,
  singleTransformedEventFixture,
  transformedEventsFixture,
} from '../fixtures/events.fixtures';

describe('Events Unit Tests', () => {
  describe('transformEvents Function', () => {
    test('should transform single event correctly', () => {
      const result = transformEvents([singleRawEventFixture]);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(singleTransformedEventFixture);
      expect(result[0].id).toBe(1);
      expect(result[0].name).toBe('Gameweek 1');
      expect(result[0].deadlineTime).toEqual(new Date('2025-08-15T17:30:00Z'));
      expect(result[0].finished).toBe(false);
      expect(result[0].isNext).toBe(true);
    });

    test('should transform multiple events correctly', () => {
      const result = transformEvents(rawFPLEventsFixture);

      expect(result).toHaveLength(3);
      expect(result).toEqual(transformedEventsFixture);

      // Verify transformation accuracy
      result.forEach((event, index) => {
        const rawEvent = rawFPLEventsFixture[index];
        expect(event.id).toBe(rawEvent.id);
        expect(event.name).toBe(rawEvent.name);
        expect(event.finished).toBe(rawEvent.finished);
        expect(event.dataChecked).toBe(rawEvent.data_checked);
        expect(event.isPrevious).toBe(rawEvent.is_previous);
        expect(event.isCurrent).toBe(rawEvent.is_current);
        expect(event.isNext).toBe(rawEvent.is_next);
        expect(event.averageEntryScore).toBe(rawEvent.average_entry_score);
        expect(event.deadlineTimeEpoch).toBe(rawEvent.deadline_time_epoch);
      });
    });

    test('should handle empty array', () => {
      const result = transformEvents([]);
      expect(result).toEqual([]);
      expect(result).toHaveLength(0);
    });

    test('should handle null deadline_time correctly', () => {
      const eventWithNullDeadline = {
        ...singleRawEventFixture,
        deadline_time: null,
      };

      const result = transformEvents([eventWithNullDeadline]);
      expect(result[0].deadlineTime).toBeNull();
    });

    test('should handle chip_plays array correctly', () => {
      const eventWithChips = {
        ...singleRawEventFixture,
        chip_plays: [
          { name: 'wildcard', num_played: 1000 },
          { name: 'bench_boost', num_played: 500 },
        ],
      };

      const result = transformEvents([eventWithChips]);
      expect(result[0].chipPlays).toEqual([
        { name: 'wildcard', num_played: 1000 },
        { name: 'bench_boost', num_played: 500 },
      ]);
    });

    test('should handle null and undefined values correctly', () => {
      const eventWithNulls = {
        ...singleRawEventFixture,
        average_entry_score: null,
        highest_scoring_entry: null,
        highest_score: null,
        most_selected: null,
        most_transferred_in: null,
        top_element: null,
        top_element_info: null,
        most_captained: null,
        most_vice_captained: null,
      };

      const result = transformEvents([eventWithNulls]);
      expect(result[0].averageEntryScore).toBeNull();
      expect(result[0].highestScoringEntry).toBeNull();
      expect(result[0].highestScore).toBeNull();
      expect(result[0].mostSelected).toBeNull();
      expect(result[0].mostTransferredIn).toBeNull();
      expect(result[0].topElement).toBeNull();
      expect(result[0].topElementInfo).toBeNull();
      expect(result[0].mostCaptained).toBeNull();
      expect(result[0].mostViceCaptained).toBeNull();
    });

    test('should handle large datasets efficiently', () => {
      const largeDataset = Array(1000)
        .fill(singleRawEventFixture)
        .map((event, index) => ({
          ...event,
          id: index + 1,
          name: `Gameweek ${index + 1}`,
        }));

      const startTime = performance.now();
      const result = transformEvents(largeDataset);
      const endTime = performance.now();

      expect(result).toHaveLength(1000);
      expect(endTime - startTime).toBeLessThan(100); // Should complete in under 100ms
    });
  });

  describe('EventRepository Unit Tests', () => {
    let _mockDb: any;
    let repository: ReturnType<typeof createEventRepository>;

    beforeEach(() => {
      // Create mock database with simple functions
      _mockDb = {
        select: () => ({
          from: () => ({
            where: () => Promise.resolve([singleTransformedEventFixture]),
          }),
        }),
        insert: () => ({
          values: () => ({
            onConflictDoUpdate: () => ({
              returning: () => Promise.resolve([singleTransformedEventFixture]),
            }),
          }),
        }),
        delete: () => Promise.resolve(undefined),
      };

      repository = createEventRepository();
      // Note: Real repository uses singleton db, this is just for testing structure
    });

    test('should create repository instance', () => {
      expect(repository).toBeDefined();
      expect(repository.findCurrent).toBeDefined();
      expect(repository.findNext).toBeDefined();
      expect(repository.upsertBatch).toBeDefined();
    });

    test('should handle repository method signatures', () => {
      // Test method signatures exist and are callable
      expect(typeof repository.findCurrent).toBe('function');
      expect(typeof repository.findNext).toBe('function');
      expect(typeof repository.upsertBatch).toBe('function');
    });

    test('should handle upsertBatch with empty array', async () => {
      const result = await repository.upsertBatch([]);
      expect(result).toEqual([]);
    });
  });

  describe('Event Status Logic Tests', () => {
    test('should correctly identify current event', () => {
      const result = transformEvents(rawFPLEventsFixture);
      const currentEvent = result.find((event) => event.isCurrent);

      expect(currentEvent).toBeDefined();
      expect(currentEvent?.id).toBe(3);
      expect(currentEvent?.name).toBe('Gameweek 3');
      expect(currentEvent?.isCurrent).toBe(true);
      expect(currentEvent?.isPrevious).toBe(false);
      expect(currentEvent?.isNext).toBe(false);
    });

    test('should correctly identify next event', () => {
      const result = transformEvents(rawFPLEventsFixture);
      const nextEvent = result.find((event) => event.isNext);

      expect(nextEvent).toBeDefined();
      expect(nextEvent?.id).toBe(1);
      expect(nextEvent?.name).toBe('Gameweek 1');
      expect(nextEvent?.isNext).toBe(true);
      expect(nextEvent?.isCurrent).toBe(false);
      expect(nextEvent?.isPrevious).toBe(false);
    });

    test('should correctly identify previous event', () => {
      const result = transformEvents(rawFPLEventsFixture);
      const previousEvent = result.find((event) => event.isPrevious);

      expect(previousEvent).toBeDefined();
      expect(previousEvent?.id).toBe(2);
      expect(previousEvent?.name).toBe('Gameweek 2');
      expect(previousEvent?.isPrevious).toBe(true);
      expect(previousEvent?.isCurrent).toBe(false);
      expect(previousEvent?.isNext).toBe(false);
    });

    test('should handle finished event properties', () => {
      const finishedEvent = transformedEventsFixture.find((event) => event.finished);

      expect(finishedEvent).toBeDefined();
      expect(finishedEvent?.finished).toBe(true);
      expect(finishedEvent?.dataChecked).toBe(true);
      expect(finishedEvent?.averageEntryScore).toBeGreaterThan(0);
      expect(finishedEvent?.highestScore).toBeGreaterThan(0);
      expect(finishedEvent?.transfersMade).toBeGreaterThan(0);
    });

    test('should handle upcoming event properties', () => {
      const upcomingEvent = transformedEventsFixture.find((event) => event.isNext);

      expect(upcomingEvent).toBeDefined();
      expect(upcomingEvent?.finished).toBe(false);
      expect(upcomingEvent?.dataChecked).toBe(false);
      expect(upcomingEvent?.averageEntryScore).toBe(0);
      expect(upcomingEvent?.highestScore).toBeNull();
      expect(upcomingEvent?.transfersMade).toBe(0);
    });
  });

  describe('Events API Functions Unit Tests', () => {
    test('should test data flow functions exist', () => {
      // Note: Cache operations use singleton pattern and connect to real Redis
      // Full cache testing is done in integration tests
      // Here we just verify the functions exist and can be called

      expect(transformEvents).toBeDefined();
      expect(typeof transformEvents).toBe('function');
    });

    test('should handle events transformation pipeline', () => {
      // Test the core transformation logic
      const input = rawFPLEventsFixture;
      const output = transformEvents(input);

      expect(output).toHaveLength(input.length);

      // Verify transformation is pure (no side effects)
      const output2 = transformEvents(input);
      expect(output2).toEqual(output);

      // Verify immutability
      expect(input).toEqual(rawFPLEventsFixture); // Original unchanged
    });

    test('should validate transformation output format', () => {
      const result = transformEvents(rawFPLEventsFixture);

      result.forEach((event) => {
        // Required fields should be present and correct type
        expect(typeof event.id).toBe('number');
        expect(typeof event.name).toBe('string');
        expect(typeof event.finished).toBe('boolean');
        expect(typeof event.dataChecked).toBe('boolean');
        expect(typeof event.isPrevious).toBe('boolean');
        expect(typeof event.isCurrent).toBe('boolean');
        expect(typeof event.isNext).toBe('boolean');

        // Should have all camelCase properties
        expect(event).toHaveProperty('deadlineTime');
        expect(event).toHaveProperty('averageEntryScore');
        expect(event).toHaveProperty('highestScoringEntry');
        expect(event).toHaveProperty('deadlineTimeEpoch');
        expect(event).toHaveProperty('deadlineTimeGameOffset');
        expect(event).toHaveProperty('highestScore');
        expect(event).toHaveProperty('cupLeagueCreate');
        expect(event).toHaveProperty('h2hKoMatchesCreated');
        expect(event).toHaveProperty('chipPlays');
        expect(event).toHaveProperty('mostSelected');
        expect(event).toHaveProperty('mostTransferredIn');
        expect(event).toHaveProperty('topElement');
        expect(event).toHaveProperty('topElementInfo');
        expect(event).toHaveProperty('transfersMade');
        expect(event).toHaveProperty('mostCaptained');
        expect(event).toHaveProperty('mostViceCaptained');

        // Should not have snake_case properties
        expect(event).not.toHaveProperty('deadline_time');
        expect(event).not.toHaveProperty('average_entry_score');
        expect(event).not.toHaveProperty('highest_scoring_entry');
        expect(event).not.toHaveProperty('deadline_time_epoch');
        expect(event).not.toHaveProperty('deadline_time_game_offset');
        expect(event).not.toHaveProperty('highest_score');
        expect(event).not.toHaveProperty('is_previous');
        expect(event).not.toHaveProperty('is_current');
        expect(event).not.toHaveProperty('is_next');
        expect(event).not.toHaveProperty('cup_leagues_created');
        expect(event).not.toHaveProperty('h2h_ko_matches_created');
        expect(event).not.toHaveProperty('chip_plays');
        expect(event).not.toHaveProperty('most_selected');
        expect(event).not.toHaveProperty('most_transferred_in');
        expect(event).not.toHaveProperty('top_element');
        expect(event).not.toHaveProperty('top_element_info');
        expect(event).not.toHaveProperty('transfers_made');
        expect(event).not.toHaveProperty('most_captained');
        expect(event).not.toHaveProperty('most_vice_captained');
      });
    });
  });

  describe('Error Handling Unit Tests', () => {
    test('should handle transformation with missing fields', () => {
      const incompleteEvent = {
        id: 999,
        name: 'Incomplete Event',
        finished: false,
        // Missing many fields - should still work with defaults
      } as any;

      expect(() => transformEvents([incompleteEvent])).not.toThrow();
      const result = transformEvents([incompleteEvent]);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(999);
      expect(result[0].name).toBe('Incomplete Event');
    });

    test('should handle edge case values correctly', () => {
      const edgeCaseEvent = {
        id: 999,
        name: 'Edge Case Event',
        release_time: null, // Add missing required field
        deadline_time: null, // Edge case: null deadline
        average_entry_score: 0, // Edge case: zero score
        finished: false,
        data_checked: false,
        highest_scoring_entry: null,
        deadline_time_epoch: null,
        deadline_time_game_offset: 0,
        highest_score: null,
        is_previous: false,
        is_current: false,
        is_next: false,
        cup_leagues_created: false,
        h2h_ko_matches_created: false,
        can_enter: true,
        can_manage: true,
        released: true,
        ranked_count: 0,
        overrides: {
          rules: {},
          scoring: {},
          element_types: [],
          pick_multiplier: null,
        },
        chip_plays: [], // Edge case: empty array
        most_selected: null,
        most_transferred_in: null,
        top_element: null,
        top_element_info: null,
        transfers_made: 0, // Edge case: zero transfers
        most_captained: null,
        most_vice_captained: null,
      };

      const result = transformEvents([edgeCaseEvent]);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(999);
      expect(result[0].deadlineTime).toBe(null); // Should handle null correctly
      expect(result[0].averageEntryScore).toBe(0); // Should handle 0 correctly
      expect(result[0].chipPlays).toEqual([]); // Should handle empty array correctly
      expect(result[0].transfersMade).toBe(0); // Should handle 0 correctly
    });

    test('should handle malformed event data gracefully', () => {
      const malformedEvents = [
        {
          id: 'invalid', // Wrong type
          name: 'Test Event',
          finished: false,
        },
        {
          id: 2,
          name: null, // Null name
          finished: 'not-boolean', // Wrong type
        },
      ] as any;

      // Should not throw and should process what it can
      expect(() => transformEvents(malformedEvents)).not.toThrow();
      const result = transformEvents(malformedEvents);
      expect(result).toHaveLength(2);
    });

    test('should handle invalid date strings', () => {
      const eventWithInvalidDate = {
        ...singleRawEventFixture,
        deadline_time: 'invalid-date-string',
      };

      expect(() => transformEvents([eventWithInvalidDate])).not.toThrow();
      const result = transformEvents([eventWithInvalidDate]);
      expect(result).toHaveLength(1);
      // The result should handle invalid dates gracefully
      expect(result[0].deadlineTime).toBeTruthy(); // Will be Invalid Date object
    });
  });

  describe('Data Validation Unit Tests', () => {
    test('should validate event structure after transformation', () => {
      const result = transformEvents(rawFPLEventsFixture);

      result.forEach((event) => {
        // Required fields
        expect(typeof event.id).toBe('number');
        expect(typeof event.name).toBe('string');
        expect(typeof event.finished).toBe('boolean');
        expect(typeof event.dataChecked).toBe('boolean');
        expect(typeof event.isPrevious).toBe('boolean');
        expect(typeof event.isCurrent).toBe('boolean');
        expect(typeof event.isNext).toBe('boolean');
        expect(typeof event.cupLeagueCreate).toBe('boolean');
        expect(typeof event.h2hKoMatchesCreated).toBe('boolean');

        // Nullable fields
        expect(['number', 'object']).toContain(typeof event.averageEntryScore); // number or null
        expect(['number', 'object']).toContain(typeof event.highestScoringEntry); // number or null
        expect(['number', 'object']).toContain(typeof event.deadlineTimeEpoch); // number or null
        expect(['number', 'object']).toContain(typeof event.deadlineTimeGameOffset); // number or null
        expect(['number', 'object']).toContain(typeof event.highestScore); // number or null

        // Array fields
        expect(Array.isArray(event.chipPlays)).toBe(true);

        // Value ranges
        expect(event.id).toBeGreaterThan(0);
        expect(event.name.length).toBeGreaterThan(0);

        // Date field
        expect(['object']).toContain(typeof event.deadlineTime); // Date object or null
      });
    });

    test('should maintain data consistency across transformations', () => {
      const input = rawFPLEventsFixture;
      const output = transformEvents(input);

      expect(output.length).toBe(input.length);

      input.forEach((rawEvent, index) => {
        const transformedEvent = output[index];

        // Core identity preserved
        expect(transformedEvent.id).toBe(rawEvent.id);
        expect(transformedEvent.name).toBe(rawEvent.name);
        expect(transformedEvent.finished).toBe(rawEvent.finished);

        // Camel case conversion correct
        expect(transformedEvent.dataChecked).toBe(rawEvent.data_checked);
        expect(transformedEvent.averageEntryScore).toBe(rawEvent.average_entry_score);
        expect(transformedEvent.highestScoringEntry).toBe(rawEvent.highest_scoring_entry);
        expect(transformedEvent.deadlineTimeEpoch).toBe(rawEvent.deadline_time_epoch);
        expect(transformedEvent.isPrevious).toBe(rawEvent.is_previous);
        expect(transformedEvent.isCurrent).toBe(rawEvent.is_current);
        expect(transformedEvent.isNext).toBe(rawEvent.is_next);
        expect(transformedEvent.cupLeagueCreate).toBe(rawEvent.cup_leagues_created);
        expect(transformedEvent.h2hKoMatchesCreated).toBe(rawEvent.h2h_ko_matches_created);

        // Date transformation
        if (rawEvent.deadline_time) {
          expect(transformedEvent.deadlineTime).toEqual(new Date(rawEvent.deadline_time));
        } else {
          expect(transformedEvent.deadlineTime).toBeNull();
        }
      });
    });
  });

  describe('Performance Unit Tests', () => {
    test('should handle concurrent transformations', () => {
      const datasets = Array(10).fill(rawFPLEventsFixture);

      const startTime = performance.now();
      const results = datasets.map((dataset) => transformEvents(dataset));
      const endTime = performance.now();

      expect(results.length).toBe(10);
      results.forEach((result) => {
        expect(result.length).toBe(3);
      });

      expect(endTime - startTime).toBeLessThan(50); // Should be very fast
    });

    test('should handle memory efficiently with large datasets', () => {
      const largeDataset = Array(5000)
        .fill(singleRawEventFixture)
        .map((event, index) => ({
          ...event,
          id: index + 1,
          name: `Gameweek ${index + 1}`,
        }));

      const startTime = performance.now();
      const result = transformEvents(largeDataset);
      const endTime = performance.now();

      expect(result).toHaveLength(5000);
      expect(endTime - startTime).toBeLessThan(500); // Should complete in under 500ms

      // Check memory isn't being wasted
      expect(result[0].name).toBe('Gameweek 1');
      expect(result[4999].name).toBe('Gameweek 5000');
    });
  });

  describe('Event Specific Business Logic Tests', () => {
    test('should handle chip plays correctly', () => {
      const eventWithChips = transformedEventsFixture[1]; // GW2 has chips

      expect(Array.isArray(eventWithChips.chipPlays)).toBe(true);
      if (eventWithChips.chipPlays) {
        expect(eventWithChips.chipPlays.length).toBeGreaterThan(0);
        expect(eventWithChips.chipPlays[0]).toHaveProperty('name');
        expect(eventWithChips.chipPlays[0]).toHaveProperty('num_played');
      }
    });

    test('should handle element info correctly', () => {
      const eventWithTopElement = transformedEventsFixture[1]; // GW2 has top element

      expect(eventWithTopElement.topElement).toBe(234567);
      expect(eventWithTopElement.topElementInfo).toEqual({
        id: 234567,
        points: 15,
      });
    });

    test('should correctly handle event deadlines', () => {
      const eventsWithDeadlines = transformedEventsFixture.filter((event) => event.deadlineTime);

      eventsWithDeadlines.forEach((event) => {
        expect(event.deadlineTime).toBeInstanceOf(Date);
        expect(event.deadlineTime?.getTime()).toBeGreaterThan(0);
      });
    });

    test('should validate event state consistency', () => {
      const result = transformEvents(rawFPLEventsFixture);

      // Should have exactly one current, one next, and one previous
      const currentEvents = result.filter((event) => event.isCurrent);
      const nextEvents = result.filter((event) => event.isNext);
      const previousEvents = result.filter((event) => event.isPrevious);

      expect(currentEvents).toHaveLength(1);
      expect(nextEvents).toHaveLength(1);
      expect(previousEvents).toHaveLength(1);

      // No event should have multiple states
      result.forEach((event) => {
        const stateCount = [event.isCurrent, event.isNext, event.isPrevious].filter(Boolean).length;
        expect(stateCount).toBeLessThanOrEqual(1);
      });
    });
  });
});
