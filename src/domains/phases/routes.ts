import { Router } from 'express';
import * as E from 'fp-ts/Either';
import { pipe } from 'fp-ts/function';
import * as TE from 'fp-ts/TaskEither';
import { createFPLClient } from '../../infrastructure/api/fpl';
import { createPhaseServiceImpl } from '../../services/phases/service';
import { phaseWorkflows } from '../../services/phases/workflow';
import { validatePhaseId } from '../../types/phases.type';
import { phaseRepository } from './repository';

export const phaseRouter = Router();

// Create dependencies
const bootstrapApi = createFPLClient();
const phaseService = createPhaseServiceImpl({
  bootstrapApi,
  phaseRepository,
});
const workflows = phaseWorkflows(phaseService);

// Get current phase for an event
phaseRouter.get('/current/:eventId', async (req, res) => {
  const result = await pipe(
    parseInt(req.params.eventId, 10),
    (eventId) => phaseService.getCurrentActivePhase(eventId),
    TE.map((phase) => ({
      status: 'success',
      data: phase,
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

// Get all phases
phaseRouter.get('/', async (req, res) => {
  const result = await pipe(
    phaseService.getPhases(),
    TE.map((phases) => ({
      status: 'success',
      data: phases,
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

// Get phase by ID
phaseRouter.get('/:id', async (req, res) => {
  const phaseId = pipe(parseInt(req.params.id, 10), validatePhaseId);

  if (E.isLeft(phaseId)) {
    res.status(400).json({
      status: 'error',
      error: phaseId.left,
    });
    return;
  }

  const result = await pipe(
    workflows.getPhaseDetails(phaseId.right, parseInt(req.query.eventId as string, 10) || 1),
    TE.map((phaseDetails) => ({
      status: 'success',
      data: phaseDetails,
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

// Sync phases
phaseRouter.post('/sync', async (req, res) => {
  const result = await pipe(
    workflows.syncAndVerifyPhases(),
    TE.map((phases) => ({
      status: 'success',
      data: phases,
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
