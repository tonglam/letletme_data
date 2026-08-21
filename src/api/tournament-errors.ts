import { ZodError } from 'zod';

import { getHttpStatusFromError, getPublicErrorMessage } from '../utils/errors';

/**
 * Stable, user-safe error codes for the tournament command surface.
 *
 * Internal exception codes are deliberately mapped here instead of being
 * forwarded directly. This keeps the API useful to the Web client without
 * making database, provider, or infrastructure diagnostics public.
 */
export type PublicTournamentErrorCode =
  | 'TOURNAMENT_REQUEST_INVALID'
  | 'TOURNAMENT_AUTH_REQUIRED'
  | 'TOURNAMENT_FORBIDDEN'
  | 'TOURNAMENT_NOT_FOUND'
  | 'TOURNAMENT_CONFLICT'
  | 'TOURNAMENT_RATE_LIMITED'
  | 'TOURNAMENT_TIMEOUT'
  | 'TOURNAMENT_UNAVAILABLE'
  | 'TOURNAMENT_NAME_EXISTS'
  | 'TOURNAMENT_CREATE_IN_PROGRESS'
  | 'TOURNAMENT_PREVIEW_EXPIRED'
  | 'TOURNAMENT_ADMIN_NOT_PARTICIPANT'
  | 'TOURNAMENT_PARTICIPANTS_TOO_FEW'
  | 'TOURNAMENT_INVALID_SCHEDULE'
  | 'TOURNAMENT_INVALID_FORMAT'
  | 'TOURNAMENT_INVALID_LEAGUE_URL'
  | 'TOURNAMENT_LEAGUE_EMPTY'
  | 'TOURNAMENT_LEAGUE_UNAVAILABLE';

const INTERNAL_TO_PUBLIC_CODE: Readonly<Record<string, PublicTournamentErrorCode>> = {
  PREVIEW_EXPIRED: 'TOURNAMENT_PREVIEW_EXPIRED',
  PREVIEW_PAYLOAD_MISMATCH: 'TOURNAMENT_PREVIEW_EXPIRED',
  TOURNAMENT_ADMIN_NOT_PARTICIPANT: 'TOURNAMENT_ADMIN_NOT_PARTICIPANT',
  TOURNAMENT_CREATE_IN_PROGRESS: 'TOURNAMENT_CREATE_IN_PROGRESS',
  TOURNAMENT_GROUP_GAMEWEEKS_INVALID: 'TOURNAMENT_INVALID_SCHEDULE',
  TOURNAMENT_H2H_WINDOW_INVALID: 'TOURNAMENT_INVALID_SCHEDULE',
  TOURNAMENT_INFO_CREATE_ERROR: 'TOURNAMENT_UNAVAILABLE',
  TOURNAMENT_KNOCKOUT_EXCEEDS_GW38: 'TOURNAMENT_INVALID_SCHEDULE',
  TOURNAMENT_KNOCKOUT_INVALID: 'TOURNAMENT_INVALID_FORMAT',
  TOURNAMENT_LEAGUE_EMPTY: 'TOURNAMENT_LEAGUE_EMPTY',
  TOURNAMENT_LEAGUE_ID_INVALID: 'TOURNAMENT_INVALID_LEAGUE_URL',
  TOURNAMENT_LEAGUE_PAGINATION_LIMIT: 'TOURNAMENT_LEAGUE_UNAVAILABLE',
  TOURNAMENT_LEAGUE_PAGINATION_STALLED: 'TOURNAMENT_LEAGUE_UNAVAILABLE',
  TOURNAMENT_LEAGUE_URL_FORMAT_INVALID: 'TOURNAMENT_INVALID_LEAGUE_URL',
  TOURNAMENT_LEAGUE_URL_HOST_INVALID: 'TOURNAMENT_INVALID_LEAGUE_URL',
  TOURNAMENT_LEAGUE_URL_INVALID: 'TOURNAMENT_INVALID_LEAGUE_URL',
  TOURNAMENT_NAME_EXISTS: 'TOURNAMENT_NAME_EXISTS',
  TOURNAMENT_PARTICIPANTS_TOO_FEW: 'TOURNAMENT_PARTICIPANTS_TOO_FEW',
  TOURNAMENT_QUALIFIERS_REQUIRED: 'TOURNAMENT_INVALID_FORMAT',
  TOURNAMENT_QUALIFY_TOTAL_EXCEEDS: 'TOURNAMENT_INVALID_FORMAT',
  TOURNAMENT_CREATE_INVALID: 'TOURNAMENT_REQUEST_INVALID',
};

function rawErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null;
  return typeof error.code === 'string' ? error.code : null;
}

export function getPublicTournamentErrorCode(
  error: unknown,
  status = getHttpStatusFromError(error),
): PublicTournamentErrorCode {
  const internalCode = rawErrorCode(error);
  const mapped = internalCode ? INTERNAL_TO_PUBLIC_CODE[internalCode] : undefined;
  if (mapped) return mapped;
  if (error instanceof ZodError || status === 400) return 'TOURNAMENT_REQUEST_INVALID';
  if (status === 401) return 'TOURNAMENT_AUTH_REQUIRED';
  if (status === 403) return 'TOURNAMENT_FORBIDDEN';
  if (status === 404) return 'TOURNAMENT_NOT_FOUND';
  if (status === 409) return 'TOURNAMENT_CONFLICT';
  if (status === 429) return 'TOURNAMENT_RATE_LIMITED';
  if (status === 504) return 'TOURNAMENT_TIMEOUT';
  return 'TOURNAMENT_UNAVAILABLE';
}

export function mapTournamentErrorToResponse(error: unknown): {
  status: number;
  message: string;
  code: PublicTournamentErrorCode;
} {
  const status = error instanceof ZodError ? 400 : getHttpStatusFromError(error);
  return {
    status,
    message:
      error instanceof ZodError
        ? error.issues.map((issue) => issue.message).join('; ') || 'Invalid request payload.'
        : getPublicErrorMessage(error, status),
    code: getPublicTournamentErrorCode(error, status),
  };
}
