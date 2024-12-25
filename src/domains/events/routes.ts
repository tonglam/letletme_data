import { Router } from 'express';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { createFPLClient } from '../../infrastructure/api/fpl';
import { createEventServiceImpl } from '../../services/events/service';
import { eventWorkflows } from '../../services/events/workflow';
import { eventJobService } from '../../services/queue/meta/events.job';
import { validateEventId } from '../../types/events.type';
import { eventRepository } from './repository';

export const eventRouter = Router();

// Create dependencies
const bootstrapApi = createFPLClient();
const eventService = createEventServiceImpl({
  bootstrapApi,
  eventRepository,
});
const workflows = eventWorkflows(eventService);

// Get current event
eventRouter.get('/current', async (req, res) => {
  const result = await pipe(
    eventService.getCurrentEvent(),
    TE.map((event) => ({
      status: 'success',
      data: event,
    })),
    TE.mapLeft((error) => ({
      status: 'error',
      error: error.message,
    })),
  )();

  if (result._tag === 'Left') {
    res.status(400).json(result.left);
  } else {
    res.json(result.right);
  }
});

// Get next event
eventRouter.get('/next', async (req, res) => {
  const result = await pipe(
    eventService.getNextEvent(),
    TE.map((event) => ({
      status: 'success',
      data: event,
    })),
    TE.mapLeft((error) => ({
      status: 'error',
      error: error.message,
    })),
  )();

  if (result._tag === 'Left') {
    res.status(400).json(result.left);
  } else {
    res.json(result.right);
  }
});

// Get all events
eventRouter.get('/', async (req, res) => {
  const result = await pipe(
    eventService.getEvents(),
    TE.map((events) => ({
      status: 'success',
      data: events,
    })),
    TE.mapLeft((error) => ({
      status: 'error',
      error: error.message,
    })),
  )();

  if (result._tag === 'Left') {
    res.status(400).json(result.left);
  } else {
    res.json(result.right);
  }
});

// Get event by ID
eventRouter.get('/:id', async (req, res) => {
  const eventId = pipe(parseInt(req.params.id, 10), validateEventId);

  if (E.isLeft(eventId)) {
    res.status(400).json({
      status: 'error',
      error: eventId.left,
    });
    return;
  }

  const result = await pipe(
    workflows.getEventDetails(eventId.right),
    TE.map((eventDetails) => ({
      status: 'success',
      data: eventDetails,
    })),
    TE.mapLeft((error) => ({
      status: 'error',
      error: error.message,
    })),
  )();

  if (result._tag === 'Left') {
    res.status(400).json(result.left);
  } else {
    res.json(result.right);
  }
});

// Sync events
eventRouter.post('/sync', async (req, res) => {
  const result = await pipe(
    eventJobService.scheduleEventsSync(),
    TE.map((job) => ({
      status: 'success',
      data: {
        jobId: job.id,
        message: 'Event sync job scheduled successfully',
      },
    })),
    TE.mapLeft((error) => ({
      status: 'error',
      error: error.message,
    })),
  )();

  if (result._tag === 'Left') {
    res.status(400).json(result.left);
  } else {
    res.json(result.right);
  }
});
