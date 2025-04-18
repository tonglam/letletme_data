import { Router } from 'express';

// Import the main API router creator function
import { createRouter } from '../api/index';
// Import the ApplicationServices type
import { ApplicationServices } from './services';

// Function to set up the main application router
export const setupRoutes = (services: ApplicationServices): Router => {
  // Create the main API router, passing in the required services
  const apiRouter = createRouter(services);
  return apiRouter;
};
