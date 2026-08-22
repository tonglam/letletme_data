import { z } from 'zod';

import {
  normalizeCanonicalText,
  sha256CanonicalJson,
  type CanonicalTranscriptSegmentV1,
  type JsonValue,
} from './canonicalization';

const publicUrl = z
  .string()
  .max(4_096)
  .url()
  .refine((value) => ['http:', 'https:'].includes(new URL(value).protocol), {
    message: 'Only public HTTP(S) URLs are supported',
  });
const isoTimestamp = z.string().datetime({ offset: true });
const nonBlankText = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => normalizeCanonicalText(value).length > 0, {
      message: 'Text cannot be blank',
    });

const validatorSchema = z
  .object({
    etag: z.string().max(1_024).nullable(),
    lastModified: z.string().max(1_024).nullable(),
    providerCursor: z.string().max(4_096).nullable(),
    cacheNotBefore: isoTimestamp.nullable(),
  })
  .strict();

const mediaSchema = z
  .object({
    kind: z.enum(['AUDIO', 'VIDEO', 'TRANSCRIPT', 'OTHER']),
    url: publicUrl,
    mimeType: z.string().max(255).nullable(),
    durationSeconds: z
      .number()
      .finite()
      .nonnegative()
      .max(24 * 60 * 60)
      .nullable(),
  })
  .strict();

const transcriptSegmentSchema = z
  .object({
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().positive(),
    text: nonBlankText(20_000),
  })
  .strict()
  .refine((segment) => segment.endMs > segment.startMs, {
    message: 'Transcript endMs must be greater than startMs',
  });

const transcriptSchema = z
  .object({
    status: z.enum([
      'NOT_APPLICABLE',
      'PROVIDED',
      'GENERATED',
      'PENDING',
      'UNAVAILABLE',
      'DEFERRED',
      'FAILED',
    ]),
    language: z.string().min(1).max(64).nullable(),
    trackKind: z.enum(['MANUAL', 'AUTO', 'UNKNOWN']).nullable(),
    providerRevision: z.string().min(1).max(200).nullable(),
    segments: z.array(transcriptSegmentSchema).max(20_000),
  })
  .strict()
  .superRefine((transcript, context) => {
    const successful = transcript.status === 'PROVIDED' || transcript.status === 'GENERATED';
    if (successful !== transcript.segments.length > 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['segments'],
        message: successful
          ? 'Successful transcript must contain segments'
          : 'Non-success transcript must not contain segments',
      });
    }
    let priorStart = -1;
    let priorEnd = -1;
    transcript.segments.forEach((segment, index) => {
      if (segment.startMs < priorStart || segment.endMs < priorEnd) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['segments', index],
          message: 'Transcript segment times must be monotonic',
        });
      }
      priorStart = segment.startMs;
      priorEnd = segment.endMs;
    });
  });

const videoStateSchema = z
  .object({
    lifecycleState: z.enum(['UPCOMING', 'LIVE', 'FINISHED', 'UNKNOWN']),
    durationSeconds: z
      .number()
      .int()
      .positive()
      .max(24 * 60 * 60)
      .nullable(),
    captionsAvailable: z.boolean().nullable(),
    scheduledStartAt: isoTimestamp.nullable(),
    actualStartAt: isoTimestamp.nullable(),
    actualEndAt: isoTimestamp.nullable(),
    providerRevision: z.string().min(1).max(200),
  })
  .strict()
  .superRefine((video, context) => {
    if (video.lifecycleState === 'UPCOMING' && video.actualStartAt !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['actualStartAt'],
        message: 'UPCOMING video cannot have an actual start time',
      });
    }
    if (video.lifecycleState === 'LIVE' && video.actualStartAt === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['actualStartAt'],
        message: 'LIVE video requires an actual start time',
      });
    }
    if (video.lifecycleState !== 'FINISHED' && video.actualEndAt !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['actualEndAt'],
        message: 'Only a FINISHED video can have an actual end time',
      });
    }
  });

