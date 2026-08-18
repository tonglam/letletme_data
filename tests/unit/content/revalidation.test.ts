import { describe, expect, test } from 'bun:test';

import { signRevalidationPayload } from '../../../src/content/publication/revalidation';

describe('publication revalidation envelope', () => {
  test('signs the exact timestamp, nonce and body tuple', () => {
    const input = {
      timestamp: '1776450000000',
      nonce: '00000000-0000-4000-8000-000000000001',
      body: '{"scopeKey":"week","revision":1}',
      secret: 'test-secret',
    };
    expect(signRevalidationPayload(input)).toBe(
      '246e71a4aac9b5d3a20c69cac42e7042d30f09d925b149ffd1a03349f6415d00',
    );
    expect(signRevalidationPayload({ ...input, body: '{}' })).not.toBe(
      signRevalidationPayload(input),
    );
  });
});
