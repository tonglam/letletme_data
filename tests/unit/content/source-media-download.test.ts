import { describe, expect, test } from 'bun:test';

import {
  downloadAndVerifyXImage,
  SourceMediaDownloadError,
  sourceMediaObjectKey,
  verifySourceImageBytes,
} from '../../../src/content/media/source-media-download';

const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
const tinyPng = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  ),
);
const tinyJpeg = Uint8Array.from(Buffer.from('ffd8ffc0000b080002000301011100ffd9', 'hex'));
const tinyWebp = Uint8Array.from(
  Buffer.from('524946461600000057454250565038580a00000000000000020000010000', 'hex'),
);
const tinyGif = Uint8Array.from(Buffer.from('47494638396103000200', 'hex'));

describe('source-media image verification', () => {
  test('reads dimensions from bounded JPEG, PNG, WebP and GIF headers', async () => {
    const fixtures = [
      { bytes: tinyJpeg, mime: 'image/jpeg', width: 3, height: 2 },
      { bytes: tinyPng, mime: 'image/png', width: 1, height: 1 },
      { bytes: tinyWebp, mime: 'image/webp', width: 3, height: 2 },
      { bytes: tinyGif, mime: 'image/gif', width: 3, height: 2 },
    ] as const;

    for (const fixture of fixtures) {
      const result = await verifySourceImageBytes(
        fixture.bytes,
        `https://pbs.twimg.com/media/fixture.${fixture.mime.split('/')[1]}`,
        'PAGE',
      );
      expect(result.actualMime).toBe(fixture.mime);
      expect(result.width).toBe(fixture.width);
      expect(result.height).toBe(fixture.height);
    }
  });

  test('uses magic bytes when URL and response MIME claim JPEG', async () => {
    let acceptHeader = '';
    const result = await downloadAndVerifyXImage(
      'https://pbs.twimg.com/media/abc?format=jpg&name=small',
      {
        lookupImpl: lookup,
        fetchImpl: async (_input, init) => {
          acceptHeader = new Headers(init?.headers).get('accept') ?? '';
          return new Response(tinyPng, {
            status: 200,
            headers: { 'content-type': 'image/jpeg' },
          });
        },
      },
    );
    expect(acceptHeader).not.toContain('image/avif');
    expect(acceptHeader).toContain('image/webp');
    expect(result.actualMime).toBe('image/png');
    expect(result.extension).toBe('png');
    expect(result.sourceVariant).toBe('ORIG');
    expect(sourceMediaObjectKey(result)).toMatch(
      /^x\/images\/sha256\/[0-9a-f]{2}\/[0-9a-f]{64}\.png$/,
    );
  });

  test('falls back to the page variant when orig is unavailable', async () => {
    const requestedNames: string[] = [];
    const result = await downloadAndVerifyXImage(
      'https://pbs.twimg.com/media/abc?format=png&name=small',
      {
        lookupImpl: lookup,
        fetchImpl: async (input) => {
          const name = new URL(String(input)).searchParams.get('name') ?? '';
          requestedNames.push(name);
          return name === 'orig'
            ? new Response('missing', { status: 404 })
            : new Response(tinyPng, { status: 200 });
        },
      },
    );
    expect(requestedNames).toEqual(['orig', 'small']);
    expect(result.sourceVariant).toBe('PAGE');
  });

  test('records an already-orig page URL as the orig variant', async () => {
    const requested: string[] = [];
    const result = await downloadAndVerifyXImage(
      'https://pbs.twimg.com/media/abc?format=png&name=orig',
      {
        lookupImpl: lookup,
        fetchImpl: async (input) => {
          requested.push(String(input));
          return new Response(tinyPng, { status: 200 });
        },
      },
    );
    expect(requested).toHaveLength(1);
    expect(result.sourceVariant).toBe('ORIG');
  });

  test('rejects SVG, empty bytes, forbidden hosts and oversized dimensions', async () => {
    await expect(
      verifySourceImageBytes(
        new TextEncoder().encode('<svg></svg>'),
        'https://example.test/a.svg',
        'PAGE',
      ),
    ).rejects.toMatchObject({ failureClass: 'IMAGE_SVG_FORBIDDEN' });
    await expect(
      verifySourceImageBytes(new Uint8Array(), 'https://example.test/empty', 'PAGE'),
    ).rejects.toMatchObject({ failureClass: 'IMAGE_EMPTY' });
    const heif = Uint8Array.from(
      Buffer.from('00000018667479706865696300000000686569636d696631', 'hex'),
    );
    await expect(
      verifySourceImageBytes(heif, 'https://pbs.twimg.com/media/untrusted.heic', 'PAGE'),
    ).rejects.toMatchObject({ failureClass: 'IMAGE_TYPE_UNRECOGNIZED' });
    const malformedWebp = tinyWebp.slice();
    malformedWebp.set([0xff, 0xff, 0xff, 0x7f], 16);
    await expect(
      verifySourceImageBytes(malformedWebp, 'https://pbs.twimg.com/media/malformed.webp', 'PAGE'),
    ).rejects.toMatchObject({ failureClass: 'IMAGE_DIMENSIONS_INVALID' });
    await expect(downloadAndVerifyXImage('https://example.com/image.jpg')).rejects.toBeInstanceOf(
      SourceMediaDownloadError,
    );

    const huge = tinyPng.slice();
    huge.set([0, 0, 32, 1], 16);
    huge.set([0, 0, 0, 1], 20);
    await expect(
      verifySourceImageBytes(huge, 'https://pbs.twimg.com/media/huge.png', 'PAGE'),
    ).rejects.toMatchObject({ failureClass: 'IMAGE_DIMENSIONS_EXCEEDED' });
  });

  test('rejects private DNS targets and cross-origin redirects before reading bytes', async () => {
    const poster = 'https://pbs.twimg.com/amplify_video_thumb/123/img/poster.jpg';
    await expect(
      downloadAndVerifyXImage(poster, {
        lookupImpl: async () => [{ address: '127.0.0.1', family: 4 }],
        fetchImpl: async () => new Response(tinyPng),
      }),
    ).rejects.toMatchObject({ failureClass: 'IMAGE_PRIVATE_TARGET' });

    await expect(
      downloadAndVerifyXImage(poster, {
        lookupImpl: lookup,
        fetchImpl: async () =>
          new Response(null, {
            status: 302,
            headers: { location: 'https://example.com/escaped.jpg' },
          }),
      }),
    ).rejects.toMatchObject({ failureClass: 'IMAGE_CROSS_ORIGIN_REDIRECT' });
  });
});
