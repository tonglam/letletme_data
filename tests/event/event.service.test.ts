jest.mock('../../src/service/event/cache', () => ({
  createEventServiceCache: jest.fn().mockReturnValue({
    getAllEvents: jest.fn().mockReturnValue(TE.right([])),
    getEvent: jest.fn().mockReturnValue(TE.right(null)),
    cacheEvent: jest.fn().mockReturnValue(TE.right(undefined)),
    cacheEvents: jest.fn().mockReturnValue(TE.right(undefined)),
    getCurrentEvent: jest.fn().mockReturnValue(TE.right(null)),
    getNextEvent: jest.fn().mockReturnValue(TE.right(null)),
    warmUp: jest.fn().mockReturnValue(TE.right(undefined)),
  }),
}));

import { pipe } from 'fp-ts/function';
import { Task } from 'fp-ts/Task';
import * as TE from 'fp-ts/TaskEither';
import { BootstrapApi } from '../../src/domain/bootstrap/operations';
import { EventRepositoryOperations } from '../../src/domain/event/types';
import { createEventService } from '../../src/service/event/service';
import { ServiceError } from '../../src/types/errors.type';
import { Event, EventId, EventResponse } from '../../src/types/events.type';
import { createServiceOperationError } from '../../src/utils/error.util';

