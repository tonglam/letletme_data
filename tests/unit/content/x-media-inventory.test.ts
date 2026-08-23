import { describe, expect, test } from 'bun:test';

import {
  fetchXMediaInventory,
  parseXMediaInventory,
  xOriginalImageUrl,
} from '../../../src/content/media/x-media-inventory';

const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
const postId = '2091144605710647466';
const pageUrl = `https://x.com/CPFC/status/${postId}`;

function fetchHtml(html: string) {
  return async () =>
    new Response(html, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
}

describe('X source-media inventory', () => {
  test('preserves carousel DOM order and excludes profile and nested quote images', () => {
    const result = parseXMediaInventory({
      postId,
      pageUrl,
      html: `
        <article>
          <a href="/CPFC/status/${postId}">post</a>
          <img src="https://pbs.twimg.com/profile_images/profile.jpg" alt="profile">
          <img src="https://pbs.twimg.com/media/z-last.jpg" alt="First alt">
          <img src="https://pbs.twimg.com/media/a-first.jpg" alt="Second alt">
          <div data-testid="card.wrapper">
            <img src="https://pbs.twimg.com/media/external-preview.jpg" alt="external card">
          </div>
          <article>
            <a href="/Other/status/2091144605710647000">quote</a>
            <img src="https://pbs.twimg.com/media/quoted.jpg">
          </article>
        </article>
      `,
    });
    expect(result).toEqual({
      status: 'FOUND',
      items: [
        {
          ordinal: 0,
          role: 'IMAGE',
          sourceUrl: 'https://pbs.twimg.com/media/z-last.jpg',
          altText: 'First alt',
          sourceVariant: 'PAGE',
        },
        {
          ordinal: 1,
          role: 'IMAGE',
          sourceUrl: 'https://pbs.twimg.com/media/a-first.jpg',
          altText: 'Second alt',
          sourceVariant: 'PAGE',
        },
      ],
    });
  });

  test('keeps a video poster and its related HLS stream beside it', () => {
    const result = parseXMediaInventory({
      postId,
      pageUrl,
      html: `
        <article>
          <a href="/CPFC/status/${postId}">post</a>
          <img src="https://pbs.twimg.com/amplify_video_thumb/123/img/poster.jpg" alt="clip">
        </article>
        <script>https://video.twimg.com/amplify_video/123/pl/master.m3u8?tag=29&amp;v=1</script>
        <script>https://video.twimg.com/amplify_video/999/pl/master.m3u8</script>
      `,
    });
    expect(result).toEqual({
      status: 'FOUND',
      items: [
        {
          ordinal: 0,
          role: 'VIDEO_POSTER',
          sourceUrl: 'https://pbs.twimg.com/amplify_video_thumb/123/img/poster.jpg',
          altText: 'clip',
          sourceVariant: 'PAGE',
        },
        {
          ordinal: 1,
          role: 'VIDEO_STREAM',
          sourceUrl: 'https://video.twimg.com/amplify_video/123/pl/master.m3u8?tag=29&v=1',
          altText: null,
          sourceVariant: 'PAGE',
        },
      ],
    });
  });

  test('recognizes a poster exposed on the video element itself', () => {
    const result = parseXMediaInventory({
      postId,
      pageUrl,
      html: `
        <article>
          <a href="/CPFC/status/${postId}">post</a>
          <video poster="https://pbs.twimg.com/media/video-poster.jpg" aria-label="Press conference"></video>
        </article>
      `,
    });
    expect(result).toEqual({
      status: 'FOUND',
      items: [
        {
          ordinal: 0,
          role: 'VIDEO_POSTER',
          sourceUrl: 'https://pbs.twimg.com/media/video-poster.jpg',
          altText: 'Press conference',
          sourceVariant: 'PAGE',
        },
      ],
    });
  });

  test('only an exact target article with no inventory becomes CHECKED_NONE', async () => {
    const missing = await fetchXMediaInventory(pageUrl, postId, {
      fetchImpl: fetchHtml('<article><a href="/Other/status/1">other</a></article>'),
      lookupImpl: lookup,
    });
    expect(missing).toEqual({
      status: 'UNAVAILABLE',
      failureClass: 'TARGET_ARTICLE_MISSING',
      items: [],
    });

    const none = await fetchXMediaInventory(pageUrl, postId, {
      fetchImpl: fetchHtml(`<article><a href="/CPFC/status/${postId}">post</a></article>`),
      lookupImpl: lookup,
    });
    expect(none).toEqual({ status: 'CHECKED_NONE', items: [] });
  });

  test('does not call an unparseable photo or video placeholder CHECKED_NONE', () => {
    const result = parseXMediaInventory({
      pageUrl,
      postId,
      html: `
        <article>
          <a href="/CPFC/status/${postId}">post</a>
          <div data-testid="tweetPhoto">
            <img src="https://pbs.twimg.com/profile_images/avatar.jpg">
          </div>
          <video></video>
        </article>
      `,
    });
    expect(result).toEqual({
      status: 'UNAVAILABLE',
      failureClass: 'MEDIA_EVIDENCE_UNPARSABLE',
      items: [],
    });
  });

  test('rejects non-canonical status URL suffixes, query strings, and fragments', async () => {
    for (const url of [`${pageUrl}/photo/1`, `${pageUrl}?s=20`, `${pageUrl}#media`]) {
      await expect(
        fetchXMediaInventory(url, postId, {
          fetchImpl: fetchHtml(''),
          lookupImpl: lookup,
        }),
      ).rejects.toThrow('canonical HTTPS status URL');
    }
  });

  test('normalizes accepted twitter.com identities before the strict same-origin fetch', async () => {
    const hostHeaders: string[] = [];
    const result = await fetchXMediaInventory(`https://twitter.com/CPFC/status/${postId}`, postId, {
      lookupImpl: lookup,
      fetchImpl: async (_input, init) => {
        hostHeaders.push(new Headers(init?.headers).get('host') ?? '');
        return new Response(`<article><a href="/CPFC/status/${postId}">post</a></article>`, {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      },
    });
    expect(hostHeaders).toEqual(['x.com']);
    expect(result).toEqual({ status: 'CHECKED_NONE', items: [] });
  });

  test('propagates worker aborts instead of consuming an unavailable retry', async () => {
    const controller = new AbortController();
    controller.abort('media-worker shutdown');
    let fetchCalls = 0;

    await expect(
      fetchXMediaInventory(pageUrl, postId, {
        signal: controller.signal,
        lookupImpl: lookup,
        fetchImpl: async () => {
          fetchCalls += 1;
          return new Response();
        },
      }),
    ).rejects.toBeDefined();
    expect(fetchCalls).toBe(0);
  });

  test('builds an orig candidate only for ordinary pbs media', () => {
    expect(xOriginalImageUrl('https://pbs.twimg.com/media/abc?format=webp&name=small')).toBe(
      'https://pbs.twimg.com/media/abc?format=webp&name=orig',
    );
    expect(
      xOriginalImageUrl('https://pbs.twimg.com/amplify_video_thumb/123/img/poster.jpg'),
    ).toBeNull();
  });
});
