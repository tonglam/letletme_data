import { readFileSync } from 'fs';
import { join } from 'path';
import { createEventRepository } from '../../src/domain/event/repository';
import { prisma } from '../../src/infrastructure/db/prisma';
import {
  Event,
  EventResponse,
  PrismaEvent,
  PrismaEventCreate,
  toDomainEvent,
  toPrismaEvent,
} from '../../src/types/event.type';

// Load test data directly from JSON
const loadTestEvents = (): EventResponse[] => {
  const filePath = join(__dirname, '../data/bootstrap.json');
  const fileContent = readFileSync(filePath, 'utf-8');
  const data = JSON.parse(fileContent);
  return data.events;
};

describe('Event Repository', () => {
  const eventRepository = createEventRepository(prisma);
  let testEvents: Event[];
  let testPrismaEvents: PrismaEventCreate[];
  const createdEventIds: number[] = [];

  beforeAll(() => {
    // Convert test data to domain models
    const events = loadTestEvents().slice(0, 3);
    testEvents = events.map((event) => toDomainEvent(event));

    // Convert domain models to Prisma models
    testPrismaEvents = testEvents.map((event) => toPrismaEvent(event));
  });

  beforeEach(async () => {
    // Clean up any existing test data
    await prisma.event.deleteMany();
  });

  afterAll(async () => {
    // Clean up test data
    if (createdEventIds.length > 0) {
      await prisma.event.deleteMany({
        where: {
          id: {
            in: createdEventIds,
          },
        },
      });
    }
    await prisma.$disconnect();
  });

  describe('save', () => {
    it('should save an event', async () => {
      const event = testPrismaEvents[0];
      const result = await eventRepository.save(event)();

      expect(result._tag).toBe('Right');
      if (result._tag === 'Right') {
        const savedEvent = result.right as PrismaEvent;
        expect(savedEvent.id).toBe(event.id);
        expect(savedEvent.name).toBe(event.name);
        expect(savedEvent.deadlineTime).toBe(event.deadlineTime);
        expect(savedEvent.deadlineTimeEpoch).toBe(event.deadlineTimeEpoch);
        createdEventIds.push(event.id);
      }
    });

    it('should handle duplicate event save', async () => {
      const event = testPrismaEvents[0];
      await eventRepository.save(event)();
      const result = await eventRepository.save(event)();

      expect(result._tag).toBe('Left');
      if (result._tag === 'Left') {
        expect(result.left.code).toBe('QUERY_ERROR');
      }
    });
  });

  describe('saveBatch', () => {
    it('should save multiple events', async () => {
      const result = await eventRepository.saveBatch(testPrismaEvents)();

      expect(result._tag).toBe('Right');
      if (result._tag === 'Right') {
        const savedEvents = result.right as PrismaEvent[];
        expect(savedEvents).toHaveLength(testPrismaEvents.length);
        savedEvents.forEach((event, index) => {
          expect(event.id).toBe(testPrismaEvents[index].id);
          expect(event.name).toBe(testPrismaEvents[index].name);
          createdEventIds.push(event.id);
        });
      }
    });
  });

  describe('findById', () => {
    it('should find event by id', async () => {
      const event = testPrismaEvents[0];
      await eventRepository.save(event)();
      const result = await eventRepository.findById(testEvents[0].id)();

      expect(result._tag).toBe('Right');
      if (result._tag === 'Right') {
        const foundEvent = result.right as PrismaEvent | null;
        expect(foundEvent?.id).toBe(event.id);
        expect(foundEvent?.name).toBe(event.name);
      }
    });

    it('should return null for non-existent event', async () => {
      const nonExistentId = testEvents[0].id;
      const result = await eventRepository.findById(nonExistentId)();

      expect(result._tag).toBe('Right');
      if (result._tag === 'Right') {
        expect(result.right).toBeNull();
      }
    });
  });

  describe('findAll', () => {
    it('should find all events', async () => {
      await eventRepository.saveBatch(testPrismaEvents)();
      const result = await eventRepository.findAll()();

      expect(result._tag).toBe('Right');
      if (result._tag === 'Right') {
        const foundEvents = result.right as PrismaEvent[];
        expect(foundEvents).toHaveLength(testPrismaEvents.length);
        foundEvents.forEach((event, index) => {
          expect(event.id).toBe(testPrismaEvents[index].id);
          expect(event.name).toBe(testPrismaEvents[index].name);
        });
      }
    });

    it('should return empty array when no events exist', async () => {
      const result = await eventRepository.findAll()();

      expect(result._tag).toBe('Right');
      if (result._tag === 'Right') {
        expect(result.right).toHaveLength(0);
      }
    });
  });

  describe('findCurrent', () => {
    it('should find current event', async () => {
      const currentEvent = {
        ...testPrismaEvents[0],
        isCurrent: true,
        isNext: false,
      };
      await eventRepository.save(currentEvent)();
      const result = await eventRepository.findCurrent()();

      expect(result._tag).toBe('Right');
      if (result._tag === 'Right') {
        const foundEvent = result.right as PrismaEvent | null;
        expect(foundEvent?.isCurrent).toBe(true);
      }
    });
  });

  describe('findNext', () => {
    it('should find next event', async () => {
      const nextEvent = {
        ...testPrismaEvents[1],
        isCurrent: false,
        isNext: true,
      };
      await eventRepository.save(nextEvent)();
      const result = await eventRepository.findNext()();

      expect(result._tag).toBe('Right');
      if (result._tag === 'Right') {
        const foundEvent = result.right as PrismaEvent | null;
        expect(foundEvent?.isNext).toBe(true);
      }
    });
  });

  describe('update', () => {
    it('should update event', async () => {
      const event = testPrismaEvents[0];
      await eventRepository.save(event)();

      const updateData = {
        name: 'Updated Event',
        finished: !event.finished,
      };

      const result = await eventRepository.update(testEvents[0].id, updateData)();

      expect(result._tag).toBe('Right');
      if (result._tag === 'Right') {
        const updatedEvent = result.right as PrismaEvent;
        expect(updatedEvent.name).toBe(updateData.name);
        expect(updatedEvent.finished).toBe(updateData.finished);
      }
    });
  });

  describe('deleteAll', () => {
    it('should delete all events', async () => {
      await eventRepository.saveBatch(testPrismaEvents)();
      const result = await eventRepository.deleteAll()();

      expect(result._tag).toBe('Right');
      const findResult = await eventRepository.findAll()();
      expect(findResult._tag).toBe('Right');
      if (findResult._tag === 'Right') {
        expect(findResult.right).toHaveLength(0);
      }
    });
  });
});
