// Middleware Module Exports
// Central export point for all middleware functions used in the API layer.
// Provides access to core middleware functions including security, validation,
// error handling, and request processing utilities.

export {
  addSecurityHeaders,
  createHandler,
  handleError,
  toNotFoundError,
  validateRequest,
} from './core';
