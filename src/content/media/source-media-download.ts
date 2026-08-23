import { createHash } from 'node:crypto';

import { fileTypeFromBuffer } from 'file-type';

import {
  fetchPublicResource,
  PublicHttpError,
  type PublicDnsLookup,
  type PublicFetch,
} from '../acquisition/http-transport';
import { xOriginalImageUrl } from './x-media-inventory';

const X_IMAGE_HOST = 'pbs.twimg.com';
const MAX_IMAGE_BYTES = 24 * 1_024 * 1_024;
const MAX_IMAGE_DIMENSION = 8192;
const MAX_IMAGE_PIXELS = 67_108_864;
type AllowedImageMime = 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';

const ALLOWED_IMAGE_TYPES: ReadonlyMap<string, 'jpg' | 'png' | 'webp' | 'gif'> = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif'],
] as const);

function uint16Be(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.byteLength) throw new Error('uint16 out of bounds');
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function uint16Le(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.byteLength) throw new Error('uint16 out of bounds');
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function uint24Le(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 3 > bytes.byteLength) throw new Error('uint24 out of bounds');
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function uint32Be(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.byteLength) throw new Error('uint32 out of bounds');
  return (
    bytes[offset]! * 0x1000000 +
    (bytes[offset + 1]! << 16) +
    (bytes[offset + 2]! << 8) +
    bytes[offset + 3]!
  );
}

function uint32Le(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.byteLength) throw new Error('uint32 out of bounds');
  return (
    bytes[offset]! +
    (bytes[offset + 1]! << 8) +
    (bytes[offset + 2]! << 16) +
    bytes[offset + 3]! * 0x1000000
  );
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (offset < 0 || offset + length > bytes.byteLength) throw new Error('ascii out of bounds');
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error('invalid JPEG header');
  }
  let offset = 2;
  while (offset < bytes.byteLength) {
    if (bytes[offset] !== 0xff) throw new Error('invalid JPEG marker');
    while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.byteLength) break;
    const marker = bytes[offset]!;
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    const segmentLength = uint16Be(bytes, offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.byteLength) {
      throw new Error('invalid JPEG segment length');
    }
    const isStartOfFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isStartOfFrame) {
      if (segmentLength < 7) throw new Error('invalid JPEG start-of-frame');
      return { height: uint16Be(bytes, offset + 3), width: uint16Be(bytes, offset + 5) };
    }
    offset += segmentLength;
  }
  throw new Error('JPEG dimensions are missing');
}

function webpDimensions(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.byteLength < 20 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') {
    throw new Error('invalid WebP header');
  }
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const chunkType = ascii(bytes, offset, 4);
    const chunkSize = uint32Le(bytes, offset + 4);
    const dataOffset = offset + 8;
    if (dataOffset + chunkSize > bytes.byteLength) throw new Error('invalid WebP chunk length');
    if (chunkType === 'VP8X' && chunkSize >= 10) {
      return {
        width: uint24Le(bytes, dataOffset + 4) + 1,
        height: uint24Le(bytes, dataOffset + 7) + 1,
      };
    }
    if (
      chunkType === 'VP8 ' &&
      chunkSize >= 10 &&
      bytes[dataOffset + 3] === 0x9d &&
      bytes[dataOffset + 4] === 0x01 &&
      bytes[dataOffset + 5] === 0x2a
    ) {
      return {
        width: uint16Le(bytes, dataOffset + 6) & 0x3fff,
        height: uint16Le(bytes, dataOffset + 8) & 0x3fff,
      };
    }
    if (chunkType === 'VP8L' && chunkSize >= 5 && bytes[dataOffset] === 0x2f) {
      const byte1 = bytes[dataOffset + 1]!;
      const byte2 = bytes[dataOffset + 2]!;
      const byte3 = bytes[dataOffset + 3]!;
      const byte4 = bytes[dataOffset + 4]!;
      return {
        width: 1 + byte1 + ((byte2 & 0x3f) << 8),
        height: 1 + (byte2 >> 6) + (byte3 << 2) + ((byte4 & 0x0f) << 10),
      };
    }
    const nextOffset = dataOffset + chunkSize + (chunkSize % 2);
    if (nextOffset <= offset) throw new Error('WebP chunk did not advance');
    offset = nextOffset;
  }
  throw new Error('WebP dimensions are missing');
}

function allowedImageDimensions(
  bytes: Uint8Array,
  mime: AllowedImageMime,
): { width: number; height: number } {
  if (mime === 'image/jpeg') return jpegDimensions(bytes);
  if (mime === 'image/png') {
    if (bytes.byteLength < 24 || ascii(bytes, 12, 4) !== 'IHDR') {
      throw new Error('invalid PNG header');
    }
    return { width: uint32Be(bytes, 16), height: uint32Be(bytes, 20) };
  }
  if (mime === 'image/gif') {
    if (bytes.byteLength < 10 || !['GIF87a', 'GIF89a'].includes(ascii(bytes, 0, 6))) {
      throw new Error('invalid GIF header');
    }
    return { width: uint16Le(bytes, 6), height: uint16Le(bytes, 8) };
  }
  return webpDimensions(bytes);
}

export class SourceMediaDownloadError extends Error {
  readonly failureClass: string;

  constructor(failureClass: string, message: string) {
    super(message);
    this.name = 'SourceMediaDownloadError';
    this.failureClass = failureClass;
  }
}

export type VerifiedSourceImage = Readonly<{
  bytes: Uint8Array;
  sha256: string;
  actualMime: AllowedImageMime;
  extension: 'jpg' | 'png' | 'webp' | 'gif';
  width: number;
  height: number;
  byteSize: number;
  fetchedUrl: string;
  sourceVariant: 'ORIG' | 'PAGE';
}>;

