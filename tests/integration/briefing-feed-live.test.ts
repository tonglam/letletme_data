import { assertIntegrationEnv } from './helpers/env-guard';

assertIntegrationEnv();

import { expect, test } from 'bun:test';

import { loadBriefingManifest } from '../../src/content/acquisition/acquisition-manifest';
import { getAcquisitionProfile } from '../../src/content/acquisition/acquisition-profiles';
import { runFeedAdapter } from '../../src/content/acquisition/feed-adapter';

const liveTest = process.env.RUN_BRIEFING_LIVE_PROBES === '1' ? test : test.skip;

liveTest(
  'polls every configured public feed endpoint with bounded bootstrap policy',
  async () => {
    const bundle = await loadBriefingManifest();
    const endpoints = bundle.sources.entities.flatMap((entity) =>
      entity.endpoints
        .filter(
          (endpoint) =>
            endpoint.enabled &&
            (endpoint.adapterKind === 'RSS_ATOM' ||
              endpoint.adapterKind === 'PODCAST_FEED' ||
              endpoint.adapterKind === 'YOUTUBE_CHANNEL'),
        )
        .map((endpoint) => ({ sourceKey: entity.sourceKey, endpoint })),
    );
    expect(endpoints).toHaveLength(21);
    const cutoffAt = new Date();
    const results = await Promise.all(
      endpoints.map(async ({ sourceKey, endpoint }) => {
        const profile = getAcquisitionProfile(endpoint.profileKey);
        if (!profile) throw new Error(`Missing profile ${endpoint.profileKey}`);
        const result = await runFeedAdapter({
          endpointKey: endpoint.endpointKey,
          adapterKind: endpoint.adapterKind as 'RSS_ATOM' | 'PODCAST_FEED' | 'YOUTUBE_CHANNEL',
          profileKey: endpoint.profileKey,
          locator: endpoint.locator as Record<string, string>,
          bootstrapProfile: profile,
          bootstrapCutoffAt: cutoffAt,
        });
        return {
          sourceKey,
          endpointKey: endpoint.endpointKey,
          adapterKind: endpoint.adapterKind,
          stateHint: result.stateHint,
          status: result.transport.status,
          responseBytes: result.transport.responseBytes,
          bodyHash: result.transport.bodyHash,
          itemCount: result.batch.items.length,
          rejectedCount: result.rejections.length,
          bootstrapSkipped: result.bootstrapMetrics?.skippedCount ?? 0,
          newestPublishedAt: result.batch.items[0]?.publishedAt ?? null,
          newestExternalItemId: result.batch.items[0]?.externalItemId ?? null,
          newestTitleLength: result.batch.items[0]?.title?.length ?? 0,
          newestBodyAvailability: result.batch.items[0]?.body.availability ?? null,
          hasEtag: Boolean(result.transport.validator.etag),
          hasLastModified: Boolean(result.transport.validator.lastModified),
          cacheNotBefore: result.transport.cacheNotBefore,
        };
      }),
    );

    for (const result of results) {
      expect(result.status).toBe(200);
      expect(result.itemCount).toBeGreaterThan(0);
      expect(result.bodyHash).toMatch(/^[0-9a-f]{64}$/);
    }
    console.warn(`[briefing-feed-live] ${JSON.stringify(results)}`);
  },
  120_000,
);
