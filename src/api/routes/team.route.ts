// Team Router Module
//
// Provides Express router configuration for FPL team endpoints.
// Handles routes for retrieving team information:
// - All teams in the season
// - Specific team by ID
//
// Routes follow RESTful principles with functional programming patterns,
// error handling and request validation.

import { Router } from 'express';
import * as t from 'io-ts';
import type { ServiceContainer } from '../../service';
import { createTeamHandlers } from '../handlers/team.handler';
import { createHandler, validateRequest } from '../middlewares/core';

// io-ts codec for validating team ID parameters
// Ensures the ID is a positive integer as required by the FPL API
const TeamIdParams = t.type({
  params: t.type({
    id: t.string,
  }),
});

// Creates and configures the teams router with request handling and validation
// Uses dependency injection to receive the team service for loose coupling
export const teamRouter = ({ teamService }: ServiceContainer): Router => {
  const router = Router();
  const handlers = createTeamHandlers(teamService);

  // GET /teams - Retrieves all teams in the current season
  router.get('/', createHandler(handlers.getAllTeams));

  // GET /teams/:id - Retrieves a specific team by its ID
  router.get('/:id', validateRequest(TeamIdParams), createHandler(handlers.getTeamById));

  return router;
};
