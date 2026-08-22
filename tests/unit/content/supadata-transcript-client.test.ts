import { describe, expect, test } from 'bun:test';

import { SupadataTranscriptClient } from '../../../src/content/acquisition/supadata-transcript-client';

const response = (body: unknown, status = 200, billable = '1') =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'x-billable-requests': billable },
  });

describe('Supadata transcript client', () => {
  test('returns native timestamped segments and actual billable units', async () => {
    const client = new SupadataTranscriptClient({
      apiKey: 'secret',
      timeoutMs: 1_000,
      maximumResponseBytes: 1_000_000,
      fetchImpl: async () =>
        response({
          content: [
            { text: ' First line ', offset: 100, duration: 900, lang: 'en' },
            { text: 'Second line', offset: 1_100, duration: 500, lang: 'en' },
          ],
          lang: 'en',
          availableLangs: ['en'],
        }),
    });
    const result = await client.submit({
      videoUrl: 'https://www.youtube.com/watch?v=Xef37ImWz3M',
      mode: 'native',
      language: 'en',
    });
    expect(result.kind).toBe('COMPLETED');
    if (result.kind !== 'COMPLETED') throw new Error('Expected completed transcript');
    expect(result.segments).toEqual([
      { startMs: 100, endMs: 1_000, text: 'First line' },
      { startMs: 1_100, endMs: 1_600, text: 'Second line' },
    ]);
    expect(result.providerUnits).toBe(1);
  });

  test('maps native 206 to unavailable instead of empty success', async () => {
    const client = new SupadataTranscriptClient({
      apiKey: 'secret',
      timeoutMs: 1_000,
      maximumResponseBytes: 1_000_000,
      fetchImpl: async () =>
        response(
          {
            error: 'transcript-unavailable',
            message: 'Transcript Unavailable',
            details: 'No transcript is available for this video',
          },
          206,
        ),
    });
    const result = await client.submit({
      videoUrl: 'https://www.youtube.com/watch?v=yA8S_bMekDU',
      mode: 'native',
      language: 'en',
    });
    expect(result).toMatchObject({ kind: 'UNAVAILABLE', errorCode: 'transcript-unavailable' });
  });

  test('returns and then polls the same asynchronous job ID', async () => {
    const calls: string[] = [];
    const client = new SupadataTranscriptClient({
      apiKey: 'secret',
      timeoutMs: 1_000,
      maximumResponseBytes: 1_000_000,
      fetchImpl: async (input) => {
        calls.push(String(input));
        if (calls.length === 1) return response({ jobId: 'provider-job-1' }, 202, '4');
        return response(
          {
            status: 'completed',
            content: [{ text: 'Generated line', offset: 0, duration: 1_000, lang: 'en' }],
            lang: 'en',
            availableLangs: ['en'],
          },
          200,
          '0',
        );
      },
    });
    const submission = await client.submit({
      videoUrl: 'https://www.youtube.com/watch?v=yA8S_bMekDU',
      mode: 'auto',
      language: 'en',
    });
    expect(submission).toMatchObject({
      kind: 'PENDING',
      jobId: 'provider-job-1',
      providerUnits: 4,
    });
    const terminal = await client.poll('provider-job-1');
    expect(terminal).toMatchObject({ kind: 'COMPLETED', providerUnits: 0 });
    expect(calls[1]).toEndWith('/transcript/provider-job-1');
  });

  test('keeps a successful empty transcript distinct from a valid transcript', async () => {
    const client = new SupadataTranscriptClient({
      apiKey: 'secret',
      timeoutMs: 1_000,
      maximumResponseBytes: 1_000_000,
      fetchImpl: async () => response({ content: [], lang: 'en', availableLangs: ['en'] }),
    });
    const result = await client.submit({
      videoUrl: 'https://www.youtube.com/watch?v=silent',
      mode: 'auto',
      language: 'en',
    });
    expect(result.kind).toBe('EMPTY');
  });

  test('fails closed when a successful submission omits billing evidence', async () => {
    const client = new SupadataTranscriptClient({
      apiKey: 'secret',
      timeoutMs: 1_000,
      maximumResponseBytes: 1_000_000,
      fetchImpl: async () =>
        new Response(JSON.stringify({ content: [], lang: 'en', availableLangs: ['en'] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    await expect(
      client.submit({
        videoUrl: 'https://www.youtube.com/watch?v=silent',
        mode: 'auto',
        language: 'en',
      }),
    ).rejects.toMatchObject({ failureClass: 'BILLING_HEADER_MISSING' });
  });
});
