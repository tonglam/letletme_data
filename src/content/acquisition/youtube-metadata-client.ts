import { z } from 'zod';

import type { AcquisitionItemV1 } from './acquisition-contract';
import { normalizeCanonicalText, sha256CanonicalJson } from './canonicalization';

const PROVIDER_REVISION = 'youtube-data-api-v3:videos.list:1';
const PARTS = 'snippet,contentDetails,liveStreamingDetails,status';

const timestamp = z.string().datetime({ offset: true });
const videoResourceSchema = z
  .object({
    id: z.string().min(1).max(100),
    snippet: z
      .object({
        channelId: z.string().min(1).max(200),
        title: z.string().max(20_000),
        description: z.string().max(4 * 1024 * 1024),
        publishedAt: timestamp,
        liveBroadcastContent: z.enum(['none', 'upcoming', 'live']),
      })
      .passthrough(),
    contentDetails: z
      .object({
        duration: z.string().min(1).max(100),
        caption: z.enum(['true', 'false']),
      })
      .passthrough(),
    liveStreamingDetails: z
      .object({
        actualStartTime: timestamp.optional(),
        actualEndTime: timestamp.optional(),
        scheduledStartTime: timestamp.optional(),
        scheduledEndTime: timestamp.optional(),
      })
      .passthrough()
      .optional(),
    status: z
      .object({
        uploadStatus: z.string().min(1).max(100),
        privacyStatus: z.enum(['public', 'unlisted', 'private']),
      })
      .passthrough(),
  })
  .passthrough();

const responseSchema = z
  .object({
    items: z.array(videoResourceSchema).max(1),
  })
  .passthrough();

const errorSchema = z
  .object({
    error: z
      .object({
        code: z.number().int().optional(),
        message: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

export class YouTubeMetadataClientError extends Error {
  readonly failureClass: string;
  readonly httpStatus: number | null;

  constructor(message: string, failureClass: string, httpStatus: number | null = null) {
    super(message);
    this.name = 'YouTubeMetadataClientError';
    this.failureClass = failureClass;
    this.httpStatus = httpStatus;
  }
}

export type YouTubeMetadataExecution = Readonly<{
  item: AcquisitionItemV1;
  lifecycleState: 'UPCOMING' | 'LIVE' | 'FINISHED' | 'UNKNOWN';
  requestMetadataHash: string;
  responseMetadataHash: string;
  providerUnits: number;
  durationMs: number;
}>;

export type YouTubeMetadataClientLike = Readonly<{
  getVideo(input: {
    discoveryItem: AcquisitionItemV1;
    expectedChannelId: string;
  }): Promise<YouTubeMetadataExecution>;
}>;

export type YouTubeMetadataFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function parseIsoDurationSeconds(value: string): number | null {
  const match = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(value);
  if (!match) throw new YouTubeMetadataClientError('Invalid YouTube duration', 'SCHEMA_FAILED');
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3] ?? 0);
  const seconds = Number(match[4] ?? 0);
  const result = Math.ceil(days * 86_400 + hours * 3_600 + minutes * 60 + seconds);
  if (!Number.isSafeInteger(result) || result < 0 || result > 24 * 60 * 60) {
    throw new YouTubeMetadataClientError(
      'YouTube duration is outside the acquisition policy',
      'DURATION_INVALID',
    );
  }
  return result === 0 ? null : result;
}

async function boundedBody(response: Response, maximumBytes: number): Promise<string> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (Number.isSafeInteger(parsedLength) && parsedLength > maximumBytes) {
      await response.body?.cancel('YouTube metadata response exceeded the byte limit');
      throw new YouTubeMetadataClientError(
        'YouTube metadata response exceeded the byte limit',
        'OUTPUT_LIMIT',
        response.status,
      );
    }
  }
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  const reader = response.body?.getReader();
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel('YouTube metadata response exceeded the byte limit');
        throw new YouTubeMetadataClientError(
          'YouTube metadata response exceeded the byte limit',
          'OUTPUT_LIMIT',
          response.status,
        );
      }
      chunks.push(value);
    }
  }
  const buffer = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new YouTubeMetadataClientError(
      'YouTube metadata response was not valid UTF-8',
      'UTF8_INVALID',
      response.status,
    );
  }
}

