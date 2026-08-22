import { TextDecoder } from 'node:util';

import { z } from 'zod';

import type { AcquisitionItemV1 } from './acquisition-contract';
import { normalizeCanonicalText, type CanonicalTranscriptSegmentV1 } from './canonicalization';
import {
  fetchPublicResource,
  publicHttpTrace,
  type AcquisitionHttpTrace,
  type PublicFetch,
  type PublicHttpResult,
} from './http-transport';

export const PODCAST_TRANSCRIPT_POLICY_V1 = Object.freeze({
  maximumDurationSeconds: 3 * 60 * 60,
  chunkDurationSeconds: 15 * 60,
  publisherTranscriptMaximumBytes: 8 * 1024 * 1024,
});

export type PublisherTranscriptResult = Readonly<{
  segments: readonly CanonicalTranscriptSegmentV1[];
  language: string | null;
  providerRevision: string;
  artifactHash: string;
  artifactAttemptCount: number;
  transport: PublicHttpResult;
}>;

const jsonSegmentsSchema = z
  .object({
    segments: z
      .array(
        z
          .object({
            startMs: z.number().int().nonnegative(),
            endMs: z.number().int().positive(),
            text: z.string().min(1).max(20_000),
          })
          .strict(),
      )
      .min(1)
      .max(20_000),
    language: z.string().min(1).max(64).nullable().optional(),
  })
  .strict();

function cueTimestampMs(value: string): number {
  const normalized = value.trim().replace(',', '.');
  const parts = normalized.split(':');
  if (parts.length < 2 || parts.length > 3) throw new Error('TRANSCRIPT_TIMECODE_INVALID');
  const seconds = Number(parts.at(-1));
  const minutes = Number(parts.at(-2));
  const hours = parts.length === 3 ? Number(parts[0]) : 0;
  if (
    !Number.isFinite(hours) ||
    !Number.isFinite(minutes) ||
    !Number.isFinite(seconds) ||
    hours < 0 ||
    minutes < 0 ||
    minutes >= 60 ||
    seconds < 0 ||
    seconds >= 60
  ) {
    throw new Error('TRANSCRIPT_TIMECODE_INVALID');
  }
  return Math.round((hours * 3_600 + minutes * 60 + seconds) * 1_000);
}

function cueText(lines: readonly string[]): string {
  return normalizeCanonicalText(lines.join(' ').replace(/<[^>]*>/g, ' '));
}

export function parseTimedTextTranscript(value: string): readonly CanonicalTranscriptSegmentV1[] {
  const lines = value
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
  const segments: CanonicalTranscriptSegmentV1[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const timing = lines[index]?.trim() ?? '';
    if (!timing.includes('-->')) continue;
    const [rawStart, rawEndWithSettings] = timing.split('-->', 2);
    const rawEnd = rawEndWithSettings?.trim().split(/\s+/, 1)[0];
    if (!rawStart || !rawEnd) throw new Error('TRANSCRIPT_TIMECODE_INVALID');
    const startMs = cueTimestampMs(rawStart);
    const endMs = cueTimestampMs(rawEnd);
    const textLines: string[] = [];
    for (index += 1; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      if (line.trim() === '') break;
      textLines.push(line);
    }
    const text = cueText(textLines);
    if (!text || endMs <= startMs) throw new Error('TRANSCRIPT_CUE_INVALID');
    segments.push({ startMs, endMs, text });
  }
  if (segments.length === 0) throw new Error('TRANSCRIPT_HAS_NO_TIMESTAMPED_CUES');
  if (segments.length > 20_000) throw new Error('TRANSCRIPT_SEGMENT_LIMIT');
  let priorStart = -1;
  let priorEnd = -1;
  for (const segment of segments) {
    if (segment.startMs < priorStart || segment.endMs < priorEnd) {
      throw new Error('TRANSCRIPT_SEGMENTS_NOT_MONOTONIC');
    }
    priorStart = segment.startMs;
    priorEnd = segment.endMs;
  }
  return segments;
}

function parsePublisherBody(input: { value: string; contentType: string | null }): {
  segments: readonly CanonicalTranscriptSegmentV1[];
  language: string | null;
} {
  if (/application\/(?:json|ld\+json)/i.test(input.contentType ?? '')) {
    const parsed = jsonSegmentsSchema.parse(JSON.parse(input.value));
    return {
      segments: parsed.segments.map((segment) => ({
        ...segment,
        text: normalizeCanonicalText(segment.text),
      })),
      language: parsed.language ?? null,
    };
  }
  return { segments: parseTimedTextTranscript(input.value), language: null };
}

export async function fetchPublisherPodcastTranscript(input: {
  item: AcquisitionItemV1;
  timeoutMs: number;
  maximumBytes: number;
  fetchImpl?: PublicFetch;
}): Promise<PublisherTranscriptResult | null> {
  const supportedMimeType =
    /^(?:text\/(?:vtt|plain)|application\/(?:x-subrip|srt|json|ld\+json))(?:\s*;|$)/i;
  const candidates = input.item.media
    .filter(
      (media) =>
        media.kind === 'TRANSCRIPT' &&
        (media.mimeType === null || supportedMimeType.test(media.mimeType)),
    )
    .sort((left, right) => left.url.localeCompare(right.url));
  if (candidates.length === 0) return null;
  let lastError: unknown;
  for (const [index, candidate] of candidates.entries()) {
    try {
      const transport = await fetchPublicResource({
        url: candidate.url,
        timeoutMs: input.timeoutMs,
        maximumBytes: input.maximumBytes,
        fetchImpl: input.fetchImpl,
        accept:
          'text/vtt, application/x-subrip, application/srt, application/json, text/plain;q=0.8',
        acceptedContentTypes: [
          /text\/(?:vtt|plain)/i,
          /application\/(?:x-subrip|srt|json|ld\+json)/i,
        ],
        acceptedStatusCodes: [200],
      });
      if (!transport.body || !transport.bodyHash) {
        throw new Error('PUBLISHER_TRANSCRIPT_BODY_MISSING');
      }
      let value: string;
      try {
        value = new TextDecoder('utf-8', { fatal: true }).decode(transport.body);
      } catch {
        throw new Error('PUBLISHER_TRANSCRIPT_UTF8_INVALID');
      }
      const parsed = parsePublisherBody({ value, contentType: transport.contentType });
      return {
        ...parsed,
        providerRevision: 'publisher-timed-text-v1',
        artifactHash: transport.bodyHash,
        artifactAttemptCount: index + 1,
        transport,
      };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('PUBLISHER_TRANSCRIPT_CANDIDATES_EXHAUSTED');
}

export function publisherTranscriptHttpTrace(transport: PublicHttpResult): AcquisitionHttpTrace {
  return publicHttpTrace(transport);
}
