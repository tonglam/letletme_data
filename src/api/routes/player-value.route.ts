// Player Value Router Module
//
// Provides Express router configuration for FPL player value endpoints.
// Handles routes for retrieving player value information:
// - All player values in the season
// - Specific player value by ID
//
// Routes follow RESTful principles with functional programming patterns,
// error handling and request validation.

import { Router } from 'express';
import * as t from 'io-ts';
import type { ServiceContainer } from '../../service';
import { createPlayerValueHandlers } from '../handlers/player-value.handler';
import { createHandler, validateRequest } from '../middlewares/core';

// io-ts codec for validating player value ID parameters
// Ensures the ID is a valid string in format {number}_{YYYY-MM-DD}
const PlayerValueIdParams = t.type({
  params: t.type({
    id: t.string,
  }),
});

// Creates and configures the player values router with request handling and validation
// Uses dependency injection to receive the player value service for loose coupling
export const playerValueRouter = ({ playerValueService }: ServiceContainer): Router => {
  const router = Router();
  const handlers = createPlayerValueHandlers(playerValueService);

  // GET /player-values - Retrieves all player values in the current season
  router.get('/', createHandler(handlers.getAllPlayerValues));

  // GET /player-values/:id - Retrieves a specific player value by its ID
  router.get(
    '/:id',
    validateRequest(PlayerValueIdParams),
    createHandler(handlers.getPlayerValueById),
  );

  return router;
};
