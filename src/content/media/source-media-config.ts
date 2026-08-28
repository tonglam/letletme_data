import { z } from 'zod';

import { parseStrictIntegerEnv } from '../config';
import { parseStrictBooleanEnvValue } from '../../utils/config';

function booleanEnv(defaultValue: boolean) {
  return z.preprocess((value) => {
    if (value === undefined || value === '') return defaultValue;
    if (typeof value === 'boolean') return value;
    if (typeof value !== 'string') return value;
    return parseStrictBooleanEnvValue(value, defaultValue, 'content media boolean');
  }, z.boolean());
}

function optionalTrimmedString() {
  return z.preprocess(
    (value) => (typeof value === 'string' && value.trim() ? value.trim() : undefined),
    z.string().min(1).optional(),
  );
}

const sourceMediaEnvSchema = z.object({
  CONTENT_MEDIA_WORKER_ENABLED: booleanEnv(false),
  CONTENT_MEDIA_SUPABASE_URL: optionalTrimmedString().pipe(z.string().url().optional()),
  CONTENT_MEDIA_SUPABASE_SECRET_KEY: optionalTrimmedString(),
  CONTENT_MEDIA_BUCKET: z.literal('briefing-source-media').default('briefing-source-media'),
  CONTENT_MEDIA_RETENTION_ENABLED: booleanEnv(false),
});

export type SourceMediaRuntimeConfig = Readonly<{
  enabled: boolean;
  supabaseUrl: string | null;
  secretKey: string | null;
  bucket: string;
  concurrency: number;
  retentionEnabled: boolean;
}>;

export function getSourceMediaRuntimeConfig(
  options: { requireCredentials?: boolean } = {},
): SourceMediaRuntimeConfig {
  const parsed = sourceMediaEnvSchema.parse(process.env);
  const rawConcurrency = process.env.CONTENT_MEDIA_CONCURRENCY?.trim();
  if (rawConcurrency && /^[+-]?\d+$/.test(rawConcurrency) && Number(rawConcurrency) !== 2) {
    throw new Error('CONTENT_MEDIA_CONCURRENCY is fixed at 2');
  }
  const concurrency = parseStrictIntegerEnv(
    process.env.CONTENT_MEDIA_CONCURRENCY,
    2,
    2,
    2,
    'CONTENT_MEDIA_CONCURRENCY',
  );
  const requireCredentials = options.requireCredentials || parsed.CONTENT_MEDIA_WORKER_ENABLED;
  if (
    requireCredentials &&
    (!parsed.CONTENT_MEDIA_SUPABASE_URL || !parsed.CONTENT_MEDIA_SUPABASE_SECRET_KEY)
  ) {
    throw new Error(
      'CONTENT_MEDIA_SUPABASE_URL and CONTENT_MEDIA_SUPABASE_SECRET_KEY are required for media worker execution',
    );
  }
  if (
    parsed.CONTENT_MEDIA_SUPABASE_URL &&
    new URL(parsed.CONTENT_MEDIA_SUPABASE_URL).protocol !== 'https:'
  ) {
    throw new Error('CONTENT_MEDIA_SUPABASE_URL must use HTTPS');
  }
  if (parsed.CONTENT_MEDIA_RETENTION_ENABLED && !parsed.CONTENT_MEDIA_WORKER_ENABLED) {
    throw new Error('CONTENT_MEDIA_RETENTION_ENABLED requires CONTENT_MEDIA_WORKER_ENABLED');
  }
  return {
    enabled: parsed.CONTENT_MEDIA_WORKER_ENABLED,
    supabaseUrl: parsed.CONTENT_MEDIA_SUPABASE_URL ?? null,
    secretKey: parsed.CONTENT_MEDIA_SUPABASE_SECRET_KEY ?? null,
    bucket: parsed.CONTENT_MEDIA_BUCKET,
    concurrency,
    retentionEnabled: parsed.CONTENT_MEDIA_RETENTION_ENABLED,
  };
}
