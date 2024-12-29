/**
 * API Types Module
 *
 * Core type definitions for API layer including request/response structures,
 * pagination, sorting, and metadata interfaces. This module serves as the central
 * location for all API-related type definitions and validation codecs.
 *
 * @packageDocumentation
 * @module api/types
 * @category API
 */

import { NextFunction, Request, Response } from 'express';
import type { Either } from 'fp-ts/Either';
import type { TaskEither } from 'fp-ts/TaskEither';
import * as t from 'io-ts';
import { Event } from '../types/domain/events.type';
import { APIError } from '../types/errors.type';

/**
 * Request validation codec for event ID parameters.
 * Validates the presence and format of event ID in request parameters.
 *
 * @since 1.0.0
 */
export const EventIdParams = t.type({
  params: t.type({
    id: t.string,
  }),
});

/**
 * Generic API success response wrapper.
 *
 * @typeParam T - The type of data being returned
 * @property status - Always 'success' for successful responses
 * @property data - The actual response data
 */
export interface APIResponse<T> {
  readonly status: 'success';
  readonly data: T;
}

/**
 * Extended Express Request type with request ID.
 *
 * @extends Request
 * @property id - Unique identifier for the request
 */
export type ApiRequest = Request & { id: string };

/**
 * Metadata included in API responses for monitoring and debugging.
 *
 * @property timestamp - Unix timestamp of when the response was generated
 * @property path - The API endpoint path that was accessed
 * @property duration - Time taken to process the request in milliseconds
 */
export interface ResponseMetadata {
  readonly timestamp: number;
  readonly path: string;
  readonly duration?: number;
}

/**
 * Standard pagination parameters for list endpoints.
 *
 * @property page - The page number to retrieve (1-based)
 * @property limit - Number of items per page
 * @property offset - Number of items to skip
 */
export interface PaginationParams {
  readonly page?: number;
  readonly limit?: number;
  readonly offset?: number;
}

/**
 * Standard sorting parameters for list endpoints.
 *
 * @property sortBy - Field name to sort by
 * @property sortOrder - Sort direction ('asc' or 'desc')
 */
export interface SortParams {
  readonly sortBy?: string;
  readonly sortOrder?: 'asc' | 'desc';
}

/**
 * Type alias for asynchronous operations that may fail.
 *
 * @typeParam E - Error type
 * @typeParam A - Success type
 */
export type AsyncEither<E, A> = Promise<Either<E, A>>;

/**
 * Type for asynchronous request handlers that may fail.
 *
 * @typeParam T - The success response type
 */
export type AsyncHandler<T> = (req: ApiRequest) => AsyncEither<APIError, T>;

/**
 * Standard API response format.
 *
 * @typeParam T - The type of data being returned
 * @property data - The response payload
 */
export interface APIResponseData<T> {
  readonly data: T;
}

/**
 * Generic type for handling nullable values.
 *
 * @typeParam T - The type of value being handled
 */
export type NullableHandler<T> = (message: string) => (value: T | null) => Either<APIError, T>;

/**
 * Type for handling nullable event responses.
 *
 * @extends NullableHandler<Event>
 */
export type NullableEventHandler = NullableHandler<Event>;

/**
 * Type for event handler responses defining all available event operations.
 *
 * @property getAllEvents - Retrieves all events
 * @property getCurrentEvent - Gets the current active event
 * @property getNextEvent - Gets the next scheduled event
 * @property getEventById - Retrieves a specific event by ID
 */
export interface EventHandlerResponse {
  readonly getAllEvents: () => TaskEither<APIError, Event[]>;
  readonly getCurrentEvent: () => TaskEither<APIError, Event>;
  readonly getNextEvent: () => TaskEither<APIError, Event>;
  readonly getEventById: (req: Request) => TaskEither<APIError, Event>;
}

/**
 * Type for asynchronous middleware handlers.
 *
 * @typeParam T - The type of data being processed by the middleware
 */
export type AsyncMiddlewareHandler<T> = (req: Request) => TaskEither<APIError, T>;

/**
 * Express middleware function type.
 */
export type Middleware = (req: Request, res: Response, next: NextFunction) => void | Promise<void>;

/**
 * Express error handler middleware type.
 */
export type ErrorHandler = (error: Error, req: Request, res: Response, next: NextFunction) => void;

/**
 * Security headers configuration type.
 *
 * @property X-Content-Type-Options - Prevents MIME type sniffing
 * @property X-Frame-Options - Controls frame embedding
 * @property X-XSS-Protection - Enables XSS filtering
 * @property Strict-Transport-Security - Enforces HTTPS
 */
export type SecurityHeaders = {
  readonly 'X-Content-Type-Options': string;
  readonly 'X-Frame-Options': string;
  readonly 'X-XSS-Protection': string;
  readonly 'Strict-Transport-Security': string;
};
