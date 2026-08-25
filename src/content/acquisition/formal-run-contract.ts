import { z } from 'zod';

import { acquisitionItemV1Schema } from './acquisition-contract';
import type { JsonValue } from './canonicalization';
import { xToolRequestV1Schema } from './x-query-compiler';

const isoTimestamp = z.string().datetime({ offset: true });
const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);
const jsonObject: z.ZodType<Record<string, JsonValue>> = z.record(z.string(), jsonValueSchema);

export const acquisitionJobV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string().uuid(),
  })
  .strict();

export type AcquisitionJobV1 = z.infer<typeof acquisitionJobV1Schema>;

const endpointSnapshotSchema = z
  .object({
    endpointId: z.string().uuid(),
    endpointKey: z.string().min(1).max(100),
    sourceId: z.string().uuid(),
    sourceKey: z.string().min(1).max(100),
    adapterKind: z.enum(['X_ACCOUNT', 'X_SEMANTIC', 'RSS_ATOM', 'PODCAST_FEED', 'YOUTUBE_CHANNEL']),
    profileKey: z.string().min(1).max(100),
    locator: z.record(z.string(), z.string()),
    stableExternalId: z.string().min(1).max(4_096).nullable(),
    // Optional for backward-compatible replay of pre-policy snapshots. New
    // scheduler requests include the persisted control-plane policy.
    identityRequirement: z
      .enum(['REQUIRED', 'HANDLE_ONLY', 'DISCOVERED_ONLY', 'NOT_APPLICABLE'])
      .optional(),
    rightsPolicy: jsonObject,
  })
  .strict();

const commonSchema = z.object({
  schemaVersion: z.literal(1),
  phase: z.enum(['NORMAL', 'APPROACHING', 'FINAL90']),
  profileKey: z.string().min(1).max(100),
  profileRevision: z.number().int().positive(),
  windowStart: isoTimestamp,
  windowEnd: isoTimestamp,
});

const feedPollRunRequestV1Schema = commonSchema
  .extend({
    jobKind: z.literal('FEED_POLL'),
    adapterKind: z.enum(['RSS_ATOM', 'PODCAST_FEED', 'YOUTUBE_CHANNEL']),
    endpoint: endpointSnapshotSchema,
    validator: z
      .object({
        etag: z.string().max(1_024).nullable(),
        lastModified: z.string().max(1_024).nullable(),
      })
      .strict(),
    bootstrap: z
      .object({
        enabled: z.boolean(),
        cutoffAt: isoTimestamp,
        lookbackMinutes: z.number().int().positive(),
        maxItems: z.number().int().positive(),
        maxContentJobs: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

const xScanRunRequestV1Schema = commonSchema
  .extend({
    jobKind: z.enum(['X_KEYWORD_SCAN', 'X_SEMANTIC_SCAN', 'X_THREAD_FETCH']),
    adapterKind: z.enum(['X_ACCOUNT', 'X_SEMANTIC']),
    coverageMode: z.enum(['PRIMARY', 'BACKSTOP']).default('PRIMARY'),
    partition: z
      .object({
        partitionId: z.string().uuid(),
        partitionKey: z.string().min(1).max(100),
        members: z.array(endpointSnapshotSchema).min(1).max(20),
      })
      .strict(),
    toolRequest: xToolRequestV1Schema,
  })
  .strict()
  .superRefine((request, context) => {
    if (
      (request.jobKind === 'X_KEYWORD_SCAN' &&
        request.toolRequest.toolName !== 'x_keyword_search') ||
      (request.jobKind === 'X_SEMANTIC_SCAN' &&
        request.toolRequest.toolName !== 'x_semantic_search') ||
      (request.jobKind === 'X_THREAD_FETCH' && request.toolRequest.toolName !== 'x_thread_fetch')
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['toolRequest', 'toolName'],
        message: 'X job kind and tool request must agree',
      });
    }
  });

const xIdentityRunRequestV1Schema = commonSchema
  .extend({
    jobKind: z.literal('X_IDENTITY'),
    adapterKind: z.literal('X_ACCOUNT'),
    endpoint: endpointSnapshotSchema,
    toolRequest: xToolRequestV1Schema,
  })
  .strict()
  .superRefine((request, context) => {
    if (
      request.endpoint.adapterKind !== 'X_ACCOUNT' ||
      request.toolRequest.toolName !== 'x_user_search'
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['toolRequest', 'toolName'],
        message: 'X identity jobs require one X account endpoint and x_user_search',
      });
    }
  });

const articleFetchRunRequestV1Schema = commonSchema
  .extend({
    jobKind: z.literal('ARTICLE_FETCH'),
    adapterKind: z.literal('ARTICLE_HTTP'),
    endpoint: endpointSnapshotSchema,
    discoveryItem: acquisitionItemV1Schema,
    allowedOrigins: z.array(z.string().url()).min(1).max(8),
    validator: z
      .object({
        etag: z.string().max(1_024).nullable(),
        lastModified: z.string().max(1_024).nullable(),
      })
      .strict(),
  })
  .strict();

