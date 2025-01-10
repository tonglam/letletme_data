// Player Router Module
//
// Provides Express router configuration for FPL player endpoints.
// Handles routes for retrieving player information:
// - All players in the season
// - Specific player by ID
//
// Routes follow RESTful principles with functional programming patterns,
// error handling and request validation.

import { Router } from 'express';
import * as t from 'io-ts';
import type { ServiceContainer } from '../../service';
import { createPlayerHandlers } from '../handlers/player.handler';
import { createHandler, validateRequest } from '../middlewares/core';

// io-ts codec for validating player ID parameters
// Ensures the ID is a positive integer as required by the FPL API
const PlayerIdParams = t.type({
  params: t.type({
    id: t.string,
  }),
});

// Creates and configures the players router with request handling and validation
// Uses dependency injection to receive the player service for loose coupling
export const playerRouter = ({ playerService }: ServiceContainer): Router => {
  const router = Router();
  const handlers = createPlayerHandlers(playerService);

  // GET /players - Retrieves all players in the current season
  router.get('/', createHandler(handlers.getAllPlayers));

  // GET /players/:id - Retrieves a specific player by its ID
  router.get('/:id', validateRequest(PlayerIdParams), createHandler(handlers.getPlayerById));

  return router;
};
