import { Elysia } from 'elysia';

import { auth } from '../auth';
import { getAuthConfig } from '../utils/config';
import { logError, logWarn } from '../utils/logger';
import { API_KEY_HEADER, shouldRequireApiKey } from './auth.policy';

export { API_KEY_HEADER, shouldRequireApiKey } from './auth.policy';

export type ApiKeyVerification =
  | { status: 'ok' }
  | { status: 'unauthorized' }
  | { status: 'rate-limited' }
  | { status: 'unavailable' };

export async function verifyRequestApiKey(request: Request): Promise<ApiKeyVerification> {
  const apiKey = request.headers.get(API_KEY_HEADER);
  if (!apiKey) {
    return { status: 'unauthorized' };
  }

  try {
    const result = await auth.api.verifyApiKey({
      body: { key: apiKey },
    });

    if (result.valid) {
      return { status: 'ok' };
    }
    if (result.error?.code === 'RATE_LIMITED') {
      return { status: 'rate-limited' };
    }
    return { status: 'unauthorized' };
  } catch (error) {
    logError('API key verification failed (auth infrastructure)', error);
    return { status: 'unavailable' };
  }
}

export function apiKeyFailureHttpResponse(
  verification: Exclude<ApiKeyVerification['status'], 'ok'>,
): { httpStatus: number; error: string } {
  switch (verification) {
    case 'rate-limited':
      return { httpStatus: 429, error: 'Too many requests' };
    case 'unavailable':
      return { httpStatus: 503, error: 'Authentication service unavailable' };
    default:
      return { httpStatus: 401, error: 'Unauthorized' };
  }
}

// Mount under /api/auth so only auth routes reach the Better Auth handler; unmatched
// app routes fall through to the app's own 404 JSON envelope. The mounted fetch
// handler receives the original (unstripped) path, which Better Auth expects.
export const betterAuthPlugin = new Elysia({ name: 'better-auth', prefix: '/api/auth' }).mount(
  auth.handler,
);

export function registerMutationAuthGuard(app: Elysia) {
  const { ENABLE_AUTH } = getAuthConfig();

  if (!ENABLE_AUTH) {
    logWarn('Mutation auth disabled (ENABLE_AUTH=false); POST/PUT/PATCH/DELETE routes are public');
    return app;
  }

  return app.onBeforeHandle(async ({ request, set, path }) => {
    if (!shouldRequireApiKey(request.method, path)) {
      return undefined;
    }

    const verification = await verifyRequestApiKey(request);
    if (verification.status !== 'ok') {
      const { httpStatus, error } = apiKeyFailureHttpResponse(verification.status);
      set.status = httpStatus;
      return { success: false, error };
    }

    return undefined;
  });
}
