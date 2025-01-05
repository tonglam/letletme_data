import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { eventRepository } from '../../src/domain/event/repository';
import { prisma } from '../../src/infrastructure/db/prisma';
import type { Event, EventId } from '../../src/types/events.type';
import { validateEventId } from '../../src/types/events.type';
import bootstrapData from '../data/bootstrap.json';

describe('Event Repository Tests', () => {
  let testEvents: Event[];
  let createdEventIds: number[] = [];

  beforeAll(() => {
    // Use real event data from bootstrap.json and convert to domain model
    testEvents = bootstrapData.events.slice(0, 3).map((event, index) => {
      const eventIdResult = validateEventId(event.id);
      if (E.isLeft(eventIdResult)) {
        throw new Error(`Invalid event ID: ${event.id}`);
      }

      return {
        id: eventIdResult.right,
        name: event.name,
        deadlineTime: event.deadline_time,
        deadlineTimeEpoch: event.deadline_time_epoch,
        deadlineTimeGameOffset: event.deadline_time_game_offset ?? 0,
        releaseTime: event.release_time,
        averageEntryScore: event.average_entry_score ?? 0,
        finished: event.finished,
        dataChecked: event.data_checked ?? false,
        highestScore: event.highest_score ?? 0,
        highestScoringEntry: event.highest_scoring_entry ?? 0,
        isPrevious: index === 0,
        isCurrent: index === 1,
        isNext: index === 2,
        cupLeaguesCreated: event.cup_leagues_created ?? false,
        h2hKoMatchesCreated: event.h2h_ko_matches_created ?? false,
        rankedCount: event.ranked_count ?? 0,
        chipPlays: event.chip_plays ?? [],
        mostSelected: event.most_selected ?? null,
        mostTransferredIn: event.most_transferred_in ?? null,
        mostCaptained: event.most_captained ?? null,
        mostViceCaptained: event.most_vice_captained ?? null,
        topElement: event.top_element ?? null,
        topElementInfo: event.top_element_info ?? null,
        transfersMade: event.transfers_made ?? 0,
      };
    });
  });

  beforeEach(async () => {
    // Clean up any existing test data
    await prisma.event.deleteMany({
      where: {
        id: {
          in: [...testEvents.map((e) => Number(e.id)), ...createdEventIds],
        },
      },
    });
    createdEventIds = [];
  });

  afterAll(async () => {
    // Final cleanup
    await prisma.event.deleteMany();
  });

  describe('Event Repository Operations', () => {
    it('should create a single event', async () => {
      const testEvent = testEvents[0];
      const result = await pipe(eventRepository.create(testEvent))();

      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        const createdEvent = result.right;
        createdEventIds.push(createdEvent.id);

        expect(createdEvent).toMatchObject({
          id: testEvent.id,
          name: testEvent.name,
          deadlineTime: testEvent.deadlineTime,
          deadlineTimeEpoch: testEvent.deadlineTimeEpoch,
          deadlineTimeGameOffset: testEvent.deadlineTimeGameOffset,
          releaseTime: testEvent.releaseTime,
          averageEntryScore: testEvent.averageEntryScore,
          finished: testEvent.finished,
          dataChecked: testEvent.dataChecked,
          highestScore: testEvent.highestScore,
          highestScoringEntry: testEvent.highestScoringEntry,
          isPrevious: testEvent.isPrevious,
          isCurrent: testEvent.isCurrent,
          isNext: testEvent.isNext,
          cupLeaguesCreated: testEvent.cupLeaguesCreated,
          h2hKoMatchesCreated: testEvent.h2hKoMatchesCreated,
          rankedCount: testEvent.rankedCount,
          chipPlays: testEvent.chipPlays,
          mostSelected: testEvent.mostSelected,
          mostTransferredIn: testEvent.mostTransferredIn,
          mostCaptained: testEvent.mostCaptained,
          mostViceCaptained: testEvent.mostViceCaptained,
          topElement: testEvent.topElement,
          topElementInfo: testEvent.topElementInfo,
          transfersMade: testEvent.transfersMade,
        });

        // Verify JSON fields
        expect(JSON.parse(JSON.stringify(createdEvent.chipPlays))).toEqual(testEvent.chipPlays);
        expect(JSON.parse(JSON.stringify(createdEvent.topElementInfo))).toEqual(
          testEvent.topElementInfo,
        );
      }
    });

    it('should create multiple events', async () => {
      const result = await pipe(eventRepository.createMany(testEvents))();

      expect(E.isRight(result)).toBe(true);
      if (E.isRight(result)) {
        const createdEvents = result.right;
        createdEventIds.push(...createdEvents.map((e) => e.id));

        expect(createdEvents).toHaveLength(testEvents.length);
        createdEvents.forEach((event, index) => {
          const testEvent = testEvents[index];
          expect(event).toMatchObject({
            id: testEvent.id,
            name: testEvent.name,
            deadlineTime: testEvent.deadlineTime,
            deadlineTimeEpoch: testEvent.deadlineTimeEpoch,
            deadlineTimeGameOffset: testEvent.deadlineTimeGameOffset,
            releaseTime: testEvent.releaseTime,
            averageEntryScore: testEvent.averageEntryScore,
            finished: testEvent.finished,
            dataChecked: testEvent.dataChecked,
            highestScore: testEvent.highestScore,
            highestScoringEntry: testEvent.highestScoringEntry,
            isPrevious: testEvent.isPrevious,
            isCurrent: testEvent.isCurrent,
            isNext: testEvent.isNext,
            cupLeaguesCreated: testEvent.cupLeaguesCreated,
            h2hKoMatchesCreated: testEvent.h2hKoMatchesCreated,
            rankedCount: testEvent.rankedCount,
            transfersMade: testEvent.transfersMade,
          });

          // Verify JSON fields
          expect(JSON.parse(JSON.stringify(event.chipPlays))).toEqual(testEvent.chipPlays);
          expect(JSON.parse(JSON.stringify(event.topElementInfo))).toEqual(
            testEvent.topElementInfo,
          );
        });
      }
    });

    it('should find event by ID', async () => {
      // First create an event
      const testEvent = testEvents[0];
      const createResult = await pipe(eventRepository.create(testEvent))();
      expect(E.isRight(createResult)).toBe(true);
      if (E.isRight(createResult)) {
        createdEventIds.push(createResult.right.id);

        // Then find it by ID
        const findResult = await pipe(eventRepository.findById(testEvent.id))();
        expect(E.isRight(findResult)).toBe(true);
        if (E.isRight(findResult)) {
          const foundEvent = findResult.right;
          expect(foundEvent).not.toBeNull();
          if (foundEvent) {
            expect(foundEvent).toMatchObject({
              id: testEvent.id,
              name: testEvent.name,
              deadlineTime: testEvent.deadlineTime,
              deadlineTimeEpoch: testEvent.deadlineTimeEpoch,
              deadlineTimeGameOffset: testEvent.deadlineTimeGameOffset,
              releaseTime: testEvent.releaseTime,
              averageEntryScore: testEvent.averageEntryScore,
              finished: testEvent.finished,
              dataChecked: testEvent.dataChecked,
            });

            // Verify JSON fields
            expect(JSON.parse(JSON.stringify(foundEvent.chipPlays))).toEqual(testEvent.chipPlays);
            expect(JSON.parse(JSON.stringify(foundEvent.topElementInfo))).toEqual(
              testEvent.topElementInfo,
            );
          }
        }
      }
    });

    it('should find events by IDs', async () => {
      // First create multiple events
      const createResult = await pipe(eventRepository.createMany(testEvents))();
      expect(E.isRight(createResult)).toBe(true);
      if (E.isRight(createResult)) {
        const createdEvents = createResult.right;
        createdEventIds.push(...createdEvents.map((e) => e.id));

        // Then find them by IDs
        const findResult = await pipe(eventRepository.findByIds(testEvents.map((e) => e.id)))();
        expect(E.isRight(findResult)).toBe(true);
        if (E.isRight(findResult)) {
          const foundEvents = findResult.right;
          expect(foundEvents).toHaveLength(testEvents.length);
          foundEvents.forEach((event, index) => {
            const testEvent = testEvents[index];
            expect(event).toMatchObject({
              id: testEvent.id,
              name: testEvent.name,
              deadlineTime: testEvent.deadlineTime,
              deadlineTimeEpoch: testEvent.deadlineTimeEpoch,
              deadlineTimeGameOffset: testEvent.deadlineTimeGameOffset,
              releaseTime: testEvent.releaseTime,
              averageEntryScore: testEvent.averageEntryScore,
              finished: testEvent.finished,
              dataChecked: testEvent.dataChecked,
            });

            // Verify JSON fields
            expect(JSON.parse(JSON.stringify(event.chipPlays))).toEqual(testEvent.chipPlays);
            expect(JSON.parse(JSON.stringify(event.topElementInfo))).toEqual(
              testEvent.topElementInfo,
            );
          });
        }
      }
    });

    it('should find current event', async () => {
      // First create multiple events
      const createResult = await pipe(eventRepository.createMany(testEvents))();
      expect(E.isRight(createResult)).toBe(true);
      if (E.isRight(createResult)) {
        createdEventIds.push(...createResult.right.map((e) => e.id));

        // Then find current event
        const findResult = await pipe(eventRepository.findCurrent())();
        expect(E.isRight(findResult)).toBe(true);
        if (E.isRight(findResult)) {
          const foundEvent = findResult.right;
          expect(foundEvent).toMatchObject({
            isCurrent: true,
          });
        }
      }
    });

    it('should find next event', async () => {
      // First create multiple events
      const createResult = await pipe(eventRepository.createMany(testEvents))();
      expect(E.isRight(createResult)).toBe(true);
      if (E.isRight(createResult)) {
        createdEventIds.push(...createResult.right.map((e) => e.id));

        // Then find next event
        const findResult = await pipe(eventRepository.findNext())();
        expect(E.isRight(findResult)).toBe(true);
        if (E.isRight(findResult)) {
          const foundEvent = findResult.right;
          expect(foundEvent).toMatchObject({
            isNext: true,
          });
        }
      }
    });

    it('should update event', async () => {
      // First create an event
      const testEvent = testEvents[0];
      const createResult = await pipe(eventRepository.create(testEvent))();
      expect(E.isRight(createResult)).toBe(true);
      if (E.isRight(createResult)) {
        createdEventIds.push(createResult.right.id);

        // Then update it with data from another event
        const updateData = {
          finished: !testEvent.finished,
          dataChecked: !testEvent.dataChecked,
          averageEntryScore: testEvents[1].averageEntryScore,
          highestScore: testEvents[1].highestScore,
          highestScoringEntry: testEvents[1].highestScoringEntry,
          chipPlays: testEvents[1].chipPlays,
          topElementInfo: testEvents[1].topElementInfo,
        };

        const updateResult = await pipe(eventRepository.update(testEvent.id, updateData))();
        expect(E.isRight(updateResult)).toBe(true);
        if (E.isRight(updateResult)) {
          const updatedEvent = updateResult.right;
          expect(updatedEvent).toMatchObject({
            id: testEvent.id,
            finished: updateData.finished,
            dataChecked: updateData.dataChecked,
            averageEntryScore: updateData.averageEntryScore,
            highestScore: updateData.highestScore,
            highestScoringEntry: updateData.highestScoringEntry,
          });

          // Verify JSON fields
          expect(JSON.parse(JSON.stringify(updatedEvent.chipPlays))).toEqual(updateData.chipPlays);
          expect(JSON.parse(JSON.stringify(updatedEvent.topElementInfo))).toEqual(
            updateData.topElementInfo,
          );
        }
      }
    });

    it('should delete event', async () => {
      // First create an event
      const testEvent = testEvents[0];
      const createResult = await pipe(eventRepository.create(testEvent))();
      expect(E.isRight(createResult)).toBe(true);
      if (E.isRight(createResult)) {
        const createdEvent = createResult.right;

        // Then delete it
        const deleteResult = await pipe(eventRepository.delete(testEvent.id))();
        expect(E.isRight(deleteResult)).toBe(true);
        if (E.isRight(deleteResult)) {
          const deletedEvent = deleteResult.right;
          expect(deletedEvent.id).toBe(createdEvent.id);

          // Verify it's deleted
          const findResult = await pipe(eventRepository.findById(testEvent.id))();
          expect(E.isRight(findResult)).toBe(true);
          if (E.isRight(findResult)) {
            expect(findResult.right).toBeNull();
          }
        }
      }
    });

    it('should find all events', async () => {
      // First create multiple events
      const createResult = await pipe(eventRepository.createMany(testEvents))();
      expect(E.isRight(createResult)).toBe(true);
      if (E.isRight(createResult)) {
        createdEventIds.push(...createResult.right.map((e) => e.id));

        // Then find all events
        const findResult = await pipe(eventRepository.findAll())();
        expect(E.isRight(findResult)).toBe(true);
        if (E.isRight(findResult)) {
          const foundEvents = findResult.right;
          expect(foundEvents.length).toBeGreaterThanOrEqual(testEvents.length);

          // Verify the test events are included in the results
          const testEventIds = testEvents.map((e) => e.id);
          const foundTestEvents = foundEvents.filter((e) => testEventIds.includes(e.id as EventId));
          expect(foundTestEvents).toHaveLength(testEvents.length);

          foundTestEvents.forEach((event) => {
            const testEvent = testEvents.find((e) => e.id === event.id);
            expect(testEvent).toBeDefined();
            if (testEvent) {
              expect(event).toMatchObject({
                id: testEvent.id,
                name: testEvent.name,
                deadlineTime: testEvent.deadlineTime,
                deadlineTimeEpoch: testEvent.deadlineTimeEpoch,
                deadlineTimeGameOffset: testEvent.deadlineTimeGameOffset,
                releaseTime: testEvent.releaseTime,
                averageEntryScore: testEvent.averageEntryScore,
                finished: testEvent.finished,
                dataChecked: testEvent.dataChecked,
                highestScore: testEvent.highestScore,
                highestScoringEntry: testEvent.highestScoringEntry,
                isPrevious: testEvent.isPrevious,
                isCurrent: testEvent.isCurrent,
                isNext: testEvent.isNext,
              });

              // Verify JSON fields
              expect(JSON.parse(JSON.stringify(event.chipPlays))).toEqual(testEvent.chipPlays);
              expect(JSON.parse(JSON.stringify(event.topElementInfo))).toEqual(
                testEvent.topElementInfo,
              );
            }
          });
        }
      }
    });
  });
});
