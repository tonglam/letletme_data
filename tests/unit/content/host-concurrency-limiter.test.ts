import { describe, expect, test } from 'bun:test';

import {
  formalHttpHostKey,
  HostConcurrencyLimiter,
} from '../../../src/content/acquisition/host-concurrency-limiter';
import { parseFormalRunRequestV1 } from '../../../src/content/acquisition/formal-run-contract';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('formal HTTP host concurrency', () => {
  test('caps one host while allowing a different host to proceed', async () => {
    const limiter = new HostConcurrencyLimiter(2);
    const first = deferred();
    const second = deferred();
    let sameHostActive = 0;
    let sameHostMaximum = 0;
    let thirdStarted = false;
    let otherHostStarted = false;
    const run = (gate: ReturnType<typeof deferred>) =>
      limiter.withPermit('https://feeds.example.com', async () => {
        sameHostActive += 1;
        sameHostMaximum = Math.max(sameHostMaximum, sameHostActive);
        await gate.promise;
        sameHostActive -= 1;
      });
    const firstRun = run(first);
    const secondRun = run(second);
    const thirdRun = limiter.withPermit('https://feeds.example.com', async () => {
      thirdStarted = true;
    });
    const otherRun = limiter.withPermit('https://other.example.com', async () => {
      otherHostStarted = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(sameHostActive).toBe(2);
    expect(thirdStarted).toBe(false);
    expect(otherHostStarted).toBe(true);
    first.resolve();
    await firstRun;
    await thirdRun;
    second.resolve();
    await Promise.all([secondRun, otherRun]);
    expect(sameHostMaximum).toBe(2);
  });

  test('releases a permit when an operation fails', async () => {
    const limiter = new HostConcurrencyLimiter(1);
    await expect(
      limiter.withPermit('https://example.com', async () => {
        throw new Error('synthetic failure');
      }),
    ).rejects.toThrow('synthetic failure');
    expect(await limiter.withPermit('https://example.com', async () => 'released')).toBe(
      'released',
    );
  });

  test('maps every formal HTTP request to its upstream origin', () => {
    const endpoint = {
      endpointId: '00000000-0000-4000-8000-000000000001',
      endpointKey: 'example-feed',
      sourceId: '00000000-0000-4000-8000-000000000002',
      sourceKey: 'example',
      adapterKind: 'RSS_ATOM' as const,
      profileKey: 'rss-standard-v1',
      locator: { url: 'https://Feeds.Example.com/news.xml' },
      stableExternalId: null,
      rightsPolicy: {},
    };
    const common = {
      schemaVersion: 1 as const,
      phase: 'NORMAL' as const,
      profileKey: 'rss-standard-v1',
      profileRevision: 1,
      windowStart: '2026-08-22T00:00:00.000Z',
      windowEnd: '2026-08-22T00:00:00.000Z',
    };
    const feed = parseFormalRunRequestV1({
      ...common,
      jobKind: 'FEED_POLL',
      adapterKind: 'RSS_ATOM',
      endpoint,
      validator: { etag: null, lastModified: null },
      bootstrap: {
        enabled: false,
        cutoffAt: common.windowEnd,
        lookbackMinutes: 60,
        maxItems: 10,
        maxContentJobs: 2,
      },
    });
    expect(formalHttpHostKey(feed)).toBe('https://feeds.example.com');

    const article = parseFormalRunRequestV1({
      ...common,
      profileKey: 'article-readability-v1',
      jobKind: 'ARTICLE_FETCH',
      adapterKind: 'ARTICLE_HTTP',
      endpoint,
      discoveryItem: {
        endpointKey: endpoint.endpointKey,
        externalItemId: 'article-1',
        canonicalUrl: 'https://feeds.example.com/articles/1',
        sourceUrl: 'https://feeds.example.com/articles/1',
        linkAvailability: 'DIRECT',
        publishedAt: common.windowEnd,
        updatedAt: null,
        title: 'Article',
        authorExternalId: null,
        contentKind: 'ARTICLE',
        body: { availability: 'METADATA_ONLY', text: null },
        media: [],
        transcript: {
          status: 'NOT_APPLICABLE',
          language: null,
          trackKind: null,
          providerRevision: null,
          segments: [],
        },
      },
      allowedOrigins: ['https://feeds.example.com'],
      validator: { etag: null, lastModified: null },
    });
    expect(formalHttpHostKey(article)).toBe('https://feeds.example.com');
  });
});
