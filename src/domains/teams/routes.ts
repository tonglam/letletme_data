import { Router } from 'express';
import * as E from 'fp-ts/Either';
import * as TE from 'fp-ts/TaskEither';
import { pipe } from 'fp-ts/function';
import { APIError, createInternalServerError } from '../../infrastructure/api/common/errors';
import { createFPLClient } from '../../infrastructure/api/fpl';
import { teamJobService } from '../../services/queue/meta/teams.job';
import { createTeamServiceImpl } from '../../services/teams/service';
import { teamWorkflows } from '../../services/teams/workflow';
import { validateTeamId } from '../../types/teams.type';
import { createTeamOperations } from './operations';
import { teamRepository } from './repository';

export const teamRouter = Router();

// Create dependencies
const bootstrapApi = createFPLClient();
const teamService = createTeamServiceImpl({
  bootstrapApi,
  teamRepository,
});
const workflows = teamWorkflows(teamService);
const operations = createTeamOperations();

// Helper function to handle API responses
const handleApiResponse = <T>(task: TE.TaskEither<APIError, T>) =>
  pipe(
    task,
    TE.map((data) => ({
      status: 'success',
      data,
    })),
    TE.mapLeft((error) => ({
      status: 'error',
      error: error.message,
    })),
  );

// Helper function to convert Error to APIError
const toAPIError = (error: Error): APIError =>
  createInternalServerError({
    message: error.message,
  });

teamRouter.get('/', async (_req, res) => {
  const result = await handleApiResponse(operations.getTeams())();

  if (result._tag === 'Left') {
    res.status(400).json(result.left);
  } else {
    res.json(result.right);
  }
});

teamRouter.get('/:id', async (req, res) => {
  const teamId = pipe(parseInt(req.params.id, 10), validateTeamId);

  if (E.isLeft(teamId)) {
    res.status(400).json({
      status: 'error',
      error: teamId.left,
    });
    return;
  }

  const result = await handleApiResponse(operations.getTeam(teamId.right))();

  if (result._tag === 'Left') {
    res.status(400).json(result.left);
  } else {
    res.json(result.right);
  }
});

// Workflow-based endpoints
teamRouter.post('/sync', async (_req, res) => {
  const result = await handleApiResponse(workflows.syncAndVerifyTeams())();

  if (result._tag === 'Left') {
    res.status(400).json(result.left);
  } else {
    res.json(result.right);
  }
});

// Job-based endpoints
teamRouter.post('/jobs/sync', async (_req, res) => {
  const result = await handleApiResponse(
    pipe(teamJobService.scheduleTeamsSync(), TE.mapLeft(toAPIError)),
  )();

  if (result._tag === 'Left') {
    res.status(400).json(result.left);
  } else {
    res.json(result.right);
  }
});

teamRouter.post('/jobs/:id/update', async (req, res) => {
  const teamId = pipe(parseInt(req.params.id, 10), validateTeamId);

  if (E.isLeft(teamId)) {
    res.status(400).json({
      status: 'error',
      error: teamId.left,
    });
    return;
  }

  const result = await handleApiResponse(
    pipe(
      teamJobService.scheduleTeamUpdate(teamId.right as unknown as number, {
        forceUpdate: req.body.forceUpdate,
      }),
      TE.mapLeft(toAPIError),
    ),
  )();

  if (result._tag === 'Left') {
    res.status(400).json(result.left);
  } else {
    res.json(result.right);
  }
});
