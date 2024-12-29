/**
 * API Module Entry Point
 *
 * Main entry point for the API layer that configures and assembles all routes
 * and their dependencies. Provides a factory function to create a configured
 * Express router with all domain routes mounted and services injected.
 *
 * @module api
 * @category API
 */

import { Router } from 'express';
import type { ServiceContainer } from '../services';
import { eventRouter } from './routes/events.route';

/**
 * Creates and configures the main API router with all domain routes
 * @param {ServiceContainer} services - Container with all required services
 * @returns {Router} Configured Express router instance with all routes mounted
 */
export const createRouter = (services: ServiceContainer): Router => {
  // Create base router
  const router = Router();

  // Mount domain routes with services
  router.use('/events', eventRouter(services));

  return router;
};

/**
 * Default export providing a configured router instance
 * @param {ServiceContainer} services - Container with all required services
 * @returns {Router} Configured Express router instance
 */
export default (services: ServiceContainer): Router => createRouter(services);