const podcastTranscriptRunRequestV1Schema = commonSchema
  .extend({
    jobKind: z.literal('PODCAST_TRANSCRIPT'),
    adapterKind: z.literal('HERMES_TRANSCRIPT'),
    endpoint: endpointSnapshotSchema,
    discoveryItem: acquisitionItemV1Schema,
    policy: z
      .object({
        maximumDurationSeconds: z
          .number()
          .int()
          .positive()
          .max(24 * 60 * 60),
        chunkDurationSeconds: z
          .number()
          .int()
          .positive()
          .max(60 * 60),
        publisherTranscriptMaximumBytes: z
          .number()
          .int()
          .positive()
          .max(32 * 1024 * 1024),
      })
      .strict(),
  })
  .strict()
  .superRefine((request, context) => {
    if (
      request.endpoint.adapterKind !== 'PODCAST_FEED' ||
      request.discoveryItem.contentKind !== 'EPISODE' ||
      request.discoveryItem.endpointKey !== request.endpoint.endpointKey ||
      request.discoveryItem.transcript.status !== 'PENDING'
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['discoveryItem'],
        message: 'Podcast transcript jobs require one pending episode from the target feed',
      });
    }
    if (!request.discoveryItem.media.some((media) => media.kind === 'AUDIO')) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['discoveryItem', 'media'],
        message: 'Podcast transcript jobs require one public audio enclosure',
      });
    }
  });

const youtubeMetadataRunRequestV1Schema = commonSchema
  .extend({
    jobKind: z.literal('YOUTUBE_METADATA'),
    adapterKind: z.literal('YOUTUBE_CHANNEL'),
    endpoint: endpointSnapshotSchema,
    discoveryItem: acquisitionItemV1Schema,
    policy: z
      .object({
        upcomingRecheckMinutes: z
          .number()
          .int()
          .positive()
          .max(24 * 60),
        liveRecheckMinutes: z
          .number()
          .int()
          .positive()
          .max(24 * 60),
      })
      .strict(),
  })
  .strict()
  .superRefine((request, context) => {
    if (
      request.endpoint.adapterKind !== 'YOUTUBE_CHANNEL' ||
      request.discoveryItem.contentKind !== 'VIDEO' ||
      request.discoveryItem.endpointKey !== request.endpoint.endpointKey ||
      request.discoveryItem.transcript.status !== 'PENDING'
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['discoveryItem'],
        message: 'YouTube metadata jobs require one pending video from the target channel',
      });
    }
  });

const youtubeTranscriptRunRequestV1Schema = commonSchema
  .extend({
    jobKind: z.literal('YOUTUBE_TRANSCRIPT'),
    adapterKind: z.literal('SUPADATA_TRANSCRIPT'),
    endpoint: endpointSnapshotSchema,
    discoveryItem: acquisitionItemV1Schema,
    mode: z.enum(['NATIVE', 'AUTO']),
    attemptStage: z.enum(['NATIVE_FIRST', 'NATIVE_SECOND', 'GENERATED']),
    policy: z
      .object({
        maximumDurationSeconds: z
          .number()
          .int()
          .positive()
          .max(24 * 60 * 60),
        maximumContentAgeMinutes: z
          .number()
          .int()
          .positive()
          .max(365 * 24 * 60),
        language: z.string().min(2).max(64).nullable(),
      })
      .strict(),
  })
  .strict()
  .superRefine((request, context) => {
    const video = request.discoveryItem.video;
    const transcriptStatusAccepted =
      request.discoveryItem.transcript.status === 'PENDING' ||
      (request.attemptStage === 'GENERATED' &&
        request.discoveryItem.transcript.status === 'DEFERRED');
    if (
      request.endpoint.adapterKind !== 'YOUTUBE_CHANNEL' ||
      request.discoveryItem.contentKind !== 'VIDEO' ||
      request.discoveryItem.endpointKey !== request.endpoint.endpointKey ||
      !transcriptStatusAccepted ||
      !video ||
      video.lifecycleState !== 'FINISHED' ||
      video.durationSeconds === null
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['discoveryItem'],
        message:
          'YouTube transcript jobs require one finished, duration-bearing pending video; generated fallback may resume a deferred video',
      });
    }
    if ((request.attemptStage === 'GENERATED') !== (request.mode === 'AUTO')) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mode'],
        message: 'Generated stage must use AUTO and native stages must use NATIVE',
      });
    }
  });

export const formalRunRequestV1Schema = z.union([
  feedPollRunRequestV1Schema,
  xIdentityRunRequestV1Schema,
  xScanRunRequestV1Schema,
  articleFetchRunRequestV1Schema,
  podcastTranscriptRunRequestV1Schema,
  youtubeMetadataRunRequestV1Schema,
  youtubeTranscriptRunRequestV1Schema,
]);

export type FormalRunRequestV1 = z.infer<typeof formalRunRequestV1Schema>;
export type FeedPollRunRequestV1 = z.infer<typeof feedPollRunRequestV1Schema>;
export type XScanRunRequestV1 = z.infer<typeof xScanRunRequestV1Schema>;
export type XIdentityRunRequestV1 = z.infer<typeof xIdentityRunRequestV1Schema>;
export type ArticleFetchRunRequestV1 = z.infer<typeof articleFetchRunRequestV1Schema>;
export type PodcastTranscriptRunRequestV1 = z.infer<typeof podcastTranscriptRunRequestV1Schema>;
export type YouTubeMetadataRunRequestV1 = z.infer<typeof youtubeMetadataRunRequestV1Schema>;
export type YouTubeTranscriptRunRequestV1 = z.infer<typeof youtubeTranscriptRunRequestV1Schema>;

export function parseFormalRunRequestV1(value: unknown): FormalRunRequestV1 {
  return formalRunRequestV1Schema.parse(value);
}
