import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import { eventRepository } from '../../src/domain/event/repository';
import { prisma } from '../../src/infrastructure/db/prisma';
import type { Event, EventId } from '../../src/types/events.type';

describe('Event Repository Tests', () => {
  let testEvents: Event[];
  let createdEventIds: number[] = [];

  beforeAll(() => {
    // Create test events
    testEvents = Array.from({ length: 3 }, (_, i) => ({
      id: (i + 1) as EventId,
      name: `Gameweek ${i + 1}`,
      deadlineTime: new Date(Date.now() + (i + 1) * 24 * 60 * 60 * 1000).toISOString(),
      deadlineTimeEpoch: Math.floor(Date.now() / 1000) + (i + 1) * 24 * 60 * 60,
      deadlineTimeGameOffset: 0,
      releaseTime: null,
      averageEntryScore: 0,
      finished: i === 0,
      dataChecked: i === 0,
      highestScore: 0,
      highestScoringEntry: 0,
      isPrevious: i === 0,
      isCurrent: i === 1,
      isNext: i === 2,
      cupLeaguesCreated: false,
      h2hKoMatchesCreated: false,
      rankedCount: 0,
      chipPlays: [],
      mostSelected: null,
      mostTransferredIn: null,
      mostCaptained: null,
      mostViceCaptained: null,
      topElement: null,
      topElementInfo: null,
      transfersMade: 0,
    }));
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
    await prisma.event.deleteMany({
      where: {
        id: {
          in: [...testEvents.map((e) => Number(e.id)), ...createdEventIds],
        },
      },
    });
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
          deadlineTime: expect.any(String),
          finished: testEvent.finished,
          dataChecked: testEvent.dataChecked,
        });
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
          expect(event).toMatchObject({
            id: testEvents[index].id,
            name: testEvents[index].name,
            deadlineTime: expect.any(String),
            finished: testEvents[index].finished,
            dataChecked: testEvents[index].dataChecked,
          });
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
          expect(foundEvent).toMatchObject({
            id: testEvent.id,
            name: testEvent.name,
          });
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
            expect(event).toMatchObject({
              id: testEvents[index].id,
              name: testEvents[index].name,
              deadlineTime: expect.any(String),
              finished: testEvents[index].finished,
              dataChecked: testEvents[index].dataChecked,
            });
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

        // Then update it
        const updateData = {
          finished: !testEvent.finished,
          dataChecked: !testEvent.dataChecked,
          averageEntryScore: 100,
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
          });
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
  });
});