function lifecycle(resource: z.infer<typeof videoResourceSchema>): {
  lifecycleState: 'UPCOMING' | 'LIVE' | 'FINISHED' | 'UNKNOWN';
  scheduledStartAt: string | null;
  actualStartAt: string | null;
  actualEndAt: string | null;
} {
  const details = resource.liveStreamingDetails;
  const scheduledStartAt = details?.scheduledStartTime ?? null;
  const actualStartAt = details?.actualStartTime ?? null;
  const actualEndAt = details?.actualEndTime ?? null;
  if (resource.snippet.liveBroadcastContent === 'upcoming') {
    return { lifecycleState: 'UPCOMING', scheduledStartAt, actualStartAt: null, actualEndAt: null };
  }
  if (resource.snippet.liveBroadcastContent === 'live') {
    if (!actualStartAt) {
      return {
        lifecycleState: 'UNKNOWN',
        scheduledStartAt,
        actualStartAt: null,
        actualEndAt: null,
      };
    }
    return { lifecycleState: 'LIVE', scheduledStartAt, actualStartAt, actualEndAt: null };
  }
  if (details && actualStartAt && !actualEndAt) {
    return { lifecycleState: 'UNKNOWN', scheduledStartAt, actualStartAt, actualEndAt: null };
  }
  if (resource.status.uploadStatus !== 'processed') {
    return { lifecycleState: 'UNKNOWN', scheduledStartAt, actualStartAt, actualEndAt };
  }
  return { lifecycleState: 'FINISHED', scheduledStartAt, actualStartAt, actualEndAt };
}

export class YouTubeMetadataClient implements YouTubeMetadataClientLike {
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maximumResponseBytes: number;
  private readonly fetchImpl: YouTubeMetadataFetch;

