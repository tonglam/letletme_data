import { describe, expect, test } from 'bun:test';

import { HermesTranscriptClient } from '../../../src/content/acquisition/hermes-transcript-client';

describe('Hermes fixed transcript service contract', () => {
  test('accepts authenticated structured timestamped output and never sends a natural-language task', async () => {
    const client = new HermesTranscriptClient({
      endpoint: 'https://hermes.example.com/v1/transcripts',
      token: 'fixture-secret',
      timeoutMs: 1_000,
      maximumResponseBytes: 10_000,
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
      fetchImpl: async (_input, init) => {
        expect(init?.headers).toMatchObject({ Authorization: 'Bearer fixture-secret' });
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(body).toMatchObject({
          schemaVersion: 1,
          externalItemId: 'episode-1',
          mediaTarget: { hostname: 'example.com', address: expect.any(String) },
          mediaFetchPolicy: {
            maximumRedirects: 5,
            sameOriginOnly: true,
            revalidateDnsOnRedirect: true,
          },
          expectedDurationSeconds: 60,
          chunkDurationSeconds: 900,
        });
        expect(body).not.toHaveProperty('prompt');
        return new Response(
          JSON.stringify({
            schemaVersion: 1,
            status: 'COMPLETED',
            mediaSha256: 'a'.repeat(64),
            engine: 'faster-whisper',
            modelRevision: 'base',
            optionsRevision: 'faster-whisper-v1',
            language: 'en',
            durationSeconds: 60,
            segments: [{ startMs: 500, endMs: 59_000, text: '  Transcript text  ' }],
            chunks: [
              {
                index: 0,
                startMs: 0,
                endMs: 60_000,
                audioSha256: 'b'.repeat(64),
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      },
    });
    const result = await client.transcribe({
      runId: '00000000-0000-4000-8000-000000000001',
      externalItemId: 'episode-1',
      mediaUrl: 'https://example.com/episode.mp3',
      expectedDurationSeconds: 60,
      chunkDurationSeconds: 900,
    });
    expect(result.segments).toEqual([{ startMs: 500, endMs: 59_000, text: 'Transcript text' }]);
    expect(result.providerUnits).toBe(60);
    expect(result.requestMetadataHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test('rejects a transcript that exceeds the returned media duration', async () => {
    const client = new HermesTranscriptClient({
      endpoint: 'https://hermes.example.com/v1/transcripts',
      token: 'fixture-secret',
      timeoutMs: 1_000,
      maximumResponseBytes: 10_000,
      lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            schemaVersion: 1,
            status: 'COMPLETED',
            mediaSha256: 'a'.repeat(64),
            engine: 'faster-whisper',
            modelRevision: 'base',
            optionsRevision: 'v1',
            language: 'en',
            durationSeconds: 60,
            segments: [{ startMs: 0, endMs: 70_000, text: 'Too long' }],
            chunks: [
              {
                index: 0,
                startMs: 0,
                endMs: 60_000,
                audioSha256: 'b'.repeat(64),
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    });
    await expect(
      client.transcribe({
        runId: '00000000-0000-4000-8000-000000000001',
        externalItemId: 'episode-1',
        mediaUrl: 'https://example.com/episode.mp3',
        expectedDurationSeconds: 60,
        chunkDurationSeconds: 900,
      }),
    ).rejects.toThrow('exceeds the returned media duration');
  });

  test('rejects private or mixed DNS media targets before contacting Hermes', async () => {
    const client = new HermesTranscriptClient({
      endpoint: 'https://hermes.example.com/v1/transcripts',
      token: 'fixture-secret',
      timeoutMs: 1_000,
      maximumResponseBytes: 10_000,
      lookupImpl: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
      fetchImpl: async () => {
        throw new Error('Hermes must not be contacted');
      },
    });
    await expect(
      client.transcribe({
        runId: '00000000-0000-4000-8000-000000000001',
        externalItemId: 'episode-1',
        mediaUrl: 'https://feed.example.test/episode.mp3',
        expectedDurationSeconds: 60,
        chunkDurationSeconds: 900,
      }),
    ).rejects.toMatchObject({ failureClass: 'HERMES_MEDIA_PRIVATE_TARGET' });
  });

  test('rejects literal localhost media targets', async () => {
    const client = new HermesTranscriptClient({
      endpoint: 'https://hermes.example.com/v1/transcripts',
      token: 'fixture-secret',
      timeoutMs: 1_000,
      maximumResponseBytes: 10_000,
      fetchImpl: async () => {
        throw new Error('Hermes must not be contacted');
      },
    });
    await expect(
      client.transcribe({
        runId: '00000000-0000-4000-8000-000000000001',
        externalItemId: 'episode-1',
        mediaUrl: 'http://127.0.0.1/episode.mp3',
        expectedDurationSeconds: 60,
        chunkDurationSeconds: 900,
      }),
    ).rejects.toMatchObject({ failureClass: 'HERMES_MEDIA_PRIVATE_TARGET' });
  });
});
