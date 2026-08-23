import { createHash } from 'node:crypto';

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type ProviderTranscriptSegment = Readonly<{
  text: string;
  offsetSeconds: number;
  durationSeconds: number;
}>;

export type CanonicalTranscriptSegmentV1 = Readonly<{
  startMs: number;
  endMs: number;
  text: string;
}>;

export function normalizeCanonicalText(value: string): string {
  return value
    .normalize('NFC')
    .replace(/\p{White_Space}+/gu, ' ')
    .trim();
}

export function canonicalizeJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalizeJson(value[key] as JsonValue)]),
  );
}

export function canonicalJson(value: JsonValue): string {
  return JSON.stringify(canonicalizeJson(value));
}

export function sha256CanonicalJson(value: JsonValue): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

/**
 * X media moved out of immutable ReceiptRevision payloads in source-media v1.
 * This compatibility hash lets a legacy X revision containing media fields
 * compare equal to the same post facts produced by the media-free adapter.
 */
export function xReceiptCoreHash(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('X receipt payload must be an object');
  }
  const { media: _media, mediaStatus: _mediaStatus, ...core } = value as Record<string, JsonValue>;
  return sha256CanonicalJson(core);
}

export function canonicalizeTranscriptSegments(
  segments: readonly ProviderTranscriptSegment[],
): CanonicalTranscriptSegmentV1[] {
  return segments.map((segment) => ({
    startMs: Math.round(segment.offsetSeconds * 1_000),
    endMs: Math.round((segment.offsetSeconds + segment.durationSeconds) * 1_000),
    text: normalizeCanonicalText(segment.text),
  }));
}

export function transcriptSegmentsHash(segments: readonly CanonicalTranscriptSegmentV1[]): string {
  const value: JsonValue = segments.map((segment) => ({
    startMs: segment.startMs,
    endMs: segment.endMs,
    text: segment.text,
  }));
  return sha256CanonicalJson(value);
}
