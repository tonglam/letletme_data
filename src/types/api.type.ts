/**
 * API Types Module
 *
 * Core type definitions for API layer including request/response structures,
 * pagination, sorting, and metadata interfaces. This module serves as the central
 * location for all API-related type definitions and validation codecs.
 *
 * @module types/api
 * @category API
 */

import { NextFunction, Request, Response } from 'express';
import type { Either } from 'fp-ts/Either';
import type { TaskEither } from 'fp-ts/TaskEither';
import * as t from 'io-ts';
import { Event } from './domain/events.type';
import { APIError } from './errors.type';

/**
 * Request validation codec for event ID parameters
 * @description Validates the presence and format of event ID in request parameters
 */
export const EventIdParams = t.type({
  params: t.type({
    id: t.string,
  }),
});

/**
 * Generic API success response wrapper
 * @template T - The type of data being returned
 * @property {string} status - Always 'success' for successful responses
 * @property {T} data - The actual response data
 */
export interface APIResponse<T> {
  readonly status: 'success';
  readonly data: T;
}

/**
 * Extended Express Request type with request ID
 * @extends Request
 * @property {string} id - Unique identifier for the request
 */
export type ApiRequest = Request & { id: string };

/**
 * Metadata included in API responses for monitoring and debugging
 * @property {number} timestamp - Unix timestamp of when the response was generated
 * @property {string} path - The API endpoint path that was accessed
 * @property {number} [duration] - Time taken to process the request in milliseconds
 */
export interface ResponseMetadata {
  readonly timestamp: number;
  readonly path: string;
  readonly duration?: number;
}

/**
 * Standard pagination parameters for list endpoints
 * @property {number} [page] - The page number to retrieve
 * @property {number} [limit] - Number of items per page
 * @property {number} [offset] - Number of items to skip
 */
export interface PaginationParams {
  readonly page?: number;
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * Standard sorting parameters for list endpoints
 * @property {string} [sortBy] - Field name to sort by
 * @property {'asc' | 'desc'} [sortOrder] - Sort direction
 */
export interface SortParams {
  readonly sortBy?: string;
  readonly sortOrder?: 'asc' | 'desc';
}

/**
 * Type alias for async operations that may fail
 * @template E - Error type
 * @template A - Success type
 */
export type AsyncEither<E, A> = Promise<Either<E, A>>;

/**
 * Type for async request handlers that may fail
 * @template T - The success response type
 */
export type AsyncHandler<T> = (req: ApiRequest) => AsyncEither<APIError, T>;

/**
 * Standard API response format
 * @template T - The type of data being returned
 * @property {T} data - The response payload
 */
export interface APIResponseData<T> {
  readonly data: T;
}

/**
 * Generic type for handling nullable values
 * @template T - The type of value being handled
 */
export type NullableHandler<T> = (message: string) => (value: T | null) => Either<APIError, T>;

/**
 * Type for handling nullable event responses
 * @extends NullableHandler<Event>
 */
export type NullableEventHandler = NullableHandler<Event>;

/**
 * Type for event handler responses defining all available event operations
 * @property {function} getAllEvents - Retrieves all events
 * @property {function} getCurrentEvent - Gets the current active event
 * @property {function} getNextEvent - Gets the next scheduled event
 * @property {function} getEventById - Retrieves a specific event by ID
 */
export interface EventHandlerResponse {
  readonly getAllEvents: () => TaskEither<APIError, Event[]>;
  readonly getCurrentEvent: () => TaskEither<APIError, Event>;
  readonly getNextEvent: () => TaskEither<APIError, Event>;
  readonly getEventById: (req: Request) => TaskEither<APIError, Event>;
}

/**
 * Type for async middleware handlers
 * @template T - The type of data being processed by the middleware
 */
export type AsyncMiddlewareHandler<T> = (req: Request) => TaskEither<APIError, T>;

/**
 * Type for Express middleware functions
 * @callback Middleware
 */
export type Middleware = (req: Request, res: Response, next: NextFunction) => void | Promise<void>;

/**
 * Type for error handler middleware
 * @callback ErrorHandler
 */
export type ErrorHandler = (error: Error, req: Request, res: Response, next: NextFunction) => void;

/**
 * Security headers configuration type
 * @property {string} X-Content-Type-Options - Prevents MIME type sniffing
 * @property {string} X-Frame-Options - Controls frame embedding
 * @property {string} X-XSS-Protection - Enables XSS filtering
 * @property {string} Strict-Transport-Security - Enforces HTTPS
 */
export type SecurityHeaders = {
  readonly 'X-Content-Type-Options': string;
  readonly 'X-Frame-Options': string;
  readonly 'X-XSS-Protection': string;
  readonly 'Strict-Transport-Security': string;
};