describe('Event Service', () => {
  let mockEventId: EventId;
  let mockEvent: Event;
  let mockEventResponse: EventResponse;
  let mockRepository: EventRepositoryOperations;
  let mockBootstrapApi: BootstrapApi & { getBootstrapEvents: () => Promise<EventResponse[]> };
  let eventService: ReturnType<typeof createEventService>;

  beforeAll(() => {
    // Mock data setup
    mockEventId = 1 as EventId;
    mockEvent = {
      id: mockEventId,
      name: 'Gameweek 1',
      deadlineTime: new Date('2024-08-16T17:30:00Z'),
      deadlineTimeEpoch: 1723829400,
      deadlineTimeGameOffset: 0,
      releaseTime: null,
      averageEntryScore: 57,
      finished: true,
      dataChecked: true,
      highestScore: 127,
      highestScoringEntry: 3546234,
      isPrevious: false,
      isCurrent: false,
      isNext: false,
      cupLeaguesCreated: false,
      h2hKoMatchesCreated: false,
      rankedCount: 8597356,
      chipPlays: [
        {
          chip_name: 'bboost',
          num_played: 144974,
        },
        {
          chip_name: '3xc',
          num_played: 221430,
        },
      ],
      mostSelected: 401,
      mostTransferredIn: 27,
      mostCaptained: 351,
      mostViceCaptained: 351,
      topElement: 328,
      topElementInfo: {
        id: 328,
        points: 14,
      },
      transfersMade: 0,
      canEnter: false,
      canManage: false,
      released: true,
    };

    mockEventResponse = {
      id: 1,
      name: 'Gameweek 1',
      deadline_time: '2024-08-16T17:30:00Z',
      deadline_time_epoch: 1723829400,
      deadline_time_game_offset: 0,
      release_time: null,
      average_entry_score: 57,
      finished: true,
      data_checked: true,
      highest_score: 127,
      highest_scoring_entry: 3546234,
      is_previous: false,
      is_current: false,
      is_next: false,
      cup_leagues_created: false,
      h2h_ko_matches_created: false,
      ranked_count: 8597356,
      chip_plays: [
        {
          chip_name: 'bboost',
          num_played: 144974,
        },
        {
          chip_name: '3xc',
          num_played: 221430,
        },
      ],
      most_selected: 401,
      most_transferred_in: 27,
      most_captained: 351,
      most_vice_captained: 351,
      top_element: 328,
      top_element_info: {
        id: 328,
        points: 14,
      },
      transfers_made: 0,
      can_enter: false,
      can_manage: false,
      released: true,
    };

    // Mock repository setup
    mockRepository = {
      findAll: jest.fn(),
      findById: jest.fn(),
      findByIds: jest.fn(),
      findCurrent: jest.fn(),
      findNext: jest.fn(),
      create: jest.fn(),
      createMany: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    };

    // Mock bootstrap API setup
    mockBootstrapApi = {
      getBootstrapEvents: jest.fn().mockResolvedValue([]),
      getBootstrapData: jest.fn().mockResolvedValue({ events: [] }),
    };

    // Create event service instance
    eventService = createEventService(mockBootstrapApi, mockRepository);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    const { createEventServiceCache } = require('../../src/service/event/cache');
    createEventServiceCache().getAllEvents.mockReturnValue(TE.right([]));
  });

  describe('getEvents', () => {
    it('should return all events successfully', async () => {
      const { createEventServiceCache } = require('../../src/service/event/cache');
      createEventServiceCache().getAllEvents.mockReturnValue(TE.right([]));
      (mockRepository.findAll as jest.Mock).mockReturnValue(
        TE.right([
          {
            ...mockEventResponse,
            deadlineTime: '2024-08-16T17:30:00.000Z',
          },
        ]),
      );

      const result = await pipe(
        eventService.getEvents(),
        TE.fold(
          (error: ServiceError): Task<Event[]> =>
            () =>
              Promise.reject(error),
          (success: readonly Event[]): Task<Event[]> =>
            () =>
              Promise.resolve([...success]),
        ),
      )();

      expect(result).toHaveLength(1);
      expect(result[0].deadlineTime).toEqual(new Date('2024-08-16T17:30:00.000Z'));
      expect(result[0]).toEqual(
        expect.objectContaining({
          ...mockEvent,
          deadlineTime: new Date('2024-08-16T17:30:00.000Z'),
        }),
      );
    });

    it('should handle repository errors', async () => {
      const mockError = createServiceOperationError({
        message: 'Failed to fetch events from repository',
        cause: new Error('Database error'),
      });
      const { createEventServiceCache } = require('../../src/service/event/cache');
      createEventServiceCache().getAllEvents.mockReturnValue(TE.right([]));
      (mockRepository.findAll as jest.Mock).mockReturnValue(TE.left(mockError));

      await expect(
        pipe(
          eventService.getEvents(),
          TE.fold(
            (error: ServiceError): Task<Event[]> =>
              () =>
                Promise.reject(error),
            (success: readonly Event[]): Task<Event[]> =>
              () =>
                Promise.resolve([...success]),
          ),
        )(),
      ).rejects.toMatchObject({
        code: mockError.code,
        message: mockError.message,
        name: mockError.name,
        cause: mockError.cause,
      });
    });
  });

  describe('getEvent', () => {
    it('should return a single event by id successfully', async () => {
      (mockRepository.findById as jest.Mock).mockReturnValue(
        TE.right({
          ...mockEventResponse,
          deadlineTime: '2024-08-16T17:30:00.000Z',
        }),
      );
      (mockBootstrapApi.getBootstrapEvents as jest.Mock).mockResolvedValue([]);

      const result = await pipe(
        eventService.getEvent(mockEventId),
        TE.fold(
          (error: ServiceError): Task<Event | null> =>
            () =>
              Promise.reject(error),
          (success: Event | null): Task<Event | null> =>
            () =>
              Promise.resolve(success),
        ),
      )();

      expect(result?.deadlineTime).toEqual(new Date('2024-08-16T17:30:00.000Z'));
      expect(result).toEqual(
        expect.objectContaining({
          ...mockEvent,
          deadlineTime: new Date('2024-08-16T17:30:00.000Z'),
        }),
      );
    });

    it('should return null for non-existent event', async () => {
      (mockRepository.findById as jest.Mock).mockReturnValue(TE.right(null));
      (mockBootstrapApi.getBootstrapEvents as jest.Mock).mockResolvedValue([]);

      const result = await pipe(
        eventService.getEvent(999 as EventId),
        TE.fold(
          (error: ServiceError): Task<Event | null> =>
            () =>
              Promise.reject(error),
          (success: Event | null): Task<Event | null> =>
            () =>
              Promise.resolve(success),
        ),
      )();

      expect(result).toBeNull();
    });
  });

  describe('getCurrentEvent', () => {
    it('should return current event successfully', async () => {
      (mockRepository.findCurrent as jest.Mock).mockReturnValue(TE.right(mockEventResponse));
      (mockBootstrapApi.getBootstrapEvents as jest.Mock).mockResolvedValue([]);

      const result = await pipe(
        eventService.getCurrentEvent(),
        TE.fold(
          (error: ServiceError): Task<Event | null> =>
            () =>
              Promise.reject(error),
          (success: Event | null): Task<Event | null> =>
            () =>
              Promise.resolve(success),
        ),
      )();

      expect(result).toMatchObject(mockEvent);
    });
  });

  describe('getNextEvent', () => {
    it('should return next event successfully', async () => {
      (mockRepository.findNext as jest.Mock).mockReturnValue(TE.right(mockEventResponse));
      (mockBootstrapApi.getBootstrapEvents as jest.Mock).mockResolvedValue([]);

      const result = await pipe(
        eventService.getNextEvent(),
        TE.fold(
          (error: ServiceError): Task<Event | null> =>
            () =>
              Promise.reject(error),
          (success: Event | null): Task<Event | null> =>
            () =>
              Promise.resolve(success),
        ),
      )();

      expect(result).toMatchObject(mockEvent);
    });
  });

  describe('saveEvents', () => {
    it('should save events successfully', async () => {
      const eventsToSave = [mockEvent];
      (mockRepository.createMany as jest.Mock).mockReturnValue(TE.right([mockEventResponse]));
      (mockBootstrapApi.getBootstrapEvents as jest.Mock).mockResolvedValue([]);

      const result = await pipe(
        eventService.saveEvents(eventsToSave),
        TE.fold(
          (error: ServiceError): Task<Event[]> =>
            () =>
              Promise.reject(error),
          (success: readonly Event[]): Task<Event[]> =>
            () =>
              Promise.resolve([...success]),
        ),
      )();

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject(mockEvent);
      expect(mockRepository.createMany).toHaveBeenCalledWith(eventsToSave);
    });

    it('should handle save errors', async () => {
      const error = new Error('Save error');
      const eventsToSave = [mockEvent];
      (mockRepository.createMany as jest.Mock).mockReturnValue(TE.left(error));
      (mockBootstrapApi.getBootstrapEvents as jest.Mock).mockResolvedValue([]);

      await expect(
        pipe(
          eventService.saveEvents(eventsToSave),
          TE.fold(
            (error: ServiceError): Task<Event[]> =>
              () =>
                Promise.reject(error),
            (success: readonly Event[]): Task<Event[]> =>
              () =>
                Promise.resolve([...success]),
          ),
        )(),
      ).rejects.toHaveProperty('message', 'Service operation failed');
    });
  });
});