export const acquisitionItemV1Schema = z
  .object({
    endpointKey: z.string().min(1).max(100),
    externalItemId: nonBlankText(1_024),
    canonicalUrl: publicUrl.nullable(),
    sourceUrl: publicUrl.nullable(),
    linkAvailability: z.enum(['DIRECT', 'SOURCE_LANDING', 'MISSING']),
    publishedAt: isoTimestamp.nullable(),
    updatedAt: isoTimestamp.nullable(),
    title: nonBlankText(2_000).nullable(),
    authorExternalId: nonBlankText(1_024).nullable(),
    contentKind: z.enum(['POST', 'ARTICLE', 'EPISODE', 'VIDEO']),
    body: z
      .object({
        availability: z.enum(['FULL', 'EXCERPT', 'METADATA_ONLY']),
        text: nonBlankText(4 * 1_024 * 1_024).nullable(),
      })
      .strict(),
    media: z.array(mediaSchema).max(64),
    transcript: transcriptSchema,
    video: videoStateSchema.nullable().optional(),
  })
  .strict()
  .superRefine((item, context) => {
    if (item.endpointKey.trim() !== item.endpointKey) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endpointKey'],
        message: 'endpointKey must already be canonical',
      });
    }
    if (item.linkAvailability === 'MISSING') {
      if (item.canonicalUrl !== null || item.sourceUrl !== null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['linkAvailability'],
          message: 'MISSING requires canonicalUrl and sourceUrl to be null',
        });
      }
    } else if (!item.sourceUrl) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['sourceUrl'],
        message: `${item.linkAvailability} requires a user-openable sourceUrl`,
      });
    }
    const hasBody = item.body.text !== null;
    if (hasBody !== (item.body.availability !== 'METADATA_ONLY')) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['body'],
        message: 'Body availability and text must agree',
      });
    }
    if (
      item.publishedAt &&
      item.updatedAt &&
      Date.parse(item.updatedAt) < Date.parse(item.publishedAt)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['updatedAt'],
        message: 'updatedAt cannot precede publishedAt',
      });
    }
    const durationMs = item.media
      .map((media) =>
        media.durationSeconds === null ? null : Math.round(media.durationSeconds * 1_000),
      )
      .find((duration): duration is number => duration !== null);
    const finalSegment = item.transcript.segments.at(-1);
    if (durationMs !== undefined && finalSegment && finalSegment.endMs > durationMs + 2_000) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['transcript', 'segments'],
        message: 'Transcript exceeds known media duration tolerance',
      });
    }
    if (item.contentKind !== 'VIDEO' && item.video !== undefined && item.video !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['video'],
        message: 'Only VIDEO facts may contain video state',
      });
    }
  });

export const acquisitionBatchV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    endpointKey: z.string().min(1).max(100),
    checkedAt: isoTimestamp,
    validator: validatorSchema,
    transportBodyHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
    items: z.array(acquisitionItemV1Schema).max(1_000),
  })
  .strict()
  .superRefine((batch, context) => {
    const seen = new Map<string, string>();
    batch.items.forEach((item, index) => {
      if (item.endpointKey !== batch.endpointKey) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['items', index, 'endpointKey'],
          message: 'Item endpointKey must match the batch',
        });
      }
      const canonical = canonicalAcquisitionItem(item);
      const prior = seen.get(item.externalItemId);
      if (prior && prior !== canonical.hash) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['items', index, 'externalItemId'],
          message: 'The batch contains conflicting facts for one external item ID',
        });
      } else {
        seen.set(item.externalItemId, canonical.hash);
      }
    });
  });

export type AcquisitionItemV1 = z.infer<typeof acquisitionItemV1Schema>;
export type AcquisitionBatchV1 = z.infer<typeof acquisitionBatchV1Schema>;

const TRACKING_PARAMETERS = new Set([
  'fbclid',
  'gclid',
  'mc_cid',
  'mc_eid',
  'utm_campaign',
  'utm_content',
  'utm_medium',
  'utm_source',
  'utm_term',
]);

export function canonicalizePublicUrl(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported public URL scheme');
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  for (const parameter of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMETERS.has(parameter.toLowerCase())) url.searchParams.delete(parameter);
  }
  return url.toString();
}

function nullableText(value: string | null): string | null {
  if (value === null) return null;
  const normalized = normalizeCanonicalText(value);
  return normalized || null;
}

export function canonicalAcquisitionItem(item: AcquisitionItemV1): {
  payload: JsonValue;
  hash: string;
  segments: readonly CanonicalTranscriptSegmentV1[];
} {
  const segments = item.transcript.segments.map((segment) => ({
    startMs: segment.startMs,
    endMs: segment.endMs,
    text: normalizeCanonicalText(segment.text),
  }));
  const payload: JsonValue = {
    schemaVersion: 1,
    endpointKey: item.endpointKey,
    externalItemId: normalizeCanonicalText(item.externalItemId),
    canonicalUrl: item.canonicalUrl ? canonicalizePublicUrl(item.canonicalUrl) : null,
    sourceUrl: item.sourceUrl ? canonicalizePublicUrl(item.sourceUrl) : null,
    linkAvailability: item.linkAvailability,
    publishedAt: item.publishedAt,
    updatedAt: item.updatedAt,
    title: nullableText(item.title),
    authorExternalId: nullableText(item.authorExternalId),
    contentKind: item.contentKind,
    body: {
      availability: item.body.availability,
      text: nullableText(item.body.text),
    },
    media: [...item.media]
      .map((media) => ({
        kind: media.kind,
        url: canonicalizePublicUrl(media.url),
        mimeType: nullableText(media.mimeType),
        durationSeconds: media.durationSeconds,
      }))
      .sort((left, right) => left.url.localeCompare(right.url)),
    transcript: {
      status: item.transcript.status,
      language: nullableText(item.transcript.language),
      trackKind: item.transcript.trackKind,
      providerRevision: nullableText(item.transcript.providerRevision),
      segments,
    },
    video: item.video ?? null,
  };
  return { payload, hash: sha256CanonicalJson(payload), segments };
}

export function parseAcquisitionBatchV1(value: unknown): AcquisitionBatchV1 {
  return acquisitionBatchV1Schema.parse(value);
}

export function parseCanonicalAcquisitionItemV1(value: unknown): AcquisitionItemV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Canonical acquisition item payload must be an object');
  }
  const { schemaVersion, ...item } = value as Record<string, unknown>;
  if (schemaVersion !== 1) throw new Error('Unsupported canonical acquisition item version');
  return acquisitionItemV1Schema.parse(item);
}
