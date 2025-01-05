import * as E from 'fp-ts/Either';
import * as T from 'fp-ts/Task';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { createBootstrapApiAdapter } from '../../src/domain/bootstrap/adapter';
import { eventRepository } from '../../src/domain/event/repository';
import { connectRedis, disconnectRedis } from '../../src/infrastructure/cache/client';
import { connectDB, disconnectDB, prisma } from '../../src/infrastructure/db/prisma';
import { createFPLClient } from '../../src/infrastructure/http/fpl/client';
import { createEventService } from '../../src/service/event/service';
import { ServiceError } from '../../src/types/errors.type';
import { Event, validateEventId } from '../../src/types/events.type';

describe('Event Service', () => {
  let eventService: ReturnType<typeof createEventService>;

  beforeAll(async () => {
    // Set up Redis client with test options
    await pipe(
      connectRedis(),
      TE.fold(
        (error) => {
          throw error;
        },
        () => T.of(undefined),
      ),
    )();

    // Set up FPL client and bootstrap adapter
    const fplClient = createFPLClient();
    const bootstrapApi = createBootstrapApiAdapter(fplClient);

    // Create event service instance
    eventService = createEventService(bootstrapApi, eventRepository);

    // Connect to database
    await pipe(
      connectDB(),
      TE.fold(
        (error) => {
          throw error;
        },
        () => T.of(undefined),
      ),
    )();
  });

  afterAll(async () => {
    // Clean up database
    await prisma.event.deleteMany();

    // Disconnect from database
    await pipe(
      disconnectDB(),
      TE.fold(
        (error) => {
          throw error;
        },
        () => T.of(undefined),
      ),
    )();

    // Disconnect from Redis
    await pipe(
      disconnectRedis(),
      TE.fold(
        (error) => {
          throw error;
        },
        () => T.of(undefined),
      ),
    )();
  });

  beforeEach(async () => {
    // Clean up database before each test
    await prisma.event.deleteMany();
  });

  describe('getEvents', () => {
    it('should fetch events from FPL API when cache and DB are empty', async () => {
      const result = await pipe(
        eventService.getEvents(),
        TE.fold(
          (error: ServiceError): T.Task<Event[]> =>
            () =>
              Promise.reject(error),
          (success: readonly Event[]): T.Task<Event[]> =>
            () =>
              Promise.resolve([...success]),
        ),
      )();

      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);

      // Verify event structure
      const firstEvent = result[0];
      expect(firstEvent).toHaveProperty('id');
      expect(firstEvent).toHaveProperty('name');
      expect(firstEvent).toHaveProperty('deadlineTime');
      expect(firstEvent.deadlineTime).toBeInstanceOf(Date);
    });

    it('should return events from database on subsequent calls', async () => {
      // First call to populate database
      const firstResult = await pipe(
        eventService.getEvents(),
        TE.fold(
          (error: ServiceError): T.Task<Event[]> =>
            () =>
              Promise.reject(error),
          (success: readonly Event[]): T.Task<Event[]> =>
            () =>
              Promise.resolve([...success]),
        ),
      )();

      // Second call should return from database
      const secondResult = await pipe(
        eventService.getEvents(),
        TE.fold(
          (error: ServiceError): T.Task<Event[]> =>
            () =>
              Promise.reject(error),
          (success: readonly Event[]): T.Task<Event[]> =>
            () =>
              Promise.resolve([...success]),
        ),
      )();

      expect(secondResult).toEqual(firstResult);
    });
  });

  describe('getEvent', () => {
    it('should return an event by ID', async () => {
      // First get all events to populate database
      const events = await pipe(
        eventService.getEvents(),
        TE.fold(
          (error: ServiceError): T.Task<Event[]> =>
            () =>
              Promise.reject(error),
          (success: readonly Event[]): T.Task<Event[]> =>
            () =>
              Promise.resolve([...success]),
        ),
      )();

      const firstEventIdResult = validateEventId(events[0].id);
      if (E.isLeft(firstEventIdResult)) {
        throw new Error('Invalid event ID');
      }
      const firstEventId = firstEventIdResult.right;

      const result = await pipe(
        eventService.getEvent(firstEventId),
        TE.fold(
          (error: ServiceError): T.Task<Event | null> =>
            () =>
              Promise.reject(error),
          (success: Event | null): T.Task<Event | null> =>
            () =>
              Promise.resolve(success),
        ),
      )();

      expect(result).toBeDefined();
      expect(result?.id).toEqual(firstEventId);
    });

    it('should return null for non-existent event ID', async () => {
      const nonExistentIdResult = validateEventId(9999);
      if (E.isLeft(nonExistentIdResult)) {
        throw new Error('Invalid event ID');
      }
      const nonExistentId = nonExistentIdResult.right;

      const result = await pipe(
        eventService.getEvent(nonExistentId),
        TE.fold(
          (error: ServiceError): T.Task<Event | null> =>
            () =>
              Promise.reject(error),
          (success: Event | null): T.Task<Event | null> =>
            () =>
              Promise.resolve(success),
        ),
      )();

      expect(result).toBeNull();
    });
  });

  describe('getCurrentEvent', () => {
    it('should return the current event', async () => {
      // First get all events to populate database
      await pipe(
        eventService.getEvents(),
        TE.fold(
          (error: ServiceError): T.Task<Event[]> =>
            () =>
              Promise.reject(error),
          (success: readonly Event[]): T.Task<Event[]> =>
            () =>
              Promise.resolve([...success]),
        ),
      )();

      const result = await pipe(
        eventService.getCurrentEvent(),
        TE.fold(
          (error: ServiceError): T.Task<Event | null> =>
            () =>
              Promise.reject(error),
          (success: Event | null): T.Task<Event | null> =>
            () =>
              Promise.resolve(success),
        ),
      )();

      expect(result).toBeDefined();
      if (result) {
        expect(result.isCurrent).toBe(true);
      }
    });
  });

  describe('getNextEvent', () => {
    it('should return the next event', async () => {
      // First get all events to populate database
      await pipe(
        eventService.getEvents(),
        TE.fold(
          (error: ServiceError): T.Task<Event[]> =>
            () =>
              Promise.reject(error),
          (success: readonly Event[]): T.Task<Event[]> =>
            () =>
              Promise.resolve([...success]),
        ),
      )();

      const result = await pipe(
        eventService.getNextEvent(),
        TE.fold(
          (error: ServiceError): T.Task<Event | null> =>
            () =>
              Promise.reject(error),
          (success: Event | null): T.Task<Event | null> =>
            () =>
              Promise.resolve(success),
        ),
      )();

      expect(result).toBeDefined();
      if (result) {
        expect(result.isNext).toBe(true);
      }
    });
  });
});
