import { describe, expect, test } from 'bun:test';

import {
  ArticleAdapterError,
  articleHttpTraces,
  robotsAllows,
  runArticleAdapter,
} from '../../../src/content/acquisition/article-adapter';
import type { AcquisitionItemV1 } from '../../../src/content/acquisition/acquisition-contract';
import type { PublicFetch } from '../../../src/content/acquisition/http-transport';

const discoveryItem: AcquisitionItemV1 = {
  endpointKey: 'publication-rss',
  externalItemId: 'stable-guid-1',
  canonicalUrl: 'https://example.com/articles/fpl-guide',
  sourceUrl: 'https://example.com/articles/fpl-guide',
  linkAvailability: 'DIRECT',
  publishedAt: '2026-08-20T10:00:00.000Z',
  updatedAt: null,
  title: 'Feed title',
  authorExternalId: 'Feed Author',
  contentKind: 'ARTICLE',
  body: { availability: 'EXCERPT', text: 'Feed excerpt.' },
  media: [],
  transcript: {
    status: 'NOT_APPLICABLE',
    language: null,
    trackKind: null,
    providerRevision: null,
    segments: [],
  },
};

function articleHtml(canonical = 'https://example.com/articles/fpl-guide'): string {
  const paragraphs = Array.from(
    { length: 20 },
    (_, index) =>
      `<p>Paragraph ${index} explains a concrete Fantasy Premier League decision with enough useful detail for deterministic extraction.</p>`,
  ).join('');
  return `<!doctype html>
    <html><head>
      <title>Full FPL Structure Guide</title>
      <link rel="canonical" href="${canonical}">
      <meta property="article:published_time" content="2026-08-20T10:00:00+00:00">
      <meta property="article:modified_time" content="2026-08-20T11:00:00+00:00">
      <meta name="author" content="Article Author">
    </head><body>
      <nav>Home Teams Players Fixtures Contact About</nav>
      <article><h1>Full FPL Structure Guide</h1>${paragraphs}</article>
    </body></html>`;
}

function mockFetch(input: { robots?: string; article?: Response }): PublicFetch {
  return async (request) => {
    const url = String(request);
    if (url.endsWith('/robots.txt')) {
      return new Response(input.robots ?? 'User-agent: *\nDisallow:\n', {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
    return (
      input.article ??
      new Response(articleHtml(), {
        status: 200,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          etag: '"article-v1"',
        },
      })
    );
  };
}

describe('robots policy', () => {
  test('uses the longest matching allow/disallow rule and exact agent group', () => {
    const robotsText = `
      User-agent: *
      Disallow: /articles/
      Allow: /articles/public/

      User-agent: LetLetMe-Briefing-Acquisition
      Disallow: /private/
    `;
    expect(
      robotsAllows({ robotsText, targetUrl: 'https://example.com/articles/private-story' }),
    ).toBe(true);
    expect(robotsAllows({ robotsText, targetUrl: 'https://example.com/private/story' })).toBe(
      false,
    );
  });
});

describe('public article adapter', () => {
  test('checks robots and extracts a full deterministic article without changing identity', async () => {
    const result = await runArticleAdapter({
      endpointKey: discoveryItem.endpointKey,
      discoveryItem,
      allowedOrigins: ['https://example.com'],
      now: new Date('2026-08-22T00:00:00.000Z'),
      fetchImpl: mockFetch({}),
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
    });

    expect(result.stateHint).toBe('COMPLETED');
    expect(result.batch.items).toHaveLength(1);
    expect(result.batch.items[0]).toMatchObject({
      externalItemId: 'stable-guid-1',
      canonicalUrl: 'https://example.com/articles/fpl-guide',
      title: 'Full FPL Structure Guide',
      authorExternalId: 'Article Author',
      body: { availability: 'FULL' },
    });
    expect(result.batch.items[0]!.body.text!.length).toBeGreaterThan(500);
    expect(result.extraction!.contentRatio).toBeGreaterThan(0.08);
    expect(articleHttpTraces(result).map((trace) => trace.operation)).toEqual([
      'robots.fetch',
      'article.fetch',
    ]);
  });

  test('fails closed when robots disallows the discovered URL', async () => {
    const promise = runArticleAdapter({
      endpointKey: discoveryItem.endpointKey,
      discoveryItem,
      allowedOrigins: ['https://example.com'],
      fetchImpl: mockFetch({ robots: 'User-agent: *\nDisallow: /articles/' }),
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
    });
    await expect(promise).rejects.toMatchObject({ failureClass: 'ROBOTS_DISALLOWED' });
  });

  test('rejects a canonical URL outside the persisted origin allowlist', async () => {
    const promise = runArticleAdapter({
      endpointKey: discoveryItem.endpointKey,
      discoveryItem,
      allowedOrigins: ['https://example.com'],
      fetchImpl: mockFetch({
        article: new Response(articleHtml('https://other.example/story'), {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      }),
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
    });
    await expect(promise).rejects.toBeInstanceOf(ArticleAdapterError);
    await expect(promise).rejects.toMatchObject({
      failureClass: 'ARTICLE_CANONICAL_ORIGIN_FORBIDDEN',
    });
  });

  test('maps an article validator hit to CHECKED_NO_CHANGE', async () => {
    const result = await runArticleAdapter({
      endpointKey: discoveryItem.endpointKey,
      discoveryItem,
      allowedOrigins: ['https://example.com'],
      validator: { etag: '"article-v1"' },
      fetchImpl: mockFetch({
        article: new Response(null, { status: 304, headers: { etag: '"article-v1"' } }),
      }),
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
    });
    expect(result.stateHint).toBe('CHECKED_NO_CHANGE');
    expect(result.batch.items).toEqual([]);
    expect(result.transports).toHaveLength(2);
  });
});
