/**
 * API routes configuration module
 * @module api/routes
 */

import { Router } from 'express';
import type { ServiceContainer } from '../../services';
import { eventRouter } from './events.route';

/**
 * Creates and configures the main API router with all domain routes
 * @returns Configured Express router instance
 */
export const createRouter = (services: ServiceContainer): Router => {
  // Create base router
  const router = Router();

  // Mount domain routes with services
  router.use('/events', eventRouter(services));
  return router;
};

// Export default router instance with services
export default (services: ServiceContainer): Router => createRouter(services);
