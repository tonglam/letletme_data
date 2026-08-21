import { afterEach, describe, expect, test } from 'bun:test';
import { z } from 'zod';

import {
  getPublicTournamentErrorCode,
  mapTournamentErrorToResponse,
} from '../../src/api/tournament-errors';
import { ConflictError, ValidationError } from '../../src/utils/errors';

const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv;
});

describe('public tournament error contract', () => {
  test('maps the admin membership failure to a safe actionable code', () => {
    const error = new ValidationError(
      'Admin ID must be included in the tournament participant set.',
      'TOURNAMENT_ADMIN_NOT_PARTICIPANT',
    );

    expect(mapTournamentErrorToResponse(error)).toMatchObject({
      status: 400,
      code: 'TOURNAMENT_ADMIN_NOT_PARTICIPANT',
    });
  });

  test('maps conflicts without forwarding unknown internal codes', () => {
    expect(
      getPublicTournamentErrorCode(
        new ConflictError('private database detail', 'DATABASE_UNIQUE_SECRET'),
      ),
    ).toBe('TOURNAMENT_CONFLICT');
  });

  test('keeps schema failures as safe 400 responses', () => {
    const error = z.object({ name: z.string().min(3) }).safeParse({ name: '' });
    if (error.success) throw new Error('fixture should fail');

    expect(mapTournamentErrorToResponse(error.error)).toMatchObject({
      status: 400,
      code: 'TOURNAMENT_REQUEST_INVALID',
      message: 'String must contain at least 3 character(s)',
    });
  });

  test('collapses unexpected production failures', () => {
    process.env.NODE_ENV = 'production';
    expect(mapTournamentErrorToResponse(new Error('postgres://private'))).toEqual({
      status: 500,
      message: 'Internal server error',
      code: 'TOURNAMENT_UNAVAILABLE',
    });
  });
});
