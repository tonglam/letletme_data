import { createHash } from 'node:crypto';

import { describe, expect, test } from 'bun:test';

import {
  apiKeyFailureHttpResponse,
  matchesApiKeyHash,
  verifyRequestApiKey,
} from '../../src/api/auth.guard';
import { shouldRequireApiKey } from '../../src/api/auth.policy';

const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

describe('mutation auth policy', () => {
  test('does not require an API key for safe read methods', () => {
    expect(shouldRequireApiKey('GET', '/events/current')).toBe(false);
    expect(shouldRequireApiKey('HEAD', '/events/current')).toBe(false);
    expect(shouldRequireApiKey('OPTIONS', '/events/current')).toBe(false);
  });

  test('requires an API key for every mutation route', () => {
    expect(shouldRequireApiKey('POST', '/jobs/events-sync/trigger')).toBe(true);
    expect(shouldRequireApiKey('DELETE', '/fixtures/cache')).toBe(true);
    expect(shouldRequireApiKey('PUT', '/tournaments/1/setup')).toBe(true);
    expect(shouldRequireApiKey('PATCH', '/players/sync')).toBe(true);
    expect(shouldRequireApiKey('POST', '/api/auth/api-key/verify')).toBe(true);
  });
});

describe('service API key verification', () => {
  const secret = 'test-service-key-with-enough-entropy';
  const expectedHashes = [hash('rotated-out-key'), hash(secret)];

  const requestWithKey = (key?: string) =>
    new Request('http://localhost/jobs/events-sync/trigger', {
      method: 'POST',
      headers: key ? { 'x-api-key': key } : {},
    });

  test('matches SHA-256 digests and supports key rotation', () => {
    expect(matchesApiKeyHash(secret, expectedHashes)).toBe(true);
    expect(matchesApiKeyHash('wrong-key', expectedHashes)).toBe(false);
  });

  test('rejects a missing or invalid key', async () => {
    expect(await verifyRequestApiKey(requestWithKey(), expectedHashes)).toEqual({
      status: 'unauthorized',
    });
    expect(await verifyRequestApiKey(requestWithKey('wrong-key'), expectedHashes)).toEqual({
      status: 'unauthorized',
    });
  });

  test('accepts a valid key without a database dependency', async () => {
    expect(await verifyRequestApiKey(requestWithKey(secret), expectedHashes)).toEqual({
      status: 'ok',
    });
  });

  test('maps failures to a non-revealing response', () => {
    expect(apiKeyFailureHttpResponse('unauthorized')).toEqual({
      httpStatus: 401,
      error: 'Unauthorized',
    });
  });
});