  constructor(input: {
    apiKey: string;
    timeoutMs: number;
    maximumResponseBytes: number;
    fetchImpl?: YouTubeMetadataFetch;
  }) {
    if (!input.apiKey.trim()) throw new Error('YouTube Data API key is required');
    if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1) {
      throw new Error('YouTube metadata timeout must be a positive integer');
    }
    if (!Number.isSafeInteger(input.maximumResponseBytes) || input.maximumResponseBytes < 1) {
      throw new Error('YouTube metadata response limit must be a positive integer');
    }
    this.apiKey = input.apiKey;
    this.timeoutMs = input.timeoutMs;
    this.maximumResponseBytes = input.maximumResponseBytes;
    this.fetchImpl = input.fetchImpl ?? fetch;
  }

  async getVideo(input: {
    discoveryItem: AcquisitionItemV1;
    expectedChannelId: string;
  }): Promise<YouTubeMetadataExecution> {
    if (input.discoveryItem.contentKind !== 'VIDEO') {
      throw new YouTubeMetadataClientError('YouTube metadata requires a video', 'REQUEST_INVALID');
    }
    const videoId = input.discoveryItem.externalItemId;
    const requestMetadataHash = sha256CanonicalJson({
      provider: 'youtube-data-api',
      operation: 'videos.list',
      revision: PROVIDER_REVISION,
      parts: PARTS,
      videoId,
    });
    const url = new URL('https://www.googleapis.com/youtube/v3/videos');
    url.searchParams.set('part', PARTS);
    url.searchParams.set('id', videoId);
    url.searchParams.set('key', this.apiKey);
    const startedAt = Date.now();
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new YouTubeMetadataClientError(
        error instanceof Error ? error.message : 'YouTube metadata transport failed',
        'TRANSPORT_FAILED',
      );
    }
    const body = await boundedBody(response, this.maximumResponseBytes);
    let decoded: unknown;
    try {
      decoded = JSON.parse(body);
    } catch {
      throw new YouTubeMetadataClientError(
        'YouTube metadata response was not JSON',
        'SCHEMA_FAILED',
        response.status,
      );
    }
    if (!response.ok) {
      const providerError = errorSchema.safeParse(decoded);
      throw new YouTubeMetadataClientError(
        providerError.success
          ? normalizeCanonicalText(
              providerError.data.error.message ?? 'YouTube API rejected request',
            )
          : `YouTube API returned HTTP ${response.status}`,
        response.status === 403 ? 'AUTH_OR_QUOTA' : 'PROVIDER_REJECTED',
        response.status,
      );
    }
    const parsed = responseSchema.safeParse(decoded);
    if (!parsed.success) {
      throw new YouTubeMetadataClientError(
        `YouTube metadata schema failed: ${parsed.error.issues[0]?.message ?? 'unknown'}`,
        'SCHEMA_FAILED',
        response.status,
      );
    }
    const resource = parsed.data.items[0];
    if (!resource) {
      throw new YouTubeMetadataClientError('YouTube video was not found', 'VIDEO_NOT_FOUND', 404);
    }
    if (resource.id !== videoId || resource.snippet.channelId !== input.expectedChannelId) {
      throw new YouTubeMetadataClientError(
        'YouTube video identity did not match the persisted channel snapshot',
        'IDENTITY_CONFLICT',
        response.status,
      );
    }
    if (resource.status.privacyStatus === 'private') {
      throw new YouTubeMetadataClientError('YouTube video is private', 'VIDEO_UNAVAILABLE', 403);
    }
    const durationSeconds = parseIsoDurationSeconds(resource.contentDetails.duration);
    const rawState = lifecycle(resource);
    const state =
      rawState.lifecycleState === 'FINISHED' && durationSeconds === null
        ? { ...rawState, lifecycleState: 'UNKNOWN' as const }
        : rawState;
    const canonicalUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
    const description = normalizeCanonicalText(resource.snippet.description);
    const item: AcquisitionItemV1 = {
      ...input.discoveryItem,
      canonicalUrl,
      sourceUrl: canonicalUrl,
      linkAvailability: 'DIRECT',
      publishedAt: resource.snippet.publishedAt,
      title: normalizeCanonicalText(resource.snippet.title) || input.discoveryItem.title,
      authorExternalId: resource.snippet.channelId,
      body: description
        ? { availability: 'EXCERPT', text: description }
        : { availability: 'METADATA_ONLY', text: null },
      media: [
        {
          kind: 'VIDEO',
          url: canonicalUrl,
          mimeType: null,
          durationSeconds,
        },
      ],
      video: {
        lifecycleState: state.lifecycleState,
        durationSeconds,
        captionsAvailable: resource.contentDetails.caption === 'true',
        scheduledStartAt: state.scheduledStartAt,
        actualStartAt: state.actualStartAt,
        actualEndAt: state.actualEndAt,
        providerRevision: PROVIDER_REVISION,
      },
    };
    const responseMetadataHash = sha256CanonicalJson({
      httpStatus: response.status,
      item,
    });
    return {
      item,
      lifecycleState: state.lifecycleState,
      requestMetadataHash,
      responseMetadataHash,
      providerUnits: 1,
      durationMs: Date.now() - startedAt,
    };
  }
}

export const YOUTUBE_METADATA_POLICY_V1 = Object.freeze({
  upcomingRecheckMinutes: 10,
  liveRecheckMinutes: 5,
});

export const YOUTUBE_TRANSCRIPT_POLICY_V1 = Object.freeze({
  maximumDurationSeconds: 3 * 60 * 60,
  maximumContentAgeMinutes: 14 * 24 * 60,
  language: 'en' as string | null,
});
