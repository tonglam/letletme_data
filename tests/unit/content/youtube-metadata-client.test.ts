import { describe, expect, test } from 'bun:test';

import type { AcquisitionItemV1 } from '../../../src/content/acquisition/acquisition-contract';
import { YouTubeMetadataClient } from '../../../src/content/acquisition/youtube-metadata-client';

const discoveryItem: AcquisitionItemV1 = {
  endpointKey: 'fpl-focal-youtube',
  externalItemId: 'Xef37ImWz3M',
  canonicalUrl: 'https://www.youtube.com/watch?v=Xef37ImWz3M',
  sourceUrl: 'https://www.youtube.com/watch?v=Xef37ImWz3M',
  linkAvailability: 'DIRECT',
  publishedAt: '2026-08-20T12:00:00.000Z',
  updatedAt: '2026-08-20T12:00:00.000Z',
  title: 'Feed title',
  authorExternalId: 'UC72QokPHXQ9r98ROfNZmaDw',
  contentKind: 'VIDEO',
  body: { availability: 'EXCERPT', text: 'Feed description' },
  media: [],
  transcript: {
    status: 'PENDING',
    language: null,
    trackKind: null,
    providerRevision: null,
    segments: [],
  },
};

const responseBody = {
  items: [
    {
      id: 'Xef37ImWz3M',
      snippet: {
        channelId: 'UC72QokPHXQ9r98ROfNZmaDw',
        title: 'Canonical title',
        description: 'Canonical description',
        publishedAt: '2026-08-20T12:00:00.000Z',
        liveBroadcastContent: 'none',
      },
      contentDetails: { duration: 'PT15M33S', caption: 'true' },
      status: { uploadStatus: 'processed', privacyStatus: 'public' },
    },
  ],
};

describe('YouTube metadata client', () => {
  test('binds a finished video to the persisted channel and parses duration', async () => {
    let requestedUrl = '';
    const client = new YouTubeMetadataClient({
      apiKey: 'secret',
      timeoutMs: 1_000,
      maximumResponseBytes: 1_000_000,
      fetchImpl: async (input) => {
        requestedUrl = String(input);
        return Response.json(responseBody);
      },
    });
    const result = await client.getVideo({
      discoveryItem,
      expectedChannelId: 'UC72QokPHXQ9r98ROfNZmaDw',
    });
    expect(result.lifecycleState).toBe('FINISHED');
    expect(result.item.video).toMatchObject({
      lifecycleState: 'FINISHED',
      durationSeconds: 933,
      captionsAvailable: true,
    });
    expect(result.item.media[0]?.durationSeconds).toBe(933);
    expect(requestedUrl).toContain('part=snippet%2CcontentDetails%2CliveStreamingDetails%2Cstatus');
    expect(requestedUrl).toContain('key=secret');
    expect(result.requestMetadataHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('does not classify an active live stream as finished', async () => {
    const client = new YouTubeMetadataClient({
      apiKey: 'secret',
      timeoutMs: 1_000,
      maximumResponseBytes: 1_000_000,
      fetchImpl: async () =>
        Response.json({
          items: [
            {
              ...responseBody.items[0],
              snippet: { ...responseBody.items[0]!.snippet, liveBroadcastContent: 'live' },
              contentDetails: { duration: 'PT0S', caption: 'false' },
              liveStreamingDetails: {
                scheduledStartTime: '2026-08-20T12:00:00.000Z',
                actualStartTime: '2026-08-20T12:01:00.000Z',
              },
            },
          ],
        }),
    });
    const result = await client.getVideo({
      discoveryItem,
      expectedChannelId: 'UC72QokPHXQ9r98ROfNZmaDw',
    });
    expect(result.lifecycleState).toBe('LIVE');
    expect(result.item.video?.durationSeconds).toBeNull();
  });

  test('rejects a video returned for another channel', async () => {
    const client = new YouTubeMetadataClient({
      apiKey: 'secret',
      timeoutMs: 1_000,
      maximumResponseBytes: 1_000_000,
      fetchImpl: async () => Response.json(responseBody),
    });
    await expect(
      client.getVideo({ discoveryItem, expectedChannelId: 'UC-wrong' }),
    ).rejects.toMatchObject({ failureClass: 'IDENTITY_CONFLICT' });
  });

  test('cancels an oversized streaming response before buffering the whole body', async () => {
    let cancelled = false;
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new TextEncoder().encode('1234567890'));
        if (pulls === 4) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const client = new YouTubeMetadataClient({
      apiKey: 'secret',
      timeoutMs: 1_000,
      maximumResponseBytes: 15,
      fetchImpl: async () => new Response(body, { status: 200 }),
    });

    await expect(
      client.getVideo({
        discoveryItem,
        expectedChannelId: 'UC72QokPHXQ9r98ROfNZmaDw',
      }),
    ).rejects.toMatchObject({ failureClass: 'OUTPUT_LIMIT' });
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(4);
  });
});
