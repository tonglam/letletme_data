// Player Stat Router Module
//
// Provides Express router configuration for FPL player stat endpoints.
// Handles routes for retrieving player stat information:
// - All player stats in the season
// - Specific player stat by ID
//
// Routes follow RESTful principles with functional programming patterns,
// error handling and request validation.

import { Router } from 'express';
import * as t from 'io-ts';
import type { ServiceContainer } from '../../service';
import { createPlayerStatHandlers } from '../handlers/player-stat.handler';
import { createHandler, validateRequest } from '../middlewares/core';

// io-ts codec for validating player stat ID parameters
// Ensures the ID is a valid string
const PlayerStatIdParams = t.type({
  params: t.type({
    id: t.string,
  }),
});

// Creates and configures the player stats router with request handling and validation
// Uses dependency injection to receive the player stat service for loose coupling
export const playerStatRouter = ({ playerStatService }: ServiceContainer): Router => {
  const router = Router();
  const handlers = createPlayerStatHandlers(playerStatService);

  // GET /player-stats - Retrieves all player stats in the current season
  router.get('/', createHandler(handlers.getAllPlayerStats));

  // GET /player-stats/:id - Retrieves a specific player stat by its ID
  router.get(
    '/:id',
    validateRequest(PlayerStatIdParams),
    createHandler(handlers.getPlayerStatById),
  );

  return router;
};
