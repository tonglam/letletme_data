import { describe, expect, test } from 'bun:test';

import { articleSourceMatchesEndpointOrigin } from '../../../src/content/acquisition/triggered-work-planner';

describe('triggered work planner provenance', () => {
  test('keeps article retries on the persisted feed origin', () => {
    expect(
      articleSourceMatchesEndpointOrigin({
        locator: { url: 'https://example.com/feed.xml' },
        sourceUrl: 'https://example.com/articles/gw-1',
      }),
    ).toBe(true);
    expect(
      articleSourceMatchesEndpointOrigin({
        locator: { url: 'https://example.com/feed.xml' },
        sourceUrl: 'https://external.invalid/articles/gw-1',
      }),
    ).toBe(false);
    expect(
      articleSourceMatchesEndpointOrigin({
        locator: { channelId: 'not-a-feed' },
        sourceUrl: 'https://example.com/articles/gw-1',
      }),
    ).toBe(false);
  });
});
