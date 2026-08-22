import { describe, expect, test } from 'bun:test';

import { contentAPI } from '../../../src/content/api/content.api';

describe('manifest-managed Briefing source registry API', () => {
  for (const path of [
    '/content/sources',
    '/content/sources/groups',
    '/content/sources/groups/core/members/550e8400-e29b-41d4-a716-446655440000',
  ]) {
    test(`returns the stable 410 contract for ${path}`, async () => {
      const response = await contentAPI.handle(
        new Request(`http://localhost${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        }),
      );
      expect(response.status).toBe(410);
      expect(await response.json()).toEqual({
        success: false,
        code: 'SOURCE_REGISTRY_MANIFEST_MANAGED',
        error: 'Briefing source registry is managed by the versioned manifest',
      });
    });
  }
});
