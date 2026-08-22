import { describe, expect, test } from 'bun:test';

import {
  resolveXPostMedia,
  resolveXPostMediaBatch,
} from '../../../src/content/acquisition/x-media-resolver';

const lookup = async () => [{ address: '93.184.216.34', family: 4 }];

function fetchHtml(html: string) {
  return async () =>
    new Response(html, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
}

const post = {
  postId: '2091144605710647466',
  authorHandle: 'CPFC',
  createdAt: '2026-08-22T12:45:00Z',
  text: 'The Palace XI taking on Everton ✊',
  url: 'https://x.com/CPFC/status/2091144605710647466',
} as const;

describe('X public page media resolver', () => {
  test('keeps every image in a carousel and excludes the profile image', async () => {
    const html = `
      <article>
        <a href="/CPFC/status/2091144605710647466">post</a>
        <img src="https://pbs.twimg.com/profile_images/profile.jpg">
        <img src="https://pbs.twimg.com/media/first.jpg">
        <img src="https://pbs.twimg.com/media/second.jpg">
      </article>
    `;
    const result = await resolveXPostMedia(post, {
      fetchImpl: fetchHtml(html),
      lookupImpl: lookup,
    });
    expect(result.status).toBe('FOUND');
    expect(result.media).toEqual([
      {
        kind: 'IMAGE',
        url: 'https://pbs.twimg.com/media/first.jpg',
        mimeType: 'image/jpeg',
        durationSeconds: null,
      },
      {
        kind: 'IMAGE',
        url: 'https://pbs.twimg.com/media/second.jpg',
        mimeType: 'image/jpeg',
        durationSeconds: null,
      },
    ]);
  });

  test('keeps a video poster and one playable HLS URL', async () => {
    const html = `
      <article>
        <a href="/FPLFocal/status/2091072793546792997">post</a>
        <img src="https://pbs.twimg.com/amplify_video_thumb/123/img/poster.jpg">
      </article>
      <script>https://video.twimg.com/amplify_video/123/pl/master.m3u8?tag=29&amp;v=1</script>
      <script>https://video.twimg.com/amplify_video/123/vid/720x.mp4?tag=29</script>
    `;
    const result = await resolveXPostMedia(
      {
        ...post,
        postId: '2091072793546792997',
        authorHandle: 'FPLFocal',
        url: 'https://x.com/FPLFocal/status/2091072793546792997',
      },
      { fetchImpl: fetchHtml(html), lookupImpl: lookup },
    );
    expect(result.status).toBe('FOUND');
    expect(result.media).toEqual([
      {
        kind: 'IMAGE',
        url: 'https://pbs.twimg.com/amplify_video_thumb/123/img/poster.jpg',
        mimeType: 'image/jpeg',
        durationSeconds: null,
      },
      {
        kind: 'VIDEO',
        url: 'https://video.twimg.com/amplify_video/123/pl/master.m3u8?tag=29&v=1',
        mimeType: 'application/vnd.apple.mpegurl',
        durationSeconds: null,
      },
    ]);
  });

  test('distinguishes no media from an unavailable X page', async () => {
    const noMedia = await resolveXPostMedia(post, {
      fetchImpl: fetchHtml(
        '<article><a href="/CPFC/status/2091144605710647466">post</a></article>',
      ),
      lookupImpl: lookup,
    });
    expect(noMedia).toEqual({ status: 'CHECKED_NONE', media: [] });

    const unavailable = await resolveXPostMedia(post, {
      fetchImpl: async () => {
        throw new Error('network down');
      },
      lookupImpl: lookup,
    });
    expect(unavailable).toEqual({ status: 'UNAVAILABLE', media: [] });
  });

  test('returns per-post counts for a bounded batch', async () => {
    const result = await resolveXPostMediaBatch([post], {
      fetchImpl: fetchHtml(
        '<article><a href="/CPFC/status/2091144605710647466">post</a></article>',
      ),
      lookupImpl: lookup,
      concurrency: 2,
    });
    expect(result.checkedCount).toBe(1);
    expect(result.foundCount).toBe(0);
    expect(result.unavailableCount).toBe(0);
    expect(result.evidenceByPostId.get(post.postId)?.status).toBe('CHECKED_NONE');
  });
});
