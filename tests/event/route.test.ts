import express, { Express } from 'express';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import request from 'supertest';
import { createRouter } from '../../src/api';
import { handleError } from '../../src/api/middleware/core';
import { ServiceContainer, ServiceKey } from '../../src/service';
import { Branded } from '../../src/types/base.type';
import { ServiceErrorCode, createServiceError } from '../../src/types/errors.type';
import { Event, createEventId } from '../../src/types/events.type';

describe('Event Routes', () => {
  let app: Express;
  let mockEventService: jest.Mocked<ServiceContainer[typeof ServiceKey.EVENT]>;

  beforeEach(() => {
    mockEventService = {
      getEvents: jest.fn(),
      getEvent: jest.fn(),
      getCurrentEvent: jest.fn(),
      getNextEvent: jest.fn(),
      saveEvents: jest.fn(),
      syncEventsFromApi: jest.fn(),
    };

    app = express();
    app.use('/api', createRouter({ [ServiceKey.EVENT]: mockEventService }));
    app.use(handleError);
  });

  describe('GET /events', () => {
    it('should return all events', async () => {
      const mockEvents: Event[] = [
        {
          id: pipe(
            createEventId.validate(1),
            E.getOrElse<string, Branded<number, 'EventId'>>(() => {
              throw new Error('Invalid event ID');
            }),
          ),
          name: 'Event 1',
          deadlineTime: '2023-08-11T17:30:00Z',
          deadlineTimeEpoch: 1691774200,
          deadlineTimeGameOffset: 0,
          releaseTime: null,
          averageEntryScore: 0,
          finished: false,
          dataChecked: false,
          highestScore: 0,
          highestScoringEntry: 0,
          isPrevious: false,
          isCurrent: true,
          isNext: false,
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
        },
      ];

      mockEventService.getEvents.mockImplementation(
        () => () => Promise.resolve(E.right(mockEvents)),
      );

      const response = await request(app).get('/api/events');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ data: mockEvents });
    });

    it('should handle service error', async () => {
      mockEventService.getEvents.mockImplementation(() =>
        TE.left(
          createServiceError({
            code: ServiceErrorCode.OPERATION_ERROR,
            message: 'Failed to fetch events',
          }),
        ),
      );

      const response = await request(app).get('/api/events');

      expect(response.status).toBe(503);
      expect(response.body).toEqual({
        error: {
          code: 'SERVICE_ERROR',
          message: 'Failed to fetch events',
        },
      });
    });
  });

  describe('GET /events/current', () => {
    it('should return current event', async () => {
      const mockEvent: Event = {
        id: pipe(
          createEventId.validate(1),
          E.getOrElse<string, Branded<number, 'EventId'>>(() => {
            throw new Error('Invalid event ID');
          }),
        ),
        name: 'Event 1',
        deadlineTime: '2023-08-11T17:30:00Z',
        deadlineTimeEpoch: 1691774200,
        deadlineTimeGameOffset: 0,
        releaseTime: null,
        averageEntryScore: 0,
        finished: false,
        dataChecked: false,
        highestScore: 0,
        highestScoringEntry: 0,
        isPrevious: false,
        isCurrent: true,
        isNext: false,
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
      };

      mockEventService.getCurrentEvent.mockImplementation(
        () => () => Promise.resolve(E.right(mockEvent)),
      );

      const response = await request(app).get('/api/events/current');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ data: mockEvent });
    });

    it('should handle not found error', async () => {
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
    });
  });

  describe('GET /events/next', () => {
    it('should return next event', async () => {
      const mockEvent: Event = {
        id: pipe(
          createEventId.validate(2),
          E.getOrElse<string, Branded<number, 'EventId'>>(() => {
            throw new Error('Invalid event ID');
          }),
        ),
        name: 'Event 2',
        deadlineTime: '2023-08-18T17:30:00Z',
        deadlineTimeEpoch: 1692379000,
        deadlineTimeGameOffset: 0,
        releaseTime: null,
        averageEntryScore: 0,
        finished: false,
        dataChecked: false,
        highestScore: 0,
        highestScoringEntry: 0,
        isPrevious: false,
        isCurrent: false,
        isNext: true,
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
      };

      mockEventService.getNextEvent.mockImplementation(
        () => () => Promise.resolve(E.right(mockEvent)),
      );

      const response = await request(app).get('/api/events/next');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ data: mockEvent });
    });

    it('should handle not found error', async () => {
      mockEventService.getNextEvent.mockImplementation(() => () => Promise.resolve(E.right(null)));

      const response = await request(app).get('/api/events/next');

      expect(response.status).toBe(404);
      expect(response.body).toEqual({
        error: {
          code: 'NOT_FOUND',
          message: 'Next event not found',
        },
      });
    });
  });

  describe('GET /events/:id', () => {
    it('should return event by id', async () => {
      const mockEvent: Event = {
        id: pipe(
          createEventId.validate(1),
          E.getOrElse<string, Branded<number, 'EventId'>>(() => {
            throw new Error('Invalid event ID');
          }),
        ),
        name: 'Event 1',
        deadlineTime: '2023-08-11T17:30:00Z',
        deadlineTimeEpoch: 1691774200,
        deadlineTimeGameOffset: 0,
        releaseTime: null,
        averageEntryScore: 0,
        finished: false,
        dataChecked: false,
        highestScore: 0,
        highestScoringEntry: 0,
        isPrevious: false,
        isCurrent: true,
        isNext: false,
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
      };

      mockEventService.getEvent.mockImplementation(() => () => Promise.resolve(E.right(mockEvent)));

      const response = await request(app).get('/api/events/1');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ data: mockEvent });
    });

    it('should handle not found error', async () => {
      mockEventService.getEvent.mockImplementation(() => () => Promise.resolve(E.right(null)));

      const response = await request(app).get('/api/events/999');

      expect(response.status).toBe(404);
      expect(response.body).toEqual({
        error: {
          code: 'NOT_FOUND',
          message: 'Event with ID 999 not found',
        },
      });
    });

    it('should handle validation error', async () => {
      const response = await request(app).get('/api/events/invalid');

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid event ID: must be a positive integer',
        },
      });
    });
  });
});
