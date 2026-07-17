import { describe, expect, mock, test } from 'bun:test';
import { Elysia } from 'elysia';

import { shouldRequireApiKey } from '../../src/api/auth.policy';

type VerifyResult =
  | { valid: boolean; error: null }
  | { valid: boolean; error: { code: string; message: string } };

const verifyApiKey = mock(async (): Promise<VerifyResult> => ({ valid: true, error: null }));
const authHandlerPaths: string[] = [];

mock.module('../../src/auth', () => ({
  auth: {
    api: { verifyApiKey },
    handler: (request: Request) => {
      authHandlerPaths.push(new URL(request.url).pathname);
      return new Response('better-auth handler', { status: 404 });
    },
  },
}));

const { verifyRequestApiKey, apiKeyFailureHttpResponse, betterAuthPlugin } = await import(
  '../../src/api/auth.guard'
);

describe('mutation auth guard', () => {
  test('does not require API key for safe read methods', () => {
    expect(shouldRequireApiKey('GET', '/jobs/events-sync/trigger')).toBe(false);
    expect(shouldRequireApiKey('HEAD', '/events/sync')).toBe(false);
    expect(shouldRequireApiKey('OPTIONS', '/teams/sync')).toBe(false);
  });

  test('requires API key for mutation methods on app routes', () => {
    expect(shouldRequireApiKey('POST', '/jobs/events-sync/trigger')).toBe(true);
    expect(shouldRequireApiKey('DELETE', '/fixtures/cache')).toBe(true);
    expect(shouldRequireApiKey('PUT', '/tournaments/1/setup')).toBe(true);
    expect(shouldRequireApiKey('PATCH', '/players/sync')).toBe(true);
  });

  test('does not require API key for Better Auth routes', () => {
    expect(shouldRequireApiKey('POST', '/api/auth/api-key/verify')).toBe(false);
    expect(shouldRequireApiKey('POST', '/api/auth/sign-in/email')).toBe(false);
  });
});

describe('verifyRequestApiKey', () => {
  const requestWithKey = (key?: string) =>
    new Request('http://localhost/jobs/events-sync/trigger', {
      method: 'POST',
      headers: key ? { 'x-api-key': key } : {},
    });

  test('returns unauthorized when the API key header is missing', async () => {
    expect(await verifyRequestApiKey(requestWithKey())).toEqual({ status: 'unauthorized' });
  });

  test('returns ok for a valid key', async () => {
    verifyApiKey.mockImplementation(async () => ({ valid: true, error: null }));
    expect(await verifyRequestApiKey(requestWithKey('llm_good'))).toEqual({ status: 'ok' });
  });

  test('returns rate-limited when better-auth reports RATE_LIMITED', async () => {
    verifyApiKey.mockImplementation(async () => ({
      valid: false,
      error: { code: 'RATE_LIMITED', message: 'Too many requests' },
    }));
    expect(await verifyRequestApiKey(requestWithKey('llm_flooded'))).toEqual({
      status: 'rate-limited',
    });
  });

  test('returns unauthorized for an invalid key', async () => {
    verifyApiKey.mockImplementation(async () => ({
      valid: false,
      error: { code: 'KEY_NOT_FOUND', message: 'Invalid API key' },
    }));
    expect(await verifyRequestApiKey(requestWithKey('llm_bad'))).toEqual({
      status: 'unauthorized',
    });
  });

  test('returns unavailable when verification throws (auth infra down)', async () => {
    verifyApiKey.mockImplementation(async () => {
      throw new Error('connection refused');
    });
    expect(await verifyRequestApiKey(requestWithKey('llm_any'))).toEqual({
      status: 'unavailable',
    });
  });
});

describe('apiKeyFailureHttpResponse', () => {
  test('maps verification failures to HTTP responses', () => {
    expect(apiKeyFailureHttpResponse('unauthorized')).toEqual({
      httpStatus: 401,
      error: 'Unauthorized',
    });
    expect(apiKeyFailureHttpResponse('rate-limited')).toEqual({
      httpStatus: 429,
      error: 'Too many requests',
    });
    expect(apiKeyFailureHttpResponse('unavailable')).toEqual({
      httpStatus: 503,
      error: 'Authentication service unavailable',
    });
  });
});

describe('betterAuthPlugin mount', () => {
  function buildApp() {
    return new Elysia()
      .use(betterAuthPlugin)
      .get('/events/current', () => ({ ok: true }))
      .onError(({ code, set }) => {
        if (code === 'NOT_FOUND') {
          set.status = 404;
          return { success: false, error: 'Endpoint not found' };
        }
        return undefined;
      });
  }

  test('routes /api/auth/* to the auth handler with the full path intact', async () => {
    authHandlerPaths.length = 0;
    const app = buildApp();

    const response = await app.handle(
      new Request('http://localhost/api/auth/api-key/verify', { method: 'POST' }),
    );

    expect(await response.text()).toBe('better-auth handler');
    expect(authHandlerPaths).toEqual(['/api/auth/api-key/verify']);
  });

  test('leaves app routes untouched', async () => {
    const app = buildApp();
    const response = await app.handle(new Request('http://localhost/events/current'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  test('unknown app routes fall through to the app 404 JSON envelope', async () => {
    authHandlerPaths.length = 0;
    const app = buildApp();

    const response = await app.handle(new Request('http://localhost/not-a-route'));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ success: false, error: 'Endpoint not found' });
    expect(authHandlerPaths).toEqual([]);
  });
});
