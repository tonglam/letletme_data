import express, { Express } from 'express';
import * as E from 'fp-ts/Either';
import * as TE from 'fp-ts/TaskEither';
import request from 'supertest';
import { createRouter } from '../../src/api';
import { handleError } from '../../src/api/middlewares/core';
import { ServiceContainer, ServiceKey } from '../../src/service';
import { ServiceErrorCode, createServiceError } from '../../src/types/error.type';
import { Event, EventResponse, toDomainEvent } from '../../src/types/event.type';
import bootstrapData from '../data/bootstrap.json';

// Test fixtures
const getTestEvent = (id: number, isCurrent = false, isNext = false): Event => {
  const baseEvent = bootstrapData.events.find((event) => event.id === id);
  if (!baseEvent) {
    throw new Error(`Event with ID ${id} not found in bootstrap data`);
  }

  const eventResponse: EventResponse = {
    ...baseEvent,
    is_current: isCurrent,
    is_next: isNext,
    is_previous: false,
  };

  const result = toDomainEvent(eventResponse);
  if (E.isLeft(result)) {
    throw new Error(`Failed to convert event: ${result.left}`);
  }
  return result.right;
};

describe('Event Routes', () => {
  let app: Express;
  let mockEventService: jest.Mocked<ServiceContainer[typeof ServiceKey.EVENT]>;

  beforeAll(() => {
    mockEventService = {
      getEvents: jest.fn(),
      getEvent: jest.fn(),
      getCurrentEvent: jest.fn(),
      getNextEvent: jest.fn(),
      saveEvents: jest.fn(),
      syncEventsFromApi: jest.fn(),
      warmUp: jest.fn(),
    } as jest.Mocked<ServiceContainer[typeof ServiceKey.EVENT]>;

    const container: Partial<ServiceContainer> = {
      [ServiceKey.EVENT]: mockEventService,
    };

    app = express();
    app.use('/api', createRouter(container as ServiceContainer));
    app.use(handleError);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/events', () => {
    const mockEvents = [getTestEvent(1, true), getTestEvent(2, false, true)];

    it('should successfully return all events when available', async () => {
      mockEventService.getEvents.mockImplementation(
        () => () => Promise.resolve(E.right(mockEvents)),
      );

      const response = await request(app).get('/api/events');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ data: mockEvents });
      expect(mockEventService.getEvents).toHaveBeenCalledTimes(1);
    });

    it('should handle service error with appropriate error response', async () => {
      const errorMessage = 'Failed to fetch events';
      mockEventService.getEvents.mockImplementation(() =>
        TE.left(
          createServiceError({
            code: ServiceErrorCode.OPERATION_ERROR,
            message: errorMessage,
          }),
        ),
      );

      const response = await request(app).get('/api/events');

      expect(response.status).toBe(503);
      expect(response.body).toEqual({
        error: {
          code: 'SERVICE_ERROR',
          message: errorMessage,
        },
      });
      expect(mockEventService.getEvents).toHaveBeenCalledTimes(1);
    });
  });

  describe('GET /api/events/current', () => {
    const mockCurrentEvent = getTestEvent(1, true);

    it('should successfully return current event when available', async () => {
      mockEventService.getCurrentEvent.mockImplementation(
        () => () => Promise.resolve(E.right(mockCurrentEvent)),
      );

      const response = await request(app).get('/api/events/current');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ data: mockCurrentEvent });
      expect(mockEventService.getCurrentEvent).toHaveBeenCalledTimes(1);
    });

    it('should return 404 when current event is not found', async () => {
      mockEventService.getCurrentEvent.mockImplementation(
        () => () => Promise.resolve(E.right(null)),
      );

      const response = await request(app).get('/api/events/current');

      expect(response.status).toBe(404);
      expect(response.body).toEqual({
        error: {
          code: 'NOT_FOUND',
          message: 'Current event not found',
        },
      });
      expect(mockEventService.getCurrentEvent).toHaveBeenCalledTimes(1);
    });
  });

  describe('GET /api/events/next', () => {
    const mockNextEvent = getTestEvent(2, false, true);

    it('should successfully return next event when available', async () => {
      mockEventService.getNextEvent.mockImplementation(
        () => () => Promise.resolve(E.right(mockNextEvent)),
      );

      const response = await request(app).get('/api/events/next');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ data: mockNextEvent });
      expect(mockEventService.getNextEvent).toHaveBeenCalledTimes(1);
    });

    it('should return 404 when next event is not found', async () => {
      mockEventService.getNextEvent.mockImplementation(() => () => Promise.resolve(E.right(null)));

      const response = await request(app).get('/api/events/next');

      expect(response.status).toBe(404);
      expect(response.body).toEqual({
        error: {
          code: 'NOT_FOUND',
          message: 'Next event not found',
        },
      });
      expect(mockEventService.getNextEvent).toHaveBeenCalledTimes(1);
    });
  });

  describe('GET /api/events/:id', () => {
    const mockEvent = getTestEvent(1);

    it('should successfully return event by valid ID', async () => {
      mockEventService.getEvent.mockImplementation(() => () => Promise.resolve(E.right(mockEvent)));

      const response = await request(app).get('/api/events/1');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ data: mockEvent });
      expect(mockEventService.getEvent).toHaveBeenCalledTimes(1);
    });

    it('should return 404 when event with ID is not found', async () => {
      const nonExistentId = 999;
      mockEventService.getEvent.mockImplementation(() => () => Promise.resolve(E.right(null)));

      const response = await request(app).get(`/api/events/${nonExistentId}`);

      expect(response.status).toBe(404);
      expect(response.body).toEqual({
        error: {
          code: 'NOT_FOUND',
          message: `Event with ID ${nonExistentId} not found`,
        },
      });
      expect(mockEventService.getEvent).toHaveBeenCalledTimes(1);
    });

    it('should return 400 when event ID is invalid', async () => {
      const response = await request(app).get('/api/events/invalid');

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid event ID: must be a positive integer',
        },
      });
      expect(mockEventService.getEvent).not.toHaveBeenCalled();
    });

    it('should handle service error with appropriate error response', async () => {
      const errorMessage = 'Database connection failed';
      mockEventService.getEvent.mockImplementation(() =>
        TE.left(
          createServiceError({
            code: ServiceErrorCode.OPERATION_ERROR,
            message: errorMessage,
          }),
        ),
      );

      const response = await request(app).get('/api/events/1');

      expect(response.status).toBe(503);
      expect(response.body).toEqual({
        error: {
          code: 'SERVICE_ERROR',
          message: errorMessage,
        },
      });
      expect(mockEventService.getEvent).toHaveBeenCalledTimes(1);
    });
  });
});
