import { afterEach, describe, expect, test } from 'bun:test';

import {
  getHttpStatusFromError,
  getPublicErrorMessage,
  NotFoundError,
  ValidationError,
} from '../../src/utils/errors';

const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv;
});

describe('getPublicErrorMessage', () => {
  test('hides 5xx internals behind a generic message in production', () => {
    process.env.NODE_ENV = 'production';
    const error = new Error('connect ECONNREFUSED 10.0.0.5:5432');

    expect(getPublicErrorMessage(error, 500)).toBe('Internal server error');
  });

  test('keeps client-actionable 4xx messages in production', () => {
    process.env.NODE_ENV = 'production';
    const error = new ValidationError('eventId must be a positive integer');

    expect(getPublicErrorMessage(error, 400)).toBe('eventId must be a positive integer');
  });

  test('exposes real messages outside production', () => {
    process.env.NODE_ENV = 'development';
    const error = new Error('connect ECONNREFUSED 10.0.0.5:5432');

    expect(getPublicErrorMessage(error, 500)).toBe('connect ECONNREFUSED 10.0.0.5:5432');
  });
});

describe('getHttpStatusFromError', () => {
  test('maps domain errors to their HTTP status and defaults to 500', () => {
    expect(getHttpStatusFromError(new ValidationError('bad input'))).toBe(400);
    expect(getHttpStatusFromError(new NotFoundError('missing'))).toBe(404);
    expect(getHttpStatusFromError(new Error('boom'))).toBe(500);
  });
});
