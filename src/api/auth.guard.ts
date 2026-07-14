import { Elysia } from 'elysia';

import { auth } from '../auth';
import { getAuthConfig } from '../utils/config';
import { logWarn } from '../utils/logger';
import { API_KEY_HEADER, shouldRequireApiKey } from './auth.policy';

export { API_KEY_HEADER, shouldRequireApiKey } from './auth.policy';

export async function verifyRequestApiKey(request: Request): Promise<boolean> {
  const apiKey = request.headers.get(API_KEY_HEADER);
  if (!apiKey) {
    return false;
  }

  const result = await auth.api.verifyApiKey({
    body: { key: apiKey },
  });

  return result.valid;
}

export const betterAuthPlugin = new Elysia({ name: 'better-auth' }).mount(auth.handler);

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

    const authorized = await verifyRequestApiKey(request);
    if (!authorized) {
      set.status = 401;
      return { success: false, error: 'Unauthorized' };
    }

    return undefined;
  });
}
