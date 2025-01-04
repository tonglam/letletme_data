import { pipe } from 'fp-ts/function';
import { Task } from 'fp-ts/Task';
import * as TE from 'fp-ts/TaskEither';
import { EventService } from '../../src/service/event/types';
import { eventWorkflows } from '../../src/service/event/workflow';
import { ServiceError } from '../../src/types/errors.type';
import { Event, EventId } from '../../src/types/events.type';
import { createServiceOperationError } from '../../src/utils/error.util';

// Mock the logger
jest.mock('../../src/infrastructure/logger', () => ({
  getWorkflowLogger: jest.fn().mockReturnValue({
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  }),
}));

describe('Event Workflows', () => {
  let mockEventId: EventId;
  let mockEvent: Event;
  let mockEventService: EventService;
  let workflows: ReturnType<typeof eventWorkflows>;

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

    // Mock event service
    mockEventService = {
      getEvents: jest.fn(),
      getEvent: jest.fn(),
      getCurrentEvent: jest.fn(),
      getNextEvent: jest.fn(),
      saveEvents: jest.fn(),
    };

    // Create workflows instance
    workflows = eventWorkflows(mockEventService);
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('syncEvents', () => {
    it('should sync events successfully', async () => {
      const events = [mockEvent];
      (mockEventService.getEvents as jest.Mock).mockReturnValue(TE.right(events));
      (mockEventService.saveEvents as jest.Mock).mockReturnValue(TE.right(events));

      const result = await pipe(
        workflows.syncEvents(),
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
      expect(result[0]).toEqual(mockEvent);
      expect(mockEventService.getEvents).toHaveBeenCalled();
      expect(mockEventService.saveEvents).toHaveBeenCalledWith(events);
    });

    it('should handle getEvents error', async () => {
      const mockError = createServiceOperationError({
        message: 'Failed to fetch events',
        cause: new Error('API error'),
      });
      (mockEventService.getEvents as jest.Mock).mockReturnValue(TE.left(mockError));

      await expect(
        pipe(
          workflows.syncEvents(),
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
        message: expect.stringContaining('Failed to fetch events'),
        name: mockError.name,
        cause: mockError.cause,
      });

      expect(mockEventService.getEvents).toHaveBeenCalled();
      expect(mockEventService.saveEvents).not.toHaveBeenCalled();
    });

    it('should handle saveEvents error', async () => {
      const events = [mockEvent];
      const mockError = createServiceOperationError({
        message: 'Failed to save events',
        cause: new Error('Database error'),
      });
      (mockEventService.getEvents as jest.Mock).mockReturnValue(TE.right(events));
      (mockEventService.saveEvents as jest.Mock).mockReturnValue(TE.left(mockError));

      await expect(
        pipe(
          workflows.syncEvents(),
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
        message: expect.stringContaining('Failed to save events'),
        name: mockError.name,
        cause: mockError.cause,
      });

      expect(mockEventService.getEvents).toHaveBeenCalled();
      expect(mockEventService.saveEvents).toHaveBeenCalledWith(events);
    });
  });
});
