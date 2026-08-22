import { describe, expect, test } from 'bun:test';

import type { AcquisitionItemV1 } from '../../../src/content/acquisition/acquisition-contract';
import {
  fetchPublisherPodcastTranscript,
  parseTimedTextTranscript,
} from '../../../src/content/acquisition/podcast-transcript-adapter';

const item: AcquisitionItemV1 = {
  endpointKey: 'fml-fpl-podcast',
  externalItemId: 'episode-1',
  canonicalUrl: null,
  sourceUrl: 'https://www.fmlfpl.com/',
  linkAvailability: 'SOURCE_LANDING',
  publishedAt: '2026-08-21T10:00:00.000Z',
  updatedAt: null,
  title: 'Episode 1',
  authorExternalId: null,
  contentKind: 'EPISODE',
  body: { availability: 'METADATA_ONLY', text: null },
  media: [
    {
      kind: 'AUDIO',
      url: 'https://example.com/episode.mp3',
      mimeType: 'audio/mpeg',
      durationSeconds: 60,
    },
    {
      kind: 'TRANSCRIPT',
      url: 'https://example.com/episode.vtt',
      mimeType: 'text/vtt',
      durationSeconds: null,
    },
  ],
  transcript: {
    status: 'PENDING',
    language: null,
    trackKind: null,
    providerRevision: null,
    segments: [],
  },
};

describe('Podcast publisher transcript adapter', () => {
  test('parses native WebVTT and SRT timings without an LLM segmentation pass', () => {
    expect(
      parseTimedTextTranscript(`WEBVTT

00:00:00.500 --> 00:00:02.000
Hello <b>FPL</b>

2
00:00:02,100 --> 00:00:04,000
Second cue
`),
    ).toEqual([
      { startMs: 500, endMs: 2_000, text: 'Hello FPL' },
      { startMs: 2_100, endMs: 4_000, text: 'Second cue' },
    ]);
  });

  test('fetches one declared publisher transcript with bounded deterministic transport', async () => {
    const result = await fetchPublisherPodcastTranscript({
      item,
      timeoutMs: 1_000,
      maximumBytes: 10_000,
      fetchImpl: async () =>
        new Response('WEBVTT\n\n00:00:00.000 --> 00:00:01.500\nOpening line\n', {
          status: 200,
          headers: { 'content-type': 'text/vtt; charset=utf-8' },
        }),
    });
    expect(result).not.toBeNull();
    expect(result?.segments).toEqual([{ startMs: 0, endMs: 1_500, text: 'Opening line' }]);
    expect(result?.artifactHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('does not invent timestamps for a plain-text publisher transcript', async () => {
    await expect(
      fetchPublisherPodcastTranscript({
        item,
        timeoutMs: 1_000,
        maximumBytes: 10_000,
        fetchImpl: async () =>
          new Response('Untimed publisher transcript', {
            status: 200,
            headers: { 'content-type': 'text/plain' },
          }),
      }),
    ).rejects.toThrow('TRANSCRIPT_HAS_NO_TIMESTAMPED_CUES');
  });

  test('tries later publisher artifacts when an earlier supported artifact is malformed', async () => {
    const calls: string[] = [];
    const result = await fetchPublisherPodcastTranscript({
      item: {
        ...item,
        media: [
          item.media[0]!,
          {
            kind: 'TRANSCRIPT',
            url: 'https://example.com/a-invalid.vtt',
            mimeType: 'text/vtt',
            durationSeconds: null,
          },
          {
            kind: 'TRANSCRIPT',
            url: 'https://example.com/b-valid.vtt',
            mimeType: 'text/vtt',
            durationSeconds: null,
          },
        ],
      },
      timeoutMs: 1_000,
      maximumBytes: 10_000,
      fetchImpl: async (input) => {
        calls.push(String(input));
        return String(input).endsWith('/a-invalid.vtt')
          ? new Response('Untimed publisher transcript', {
              status: 200,
              headers: { 'content-type': 'text/plain' },
            })
          : new Response('WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nFallback artifact\n', {
              status: 200,
              headers: { 'content-type': 'text/vtt' },
            });
      },
    });

    expect(calls).toEqual(['https://example.com/a-invalid.vtt', 'https://example.com/b-valid.vtt']);
    expect(result?.segments).toEqual([{ startMs: 0, endMs: 1_000, text: 'Fallback artifact' }]);
    expect(result?.artifactAttemptCount).toBe(2);
  });
});
