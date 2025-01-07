// Phase Router Module
//
// Provides Express router configuration for FPL phase endpoints.
// Handles routes for retrieving phase information:
// - All phases in the season
// - Specific phase by ID
//
// Routes follow RESTful principles with functional programming patterns,
// error handling and request validation.

import { Router } from 'express';
import * as t from 'io-ts';
import type { ServiceContainer } from '../../service';
import { createPhaseHandlers } from '../handlers/phase.handler';
import { createHandler, validateRequest } from '../middlewares/core';

// io-ts codec for validating phase ID parameters
// Ensures the ID is a positive integer as required by the FPL API
const PhaseIdParams = t.type({
  params: t.type({
    id: t.string,
  }),
});

// Creates and configures the phases router with request handling and validation
// Uses dependency injection to receive the phase service for loose coupling
export const phaseRouter = ({ phaseService }: ServiceContainer): Router => {
  const router = Router();
  const handlers = createPhaseHandlers(phaseService);

  // GET /phases - Retrieves all phases in the current season
  router.get('/', createHandler(handlers.getAllPhases));

  // GET /phases/:id - Retrieves a specific phase by its ID
  router.get('/:id', validateRequest(PhaseIdParams), createHandler(handlers.getPhaseById));

  return router;
};
