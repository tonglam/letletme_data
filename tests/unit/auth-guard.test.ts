import { describe, expect, test } from 'bun:test';

import { shouldRequireApiKey } from '../../src/api/auth.policy';

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
