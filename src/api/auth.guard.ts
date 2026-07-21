import { createHash, timingSafeEqual } from 'node:crypto';
import { Elysia } from 'elysia';

import { getAuthConfig } from '../utils/config';
import { logWarn } from '../utils/logger';
import { API_KEY_HEADER, shouldRequireApiKey } from './auth.policy';

export { API_KEY_HEADER, shouldRequireApiKey } from './auth.policy';

export type ApiKeyVerification = { status: 'ok' } | { status: 'unauthorized' };

function digestApiKey(apiKey: string): Buffer {
  return createHash('sha256').update(apiKey, 'utf8').digest();
}

export function matchesApiKeyHash(apiKey: string, expectedHashes: readonly string[]): boolean {
  const actual = digestApiKey(apiKey);
  let matched = false;

  // Compare every configured digest so the matching position is not observable.
  for (const expectedHash of expectedHashes) {
    const expected = Buffer.from(expectedHash, 'hex');
    if (expected.length === actual.length && timingSafeEqual(actual, expected)) {
      matched = true;
    }
  }

  return matched;
}

export async function verifyRequestApiKey(
  request: Request,
  expectedHashes: readonly string[] = getAuthConfig().DATA_API_KEY_HASHES,
): Promise<ApiKeyVerification> {
  const apiKey = request.headers.get(API_KEY_HEADER);
  if (!apiKey) {
    return { status: 'unauthorized' };
  }

  return matchesApiKeyHash(apiKey, expectedHashes) ? { status: 'ok' } : { status: 'unauthorized' };
}

export function apiKeyFailureHttpResponse(
  _verification: Exclude<ApiKeyVerification['status'], 'ok'>,
): { httpStatus: number; error: string } {
  return { httpStatus: 401, error: 'Unauthorized' };
}

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