export type SourceMediaDownloadOptions = Readonly<{
  timeoutMs?: number;
  maximumBytes?: number;
  fetchImpl?: PublicFetch;
  lookupImpl?: PublicDnsLookup;
  signal?: AbortSignal;
}>;

function assertXImageUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SourceMediaDownloadError('IMAGE_URL_INVALID', 'X image URL is invalid');
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname.toLowerCase() !== X_IMAGE_HOST ||
    (!url.pathname.startsWith('/media/') && !url.pathname.startsWith('/amplify_video_thumb/'))
  ) {
    throw new SourceMediaDownloadError(
      'IMAGE_HOST_FORBIDDEN',
      'Static X media downloads are restricted to pbs.twimg.com',
    );
  }
  return url;
}

export async function verifySourceImageBytes(
  bytes: Uint8Array,
  fetchedUrl: string,
  sourceVariant: 'ORIG' | 'PAGE',
): Promise<VerifiedSourceImage> {
  if (bytes.byteLength === 0) {
    throw new SourceMediaDownloadError('IMAGE_EMPTY', 'X image response is empty');
  }
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new SourceMediaDownloadError('IMAGE_TOO_LARGE', 'X image exceeds 24 MiB');
  }
  const textPrefix = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.subarray(0, Math.min(bytes.byteLength, 512)))
    .trimStart()
    .toLowerCase();
  if (
    textPrefix.startsWith('<svg') ||
    (textPrefix.startsWith('<?xml') && textPrefix.includes('<svg'))
  ) {
    throw new SourceMediaDownloadError('IMAGE_SVG_FORBIDDEN', 'SVG media is not accepted');
  }
  const detected = await fileTypeFromBuffer(bytes);
  const extension = detected ? ALLOWED_IMAGE_TYPES.get(detected.mime) : undefined;
  if (!detected || !extension) {
    throw new SourceMediaDownloadError(
      detected?.mime === 'image/svg+xml' ? 'IMAGE_SVG_FORBIDDEN' : 'IMAGE_TYPE_UNRECOGNIZED',
      'X image bytes are not an allowed JPEG, PNG, WebP or GIF',
    );
  }
  let dimensions: { width: number; height: number };
  try {
    dimensions = allowedImageDimensions(bytes, detected.mime as AllowedImageMime);
  } catch {
    throw new SourceMediaDownloadError(
      'IMAGE_DIMENSIONS_INVALID',
      'X image dimensions are invalid',
    );
  }
  const width = dimensions.width;
  const height = dimensions.height;
  if (!width || !height || !Number.isInteger(width) || !Number.isInteger(height)) {
    throw new SourceMediaDownloadError(
      'IMAGE_DIMENSIONS_INVALID',
      'X image has no usable dimensions',
    );
  }
  if (
    width > MAX_IMAGE_DIMENSION ||
    height > MAX_IMAGE_DIMENSION ||
    width * height > MAX_IMAGE_PIXELS
  ) {
    throw new SourceMediaDownloadError(
      'IMAGE_DIMENSIONS_EXCEEDED',
      'X image dimensions exceed limits',
    );
  }
  return {
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    actualMime: detected.mime as VerifiedSourceImage['actualMime'],
    extension,
    width,
    height,
    byteSize: bytes.byteLength,
    fetchedUrl,
    sourceVariant,
  };
}

async function downloadCandidate(
  url: string,
  sourceVariant: 'ORIG' | 'PAGE',
  options: SourceMediaDownloadOptions,
): Promise<VerifiedSourceImage> {
  assertXImageUrl(url);
  let result: Awaited<ReturnType<typeof fetchPublicResource>>;
  try {
    result = await fetchPublicResource({
      url,
      timeoutMs: options.timeoutMs ?? 40_000,
      maximumBytes: options.maximumBytes ?? MAX_IMAGE_BYTES,
      accept: 'image/webp,image/png,image/jpeg,image/gif,*/*;q=0.1',
      fetchImpl: options.fetchImpl,
      lookupImpl: options.lookupImpl,
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof PublicHttpError) {
      throw new SourceMediaDownloadError(`IMAGE_${error.failureClass}`, 'X image transport failed');
    }
    throw error;
  }
  if (!result.body) {
    throw new SourceMediaDownloadError('IMAGE_BODY_MISSING', 'X image response has no body');
  }
  if (new URL(result.finalUrl).hostname.toLowerCase() !== X_IMAGE_HOST) {
    throw new SourceMediaDownloadError('IMAGE_REDIRECT_FORBIDDEN', 'X image redirected off CDN');
  }
  return verifySourceImageBytes(result.body, result.finalUrl, sourceVariant);
}

export async function downloadAndVerifyXImage(
  sourceUrl: string,
  options: SourceMediaDownloadOptions = {},
): Promise<VerifiedSourceImage> {
  assertXImageUrl(sourceUrl);
  const original = xOriginalImageUrl(sourceUrl);
  if (original === sourceUrl) return downloadCandidate(original, 'ORIG', options);
  if (original) {
    try {
      return await downloadCandidate(original, 'ORIG', options);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      // The page variant is an explicit bounded fallback. Its own validation
      // still runs from DNS through magic bytes and dimensions.
    }
  }
  return downloadCandidate(sourceUrl, 'PAGE', options);
}

export function sourceMediaObjectKey(
  image: Pick<VerifiedSourceImage, 'sha256' | 'extension'>,
): string {
  return `x/images/sha256/${image.sha256.slice(0, 2)}/${image.sha256}.${image.extension}`;
}
