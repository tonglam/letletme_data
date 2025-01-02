/**
 * HTTP Client Module
 * Entry point for the HTTP client infrastructure.
 * Exports core client functionality, interceptors, and type definitions.
 * @module infrastructure/http/client
 */

export { createHTTPClient } from './core';
export { requestInterceptor } from './request-interceptors';
export { createResponseInterceptor, handleAPIResponse } from './response';
export type { APIError, APIResponse, HTTPClient, HTTPClientContext, Headers } from './types';
export { calculateRetryDelay, createErrorFromStatus, delay } from './utils';
