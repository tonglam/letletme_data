import { describe, expect, jest, test, beforeEach, afterEach } from '@jest/globals';
import { left, right } from 'fp-ts/Either';
import { some, none } from 'fp-ts/Option';
import { EventSyncService } from '../../../src/services/events/sync';
import { EventSchedulerService } from '../../../src/services/events/scheduler';
import { EventBootstrapService } from '../../../src/services/events/bootstrap';
import { CacheStrategy, FPLEvent, TransactionContext, EventService, EventStatus } from '../../../src/services/events/types';

// Mock implementations
const mockCacheStrategy = {
  get: jest.fn(),
  set: jest.fn(),
  invalidate: jest.fn(),
  clear: jest.fn(),
} as jest.Mocked<CacheStrategy>;

const mockTransactionContext = {
  start: jest.fn(),
  commit: jest.fn(),
  rollback: jest.fn(),
  isActive: false,
} as jest.Mocked<TransactionContext>;

const mockEventService = {
  initialize: jest.fn(),
  syncEvents: jest.fn(),
  scheduleEventUpdates: jest.fn(),
  verifyEventData: jest.fn(),
  syncEventDetails: jest.fn(),
} as jest.Mocked<EventService>;

// Setup default mock implementations
mockCacheStrategy.get.mockResolvedValue(none);
mockCacheStrategy.set.mockResolvedValue(undefined);
mockCacheStrategy.invalidate.mockResolvedValue(undefined);
mockCacheStrategy.clear.mockResolvedValue(undefined);

mockTransactionContext.start.mockResolvedValue(undefined);
mockTransactionContext.commit.mockResolvedValue(undefined);
mockTransactionContext.rollback.mockResolvedValue(undefined);

mockEventService.initialize.mockResolvedValue(right(undefined));
mockEventService.syncEvents.mockResolvedValue(right([]));
mockEventService.scheduleEventUpdates.mockResolvedValue(right(undefined));
mockEventService.verifyEventData.mockResolvedValue(right(true));
mockEventService.syncEventDetails.mockResolvedValue(right({} as FPLEvent));

// Sample event data
const sampleEvent: FPLEvent = {
  id: 1,
  name: 'Gameweek 1',
  startTime: new Date('2024-12-09T09:00:00Z'),
  endTime: new Date('2024-12-09T11:00:00Z'),
  status: EventStatus.ACTIVE,
  details: {
    description: 'First gameweek of the season',
    metadata: {
      averageScore: 50,
      highestScore: 100,
      mostCaptained: 3,
      chipUsage: {
        wildcard: 1000,
        tripleCaptain: 500,
        benchBoost: 300,
        freeHit: 200,
      },
    },
  },
};

describe('EventSyncService', () => {
  let eventSyncService: EventSyncService;

  beforeEach(() => {
    jest.clearAllMocks();
    eventSyncService = new EventSyncService(mockCacheStrategy, mockTransactionContext);
  });

  describe('syncEvents', () => {
    test('should successfully sync events', async () => {
      const result = await eventSyncService.syncEvents();
      expect(mockTransactionContext.start).toHaveBeenCalled();
      expect(mockTransactionContext.commit).toHaveBeenCalled();
      expect(result._tag).toBe('Right');
    });

    test('should handle sync failure', async () => {
      mockTransactionContext.start.mockRejectedValueOnce(new Error('Sync failed'));
      const result = await eventSyncService.syncEvents();
      expect(result._tag).toBe('Left');
      expect(mockTransactionContext.rollback).toHaveBeenCalled();
    });
  });

  describe('syncEventDetails', () => {
    test('should return cached event if available', async () => {
      mockCacheStrategy.get.mockResolvedValueOnce(some(sampleEvent));
      await eventSyncService.syncEventDetails(1);
      expect(mockTransactionContext.start).not.toHaveBeenCalled();
    });

    test('should fetch and cache event if not in cache', async () => {
      mockCacheStrategy.get.mockResolvedValueOnce(none);
      await eventSyncService.syncEventDetails(1);
      expect(mockTransactionContext.start).toHaveBeenCalled();
      expect(mockCacheStrategy.set).toHaveBeenCalled();
    });
  });
});

describe('EventSchedulerService', () => {
  let eventSchedulerService: EventSchedulerService;

  beforeEach(() => {
    jest.clearAllMocks();
    eventSchedulerService = new EventSchedulerService(mockEventService, mockTransactionContext);
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('scheduleEventUpdates', () => {
    test('should successfully schedule updates', async () => {
      mockEventService.syncEvents.mockResolvedValueOnce(right([]));
      const result = await eventSchedulerService.scheduleEventUpdates();
      expect(result._tag).toBe('Right');
      expect(mockTransactionContext.start).toHaveBeenCalled();
      expect(mockTransactionContext.commit).toHaveBeenCalled();
    });

    test('should handle scheduling failure', async () => {
      mockTransactionContext.start.mockRejectedValueOnce(new Error('Scheduling failed'));
      const result = await eventSchedulerService.scheduleEventUpdates();
      expect(result._tag).toBe('Left');
      expect(mockTransactionContext.rollback).toHaveBeenCalled();
    });

    test('should perform scheduled update', async () => {
      mockEventService.syncEvents.mockResolvedValueOnce(right([sampleEvent]));
      mockEventService.verifyEventData.mockResolvedValueOnce(right(true));
      
      await eventSchedulerService.scheduleEventUpdates();
      jest.advanceTimersByTime(300000); // Advance 5 minutes
      
      expect(mockEventService.syncEvents).toHaveBeenCalled();
      expect(mockEventService.verifyEventData).toHaveBeenCalled();
    });
  });
});

describe('EventBootstrapService', () => {
  let eventBootstrapService: EventBootstrapService;

  beforeEach(() => {
    jest.clearAllMocks();
    eventBootstrapService = new EventBootstrapService(mockEventService, mockTransactionContext);
  });

  describe('initialize', () => {
    test('should successfully initialize services', async () => {
      mockEventService.initialize.mockResolvedValueOnce(right(undefined));
      mockEventService.syncEvents.mockResolvedValueOnce(right([sampleEvent]));
      mockEventService.scheduleEventUpdates.mockResolvedValueOnce(right(undefined));

      const result = await eventBootstrapService.initialize();
      
      expect(result._tag).toBe('Right');
      expect(mockTransactionContext.start).toHaveBeenCalled();
      expect(mockTransactionContext.commit).toHaveBeenCalled();
      expect(mockEventService.initialize).toHaveBeenCalled();
      expect(mockEventService.syncEvents).toHaveBeenCalled();
      expect(mockEventService.scheduleEventUpdates).toHaveBeenCalled();
    });

    test('should handle initialization failure', async () => {
      mockEventService.initialize.mockResolvedValueOnce(left(new Error('Init failed')));

      const result = await eventBootstrapService.initialize();
      
      expect(result._tag).toBe('Left');
      expect(mockTransactionContext.rollback).toHaveBeenCalled();
      expect(mockEventService.syncEvents).not.toHaveBeenCalled();
      expect(mockEventService.scheduleEventUpdates).not.toHaveBeenCalled();
    });

    test('should handle sync failure during initialization', async () => {
      mockEventService.initialize.mockResolvedValueOnce(right(undefined));
      mockEventService.syncEvents.mockResolvedValueOnce(left(new Error('Sync failed')));

      const result = await eventBootstrapService.initialize();
      
      expect(result._tag).toBe('Left');
      expect(mockTransactionContext.rollback).toHaveBeenCalled();
      expect(mockEventService.scheduleEventUpdates).not.toHaveBeenCalled();
    });
  });
});
