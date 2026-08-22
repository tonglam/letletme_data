import { describe, expect, test } from 'bun:test';

import {
  fetchPublicResource,
  isPublicIpAddress,
} from '../../../src/content/acquisition/http-transport';

describe('public HTTP acquisition transport', () => {
  test('blocks private and documentation IP ranges', () => {
    expect(isPublicIpAddress('127.0.0.1')).toBe(false);
    expect(isPublicIpAddress('10.0.0.1')).toBe(false);
    expect(isPublicIpAddress('169.254.169.254')).toBe(false);
    expect(isPublicIpAddress('192.0.2.1')).toBe(false);
    expect(isPublicIpAddress('2606:4700:4700::1111')).toBe(true);
    expect(isPublicIpAddress('1.1.1.1')).toBe(true);
  });

  test('maps a valid 304 to no-body validator evidence', async () => {
    const result = await fetchPublicResource({
      url: 'https://1.1.1.1/feed',
      now: new Date('2026-08-22T00:00:00.000Z'),
      validator: { etag: '"old"' },
      fetchImpl: async (_url, init) => {
        expect(new Headers(init?.headers).get('if-none-match')).toBe('"old"');
        return new Response(null, {
          status: 304,
          headers: { etag: '"new"', 'cache-control': 'max-age=900' },
        });
      },
    });
    expect(result).toMatchObject({
      status: 304,
      body: null,
      validator: { etag: '"new"' },
      cacheNotBefore: '2026-08-22T00:15:00.000Z',
    });
  });

  test('fails before buffering a declared oversized response', async () => {
    await expect(
      fetchPublicResource({
        url: 'https://1.1.1.1/feed',
        maximumBytes: 10,
        acceptedContentTypes: [/xml/],
        fetchImpl: async () =>
          new Response('<rss></rss>', {
            status: 200,
            headers: { 'content-type': 'application/xml', 'content-length': '100' },
          }),
      }),
    ).rejects.toMatchObject({ failureClass: 'BODY_TOO_LARGE' });
  });

  test('pins a validated DNS address while preserving Host and TLS identity', async () => {
    let requestedUrl = '';
    let requestedHost = '';
    let requestedServerName = '';
    const result = await fetchPublicResource({
      url: 'https://feed.example.test/path',
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
      fetchImpl: async (url, init) => {
        requestedUrl = String(url);
        requestedHost = new Headers(init?.headers).get('host') ?? '';
        requestedServerName =
          (init as { tls?: { serverName?: string } } | undefined)?.tls?.serverName ?? '';
        return new Response('<rss/>', {
          status: 200,
          headers: { 'content-type': 'application/xml' },
        });
      },
    });
    expect(result.status).toBe(200);
    expect(requestedUrl).toBe('https://93.184.216.34/path');
    expect(requestedHost).toBe('feed.example.test');
    expect(requestedServerName).toBe('feed.example.test');
  });

  test('rejects cross-origin redirects', async () => {
    await expect(
      fetchPublicResource({
        url: 'https://1.1.1.1/feed',
        fetchImpl: async () =>
          new Response(null, { status: 301, headers: { location: 'https://8.8.8.8/feed' } }),
      }),
    ).rejects.toMatchObject({ failureClass: 'CROSS_ORIGIN_REDIRECT' });
  });
});
