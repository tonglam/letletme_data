import { withDatabaseTransaction, getDbClient } from '../db/singleton';
import type postgres from 'postgres';

export const CLIENT_SIGNAL_MAX_BYTES = 16 * 1024;
export const CLIENT_SIGNAL_MAX_SAMPLES = 50;
export const CLIENT_SIGNAL_WINDOW_MS = 5 * 60 * 1000;
export const CLIENT_SIGNAL_BATCH_RETENTION_MS = 48 * 60 * 60 * 1000;
export const CLIENT_SIGNAL_WINDOW_RETENTION_MS = 28 * 24 * 60 * 60 * 1000;

export function clientSignalRetentionCutoffs(now: Date): {
  windowBefore: string;
  batchesBefore: string;
} {
  const timestamp = now.getTime();
  if (!Number.isFinite(timestamp)) throw new Error('Client signal retention time is invalid');
  return {
    windowBefore: new Date(timestamp - CLIENT_SIGNAL_WINDOW_RETENTION_MS).toISOString(),
    batchesBefore: new Date(timestamp - CLIENT_SIGNAL_BATCH_RETENTION_MS).toISOString(),
  };
}

function clientSignalSqlTimestamp(value: Date, label: string): string {
  const timestamp = value.getTime();
  if (!Number.isFinite(timestamp)) throw new Error(`Client signal ${label} is invalid`);
  return value.toISOString();
}

const CLIENTS = ['web', 'wechat_miniprogram'] as const;
const SURFACES = [
  'home',
  'live_matches',
  'live_match',
  'live_entry',
  'price_changes',
  'my_fpl',
  'player_stats',
  'fixtures',
  'auth',
  'other',
] as const;
const METRICS = [
  'route_ready_ms',
  'api_duration_ms',
  'graphql_proxy_ms',
  'lcp_ms',
  'inp_ms',
  'cls',
  'availability',
  'auth_result',
  'runtime_error',
  'update_failure',
  'last_good_age_ms',
  'live_matches_head_ms',
  'live_matches_full_ms',
  'live_matches_head_bytes',
  'live_matches_full_bytes',
  'live_matches_head_result',
  'live_matches_full_result',
  'live_matches_revision_changed',
] as const;
const DEVICE_GROUPS = [
  'mobile',
  'tablet',
  'desktop',
  'wechat_phone',
  'wechat_devtools',
  'unknown',
] as const;
const SAMPLE_SOURCES = ['real', 'synthetic'] as const;
const RESULTS = ['ok', 'error', 'timeout', 'auth_error', 'stale', 'unavailable'] as const;

const NUMERIC_METRICS = new Set<ClientSignalMetric>([
  'route_ready_ms',
  'api_duration_ms',
  'graphql_proxy_ms',
  'lcp_ms',
  'inp_ms',
  'cls',
  'last_good_age_ms',
  'live_matches_head_ms',
  'live_matches_full_ms',
  'live_matches_head_bytes',
  'live_matches_full_bytes',
]);

const MAX_NUMERIC_VALUES: Partial<Record<ClientSignalMetric, number>> = {
  live_matches_head_ms: 10_000_000,
  live_matches_full_ms: 10_000_000,
  live_matches_head_bytes: 512 * 1024,
  live_matches_full_bytes: 8 * 1024 * 1024,
};

const BYTE_METRICS = new Set<ClientSignalMetric>([
  'live_matches_head_bytes',
  'live_matches_full_bytes',
]);

type ValueOf<T extends readonly string[]> = T[number];
export type ClientSignalClient = ValueOf<typeof CLIENTS>;
export type ClientSignalSurface = ValueOf<typeof SURFACES>;
export type ClientSignalMetric = ValueOf<typeof METRICS>;
export type ClientSignalDeviceGroup = ValueOf<typeof DEVICE_GROUPS>;
export type ClientSignalSampleSource = ValueOf<typeof SAMPLE_SOURCES>;
export type ClientSignalResult = ValueOf<typeof RESULTS>;
export const CLIENT_SIGNAL_REASON_CODES = [
  'none',
  'auth',
  'validation',
  'rate_limit',
  'client_abort',
  'upstream_timeout',
  'connection',
  'unavailable',
  'unknown',
] as const;
export type ClientSignalReasonCode = ValueOf<typeof CLIENT_SIGNAL_REASON_CODES>;
export const CLIENT_SIGNAL_MEASUREMENT_KINDS = [
  'initial_navigation',
  'in_page_navigation',
  'interaction',
  'background_resume',
  'missing_start',
  'request',
] as const;
export type ClientSignalMeasurementKind = ValueOf<typeof CLIENT_SIGNAL_MEASUREMENT_KINDS>;

export type ClientSignalBatchV1 = {
  schemaVersion: 1;
  batchId: string;
  client: ClientSignalClient;
  release: string;
  sentAt: string;
  samples: Array<{
    observedAt: string;
    surface: ClientSignalSurface;
    metric: ClientSignalMetric;
    deviceGroup: ClientSignalDeviceGroup;
    sampleSource: ClientSignalSampleSource;
    result: ClientSignalResult;
    value?: number;
  }>;
};

export type ClientSignalBatchV2 = {
  schemaVersion: 2;
  batchId: string;
  client: ClientSignalClient;
  clientRelease: string;
  ingestRelease: string;
  sentAt: string;
  samples: Array<{
    observedAt: string;
    surface: ClientSignalSurface;
    metric: ClientSignalMetric;
    deviceGroup: ClientSignalDeviceGroup;
    sampleSource: ClientSignalSampleSource;
    result: ClientSignalResult;
    reasonCode: ClientSignalReasonCode;
    measurementKind: ClientSignalMeasurementKind;
    samplingProbability: number;
    errorClass?: string;
    fingerprint?: string;
    occurrenceCount?: number;
    firstObservedAt?: string;
    lastObservedAt?: string;
    value?: number;
  }>;
};

export class ClientSignalValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClientSignalValidationError';
  }
}

type AggregatedSignal = {
  windowStart: Date;
  client: ClientSignalClient;
  release: string;
  surface: ClientSignalSurface;
  metric: ClientSignalMetric;
  deviceGroup: ClientSignalDeviceGroup;
  sampleSource: ClientSignalSampleSource;
  result: ClientSignalResult;
  bucket: string;
  sampleCount: number;
  valueSum: number;
};

export type AggregatedSignalV2 = {
  windowStart: Date;
  client: ClientSignalClient;
  clientRelease: string;
  ingestRelease: string;
  surface: ClientSignalSurface;
  metric: ClientSignalMetric;
  deviceGroup: ClientSignalDeviceGroup;
  sampleSource: ClientSignalSampleSource;
  result: ClientSignalResult;
  reasonCode: ClientSignalReasonCode;
  measurementKind: ClientSignalMeasurementKind;
  errorClass: string | null;
  fingerprint: string | null;
  bucket: string;
  observedCount: number;
  occurrenceCount: number;
  estimatedCount: number;
  valueSum: number;
  firstObservedAt: Date;
  lastObservedAt: Date;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isOneOf = <T extends readonly string[]>(value: unknown, values: T): value is T[number] =>
  typeof value === 'string' && (values as readonly string[]).includes(value);

const isUuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

const isSafeDimension = (value: unknown, maxLength = 64): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= maxLength &&
  /^[A-Za-z0-9._-]+$/.test(value);

const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key));

function parseObservedAt(value: unknown, now: number): Date {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  ) {
    throw new ClientSignalValidationError('observedAt must be an ISO timestamp');
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new ClientSignalValidationError('observedAt must be an ISO timestamp');
  }
  if (timestamp < now - 24 * 60 * 60 * 1000 || timestamp > now + 5 * 60 * 1000) {
    throw new ClientSignalValidationError('observedAt is outside the accepted time window');
  }
  return new Date(timestamp);
}

export function parseClientSignalBatch(value: unknown, now = Date.now()): ClientSignalBatchV1 {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['schemaVersion', 'batchId', 'client', 'release', 'sentAt', 'samples'])
  ) {
    throw new ClientSignalValidationError('unsupported client signal schema');
  }
  if (value.schemaVersion !== 1) {
    throw new ClientSignalValidationError('unsupported client signal schema version');
  }
  if (!isUuid(value.batchId)) throw new ClientSignalValidationError('batchId must be a UUID');
  if (!isOneOf(value.client, CLIENTS)) throw new ClientSignalValidationError('client is invalid');
  if (!isSafeDimension(value.release)) throw new ClientSignalValidationError('release is invalid');
  const sentAt = parseObservedAt(value.sentAt, now);
  if (
    !Array.isArray(value.samples) ||
    value.samples.length === 0 ||
    value.samples.length > CLIENT_SIGNAL_MAX_SAMPLES
  ) {
    throw new ClientSignalValidationError(
      `samples must contain 1-${CLIENT_SIGNAL_MAX_SAMPLES} items`,
    );
  }

  const samples = value.samples.map((sample) => {
    if (
      !isRecord(sample) ||
      !hasOnlyKeys(sample, [
        'observedAt',
        'surface',
        'metric',
        'deviceGroup',
        'sampleSource',
        'result',
        'value',
      ])
    ) {
      throw new ClientSignalValidationError('sample contains an unsupported field');
    }
    if (!isOneOf(sample.surface, SURFACES))
      throw new ClientSignalValidationError('surface is invalid');
    if (!isOneOf(sample.metric, METRICS))
      throw new ClientSignalValidationError('metric is invalid');
    if (!isOneOf(sample.deviceGroup, DEVICE_GROUPS))
      throw new ClientSignalValidationError('deviceGroup is invalid');
    if (!isOneOf(sample.sampleSource, SAMPLE_SOURCES))
      throw new ClientSignalValidationError('sampleSource is invalid');
    if (!isOneOf(sample.result, RESULTS))
      throw new ClientSignalValidationError('result is invalid');
    const observedAt = parseObservedAt(sample.observedAt, now);
    if (
      sample.value !== undefined &&
      (typeof sample.value !== 'number' || !Number.isFinite(sample.value) || sample.value < 0)
    ) {
      throw new ClientSignalValidationError('value must be a finite non-negative number');
    }
    const numericMetric = NUMERIC_METRICS.has(sample.metric);
    if (numericMetric && typeof sample.value !== 'number') {
      throw new ClientSignalValidationError(`value is required for ${sample.metric}`);
    }
    const maximum = MAX_NUMERIC_VALUES[sample.metric];
    if (maximum !== undefined && typeof sample.value === 'number' && sample.value > maximum) {
      throw new ClientSignalValidationError(`value is too large for ${sample.metric}`);
    }
    return {
      observedAt: observedAt.toISOString(),
      surface: sample.surface,
      metric: sample.metric,
      deviceGroup: sample.deviceGroup,
      sampleSource: sample.sampleSource,
      result: sample.result,
      ...(sample.value === undefined ? {} : { value: sample.value }),
    };
  });

  return {
    schemaVersion: 1,
    batchId: value.batchId,
    client: value.client,
    release: value.release,
    sentAt: sentAt.toISOString(),
    samples,
  };
}

const isSafeDiagnosticDimension = (value: unknown, maxLength = 128): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= maxLength &&
  /^[A-Za-z0-9._:-]+$/.test(value);

const MAX_V2_NUMERIC_VALUES: Partial<Record<ClientSignalMetric, number>> = {
  route_ready_ms: 10_000_000,
  api_duration_ms: 10_000_000,
  graphql_proxy_ms: 10_000_000,
  lcp_ms: 10_000_000,
  inp_ms: 10_000_000,
  cls: 10,
  last_good_age_ms: 24 * 60 * 60 * 1000,
  live_matches_head_ms: 10_000_000,
  live_matches_full_ms: 10_000_000,
  live_matches_head_bytes: 512 * 1024,
  live_matches_full_bytes: 8 * 1024 * 1024,
};

function parseV2Number(value: unknown, metric: ClientSignalMetric): number | undefined {
  if (value === undefined) return undefined;
  const maximum = MAX_V2_NUMERIC_VALUES[metric];
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    (maximum !== undefined && value > maximum)
  ) {
    throw new ClientSignalValidationError(`value is invalid for ${metric}`);
  }
  return value;
}

export function parseClientSignalBatchV2(value: unknown, now = Date.now()): ClientSignalBatchV2 {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'schemaVersion',
      'batchId',
      'client',
      'clientRelease',
      'ingestRelease',
      'sentAt',
      'samples',
    ])
  ) {
    throw new ClientSignalValidationError('unsupported client signal v2 schema');
  }
  if (value.schemaVersion !== 2) {
    throw new ClientSignalValidationError('unsupported client signal schema version');
  }
  if (!isUuid(value.batchId)) throw new ClientSignalValidationError('batchId must be a UUID');
  if (!isOneOf(value.client, CLIENTS)) throw new ClientSignalValidationError('client is invalid');
  if (!isSafeDiagnosticDimension(value.clientRelease)) {
    throw new ClientSignalValidationError('clientRelease is invalid');
  }
  if (!isSafeDiagnosticDimension(value.ingestRelease)) {
    throw new ClientSignalValidationError('ingestRelease is invalid');
  }
  const sentAt = parseObservedAt(value.sentAt, now);
  if (
    !Array.isArray(value.samples) ||
    value.samples.length === 0 ||
    value.samples.length > CLIENT_SIGNAL_MAX_SAMPLES
  ) {
    throw new ClientSignalValidationError(
      `samples must contain 1-${CLIENT_SIGNAL_MAX_SAMPLES} items`,
    );
  }

  const samples = value.samples.map((sample) => {
    if (
      !isRecord(sample) ||
      !hasOnlyKeys(sample, [
        'observedAt',
        'surface',
        'metric',
        'deviceGroup',
        'sampleSource',
        'result',
        'reasonCode',
        'measurementKind',
        'samplingProbability',
        'errorClass',
        'fingerprint',
        'occurrenceCount',
        'firstObservedAt',
        'lastObservedAt',
        'value',
      ])
    ) {
      throw new ClientSignalValidationError('sample contains an unsupported field');
    }
    if (!isOneOf(sample.surface, SURFACES))
      throw new ClientSignalValidationError('surface is invalid');
    if (!isOneOf(sample.metric, METRICS))
      throw new ClientSignalValidationError('metric is invalid');
    if (!isOneOf(sample.deviceGroup, DEVICE_GROUPS))
      throw new ClientSignalValidationError('deviceGroup is invalid');
    if (!isOneOf(sample.sampleSource, SAMPLE_SOURCES))
      throw new ClientSignalValidationError('sampleSource is invalid');
    if (!isOneOf(sample.result, RESULTS))
      throw new ClientSignalValidationError('result is invalid');
    if (!isOneOf(sample.reasonCode, CLIENT_SIGNAL_REASON_CODES))
      throw new ClientSignalValidationError('reasonCode is invalid');
    if (!isOneOf(sample.measurementKind, CLIENT_SIGNAL_MEASUREMENT_KINDS))
      throw new ClientSignalValidationError('measurementKind is invalid');
    if (
      typeof sample.samplingProbability !== 'number' ||
      !Number.isFinite(sample.samplingProbability) ||
      sample.samplingProbability < 0.0001 ||
      sample.samplingProbability > 1
    ) {
      throw new ClientSignalValidationError('samplingProbability is invalid');
    }
    const observedAt = parseObservedAt(sample.observedAt, now);
    let occurrenceCount = 1;
    if (sample.metric === 'runtime_error') {
      if (sample.errorClass !== undefined && !isSafeDimension(sample.errorClass, 64)) {
        throw new ClientSignalValidationError('errorClass is invalid');
      }
      if (sample.fingerprint !== undefined && !isSafeDiagnosticDimension(sample.fingerprint)) {
        throw new ClientSignalValidationError('fingerprint is invalid');
      }
      if (sample.occurrenceCount !== undefined) {
        if (
          typeof sample.occurrenceCount !== 'number' ||
          !Number.isInteger(sample.occurrenceCount) ||
          sample.occurrenceCount < 1 ||
          sample.occurrenceCount > 1000
        ) {
          throw new ClientSignalValidationError('occurrenceCount is invalid');
        }
        occurrenceCount = sample.occurrenceCount;
      }
    } else if (
      sample.errorClass !== undefined ||
      sample.fingerprint !== undefined ||
      sample.occurrenceCount !== undefined ||
      sample.firstObservedAt !== undefined ||
      sample.lastObservedAt !== undefined
    ) {
      throw new ClientSignalValidationError('error dimensions are only valid for runtime_error');
    }
    const firstObservedAt =
      sample.firstObservedAt === undefined
        ? observedAt
        : parseObservedAt(sample.firstObservedAt, now);
    const lastObservedAt =
      sample.lastObservedAt === undefined
        ? observedAt
        : parseObservedAt(sample.lastObservedAt, now);
    if (firstObservedAt.getTime() > lastObservedAt.getTime()) {
      throw new ClientSignalValidationError('error occurrence timestamps are out of order');
    }
    const numericMetric = NUMERIC_METRICS.has(sample.metric);
    const value = parseV2Number(sample.value, sample.metric);
    if (numericMetric && value === undefined) {
      throw new ClientSignalValidationError(`value is required for ${sample.metric}`);
    }
    return {
      observedAt: observedAt.toISOString(),
      surface: sample.surface,
      metric: sample.metric,
      deviceGroup: sample.deviceGroup,
      sampleSource: sample.sampleSource,
      result: sample.result,
      reasonCode: sample.reasonCode,
      measurementKind: sample.measurementKind,
      samplingProbability: sample.samplingProbability,
      ...(sample.errorClass === undefined ? {} : { errorClass: sample.errorClass }),
      ...(sample.fingerprint === undefined ? {} : { fingerprint: sample.fingerprint }),
      occurrenceCount,
      firstObservedAt: firstObservedAt.toISOString(),
      lastObservedAt: lastObservedAt.toISOString(),
      ...(value === undefined ? {} : { value }),
    };
  });

  return {
    schemaVersion: 2,
    batchId: value.batchId,
    client: value.client,
    clientRelease: value.clientRelease,
    ingestRelease: value.ingestRelease,
    sentAt: sentAt.toISOString(),
    samples,
  };
}

export function clientSignalBucketFor(
  metric: ClientSignalMetric,
  value: number | undefined,
): string {
  if (value === undefined) return 'count';
  const thresholds =
    metric === 'cls'
      ? [0.02, 0.05, 0.1, 0.25, 0.5]
      : metric === 'last_good_age_ms'
        ? [10, 30, 50, 60].map((minutes) => minutes * 60 * 1000)
        : BYTE_METRICS.has(metric)
          ? (metric === 'live_matches_full_bytes'
              ? [4, 8, 16, 32, 64, 90, 128, 256, 512, 1024, 2048, 4096, 8192]
              : [4, 8, 16, 32, 64, 90, 128, 256, 512]
            ).map((kilobytes) => kilobytes * 1024)
          : [100, 250, 500, 800, 1000, 1500, 2000, 3000, 5000, 10000];
  const threshold = thresholds.find((candidate) => value <= candidate);
  return threshold === undefined ? 'overflow' : String(threshold);
}

function windowStart(date: Date): Date {
  return new Date(Math.floor(date.getTime() / CLIENT_SIGNAL_WINDOW_MS) * CLIENT_SIGNAL_WINDOW_MS);
}

function aggregateBatch(batch: ClientSignalBatchV1): AggregatedSignal[] {
  const grouped = new Map<string, AggregatedSignal>();
  for (const sample of batch.samples) {
    const parsedAt = new Date(sample.observedAt);
    const bucket = clientSignalBucketFor(sample.metric, sample.value);
    const start = windowStart(parsedAt);
    const key = [
      start.toISOString(),
      batch.client,
      batch.release,
      sample.surface,
      sample.metric,
      sample.deviceGroup,
      sample.sampleSource,
      sample.result,
      bucket,
    ].join('\u0000');
    const current = grouped.get(key);
    if (current) {
      current.sampleCount += 1;
      current.valueSum += sample.value ?? 0;
      continue;
    }
    grouped.set(key, {
      windowStart: start,
      client: batch.client,
      release: batch.release,
      surface: sample.surface,
      metric: sample.metric,
      deviceGroup: sample.deviceGroup,
      sampleSource: sample.sampleSource,
      result: sample.result,
      bucket,
      sampleCount: 1,
      valueSum: sample.value ?? 0,
    });
  }
  return [...grouped.values()];
}

export function aggregateClientSignalBatchV2(batch: ClientSignalBatchV2): AggregatedSignalV2[] {
  const grouped = new Map<string, AggregatedSignalV2>();
  for (const sample of batch.samples) {
    const observedAt = new Date(sample.observedAt);
    const firstObservedAt = new Date(sample.firstObservedAt ?? sample.observedAt);
    const lastObservedAt = new Date(sample.lastObservedAt ?? sample.observedAt);
    const occurrenceCount = sample.occurrenceCount ?? 1;
    const weight = occurrenceCount / sample.samplingProbability;
    const bucket = clientSignalBucketFor(sample.metric, sample.value);
    const start = windowStart(observedAt);
    const key = [
      start.toISOString(),
      batch.client,
      batch.clientRelease,
      batch.ingestRelease,
      sample.surface,
      sample.metric,
      sample.deviceGroup,
      sample.sampleSource,
      sample.result,
      sample.reasonCode,
      sample.measurementKind,
      sample.errorClass ?? '',
      sample.fingerprint ?? '',
      bucket,
    ].join('\u0000');
    const current = grouped.get(key);
    if (current) {
      current.observedCount += 1;
      current.occurrenceCount += occurrenceCount;
      current.estimatedCount += weight;
      current.valueSum += (sample.value ?? 0) * weight;
      current.firstObservedAt = new Date(
        Math.min(current.firstObservedAt.getTime(), firstObservedAt.getTime()),
      );
      current.lastObservedAt = new Date(
        Math.max(current.lastObservedAt.getTime(), lastObservedAt.getTime()),
      );
      continue;
    }
    grouped.set(key, {
      windowStart: start,
      client: batch.client,
      clientRelease: batch.clientRelease,
      ingestRelease: batch.ingestRelease,
      surface: sample.surface,
      metric: sample.metric,
      deviceGroup: sample.deviceGroup,
      sampleSource: sample.sampleSource,
      result: sample.result,
      reasonCode: sample.reasonCode,
      measurementKind: sample.measurementKind,
      errorClass: sample.errorClass ?? null,
      fingerprint: sample.fingerprint ?? null,
      bucket,
      observedCount: 1,
      occurrenceCount,
      estimatedCount: weight,
      valueSum: (sample.value ?? 0) * weight,
      firstObservedAt,
      lastObservedAt,
    });
  }
  return [...grouped.values()];
}

export async function ingestClientSignalBatch(
  value: unknown,
  now = new Date(),
): Promise<{ duplicate: boolean }> {
  const serialized = JSON.stringify(value);
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > CLIENT_SIGNAL_MAX_BYTES) {
    throw new ClientSignalValidationError('payload exceeds 16 KiB');
  }
  const batch = parseClientSignalBatch(value, now.getTime());
  const rows = aggregateBatch(batch);

  return withDatabaseTransaction(async (transaction) => {
    await transaction`SET LOCAL statement_timeout = '5s'`;
    const inserted = await transaction`
      INSERT INTO ops.client_signal_batches (batch_id, client, received_at)
      VALUES (${batch.batchId}::uuid, ${batch.client}, clock_timestamp())
      ON CONFLICT (batch_id) DO NOTHING
      RETURNING batch_id
    `;
    if (inserted.length === 0) return { duplicate: true };

    if (rows.length > 0) {
      const parameters: postgres.ParameterOrJSON<never>[] = [];
      const values = rows
        .map((row) => {
          const start = parameters.length + 1;
          parameters.push(
            clientSignalSqlTimestamp(row.windowStart, 'window start'),
            row.client,
            row.release,
            row.surface,
            row.metric,
            row.deviceGroup,
            row.sampleSource,
            row.result,
            row.bucket,
            row.sampleCount,
            row.valueSum,
          );
          return `(${Array.from({ length: 11 }, (_, index) => `$${start + index}`).join(', ')}, clock_timestamp())`;
        })
        .join(', ');
      await transaction.unsafe(
        `INSERT INTO ops.client_signal_windows (
          window_start, client, release, surface, metric, device_group,
          sample_source, result, bucket, sample_count, value_sum, updated_at
        ) VALUES ${values}
        ON CONFLICT (
          window_start, client, release, surface, metric, device_group,
          sample_source, result, bucket
        ) DO UPDATE SET
          sample_count = ops.client_signal_windows.sample_count + EXCLUDED.sample_count,
          value_sum = ops.client_signal_windows.value_sum + EXCLUDED.value_sum,
          updated_at = clock_timestamp()`,
        parameters,
      );
    }
    return { duplicate: false };
  });
}

export async function ingestClientSignalBatchV2(
  value: unknown,
  now = new Date(),
): Promise<{ duplicate: boolean }> {
  const serialized = JSON.stringify(value);
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > CLIENT_SIGNAL_MAX_BYTES) {
    throw new ClientSignalValidationError('payload exceeds 16 KiB');
  }
  const batch = parseClientSignalBatchV2(value, now.getTime());
  const rows = aggregateClientSignalBatchV2(batch);

  return withDatabaseTransaction(async (transaction) => {
    await transaction`SET LOCAL statement_timeout = '5s'`;
    const inserted = await transaction`
      INSERT INTO ops.client_signal_v2_batches (
        batch_id, client, client_release, ingest_release, received_at
      )
      VALUES (${batch.batchId}::uuid, ${batch.client}, ${batch.clientRelease}, ${batch.ingestRelease}, clock_timestamp())
      ON CONFLICT (batch_id) DO NOTHING
      RETURNING batch_id
    `;
    if (inserted.length === 0) return { duplicate: true };

    if (rows.length > 0) {
      const parameters: postgres.ParameterOrJSON<never>[] = [];
      const values = rows
        .map((row) => {
          const start = parameters.length + 1;
          parameters.push(
            clientSignalSqlTimestamp(row.windowStart, 'window start'),
            row.client,
            row.clientRelease,
            row.ingestRelease,
            row.surface,
            row.metric,
            row.deviceGroup,
            row.sampleSource,
            row.result,
            row.reasonCode,
            row.measurementKind,
            row.errorClass,
            row.fingerprint,
            row.bucket,
            row.observedCount,
            row.occurrenceCount,
            row.estimatedCount,
            row.valueSum,
            row.firstObservedAt.toISOString(),
            row.lastObservedAt.toISOString(),
          );
          return `(${Array.from({ length: 20 }, (_, index) => `$${start + index}`).join(', ')}, clock_timestamp())`;
        })
        .join(', ');
      await transaction.unsafe(
        `INSERT INTO ops.client_signal_v2_windows (
          window_start, client, client_release, ingest_release, surface, metric,
          device_group, sample_source, result, reason_code, measurement_kind,
          error_class, fingerprint, bucket, observed_count, occurrence_count, estimated_count,
          value_sum, first_observed_at, last_observed_at, updated_at
        ) VALUES ${values}
        ON CONFLICT (
          window_start, client, client_release, ingest_release, surface, metric,
          device_group, sample_source, result, reason_code, measurement_kind,
          error_class, fingerprint, bucket
        ) DO UPDATE SET
          observed_count = ops.client_signal_v2_windows.observed_count + EXCLUDED.observed_count,
          occurrence_count = ops.client_signal_v2_windows.occurrence_count + EXCLUDED.occurrence_count,
          estimated_count = ops.client_signal_v2_windows.estimated_count + EXCLUDED.estimated_count,
          value_sum = ops.client_signal_v2_windows.value_sum + EXCLUDED.value_sum,
          first_observed_at = LEAST(ops.client_signal_v2_windows.first_observed_at, EXCLUDED.first_observed_at),
          last_observed_at = GREATEST(ops.client_signal_v2_windows.last_observed_at, EXCLUDED.last_observed_at),
          updated_at = clock_timestamp()`,
        parameters,
      );
    }
    return { duplicate: false };
  });
}

type SummaryRow = {
  client: string;
  release: string;
  surface: string;
  metric: string;
  device_group: string;
  sample_source: string;
  result: string;
  bucket: string;
  sample_count: string | number;
  value_sum: string | number;
};

type SummaryAccumulator = {
  client: string;
  release: string;
  surface: string;
  metric: string;
  deviceGroup: string;
  sampleSource: string;
  sampleCount: number;
  valueSum: number;
  errorCount: number;
  staleCount: number;
  unavailableCount: number;
  buckets: Map<string, number>;
};

function representativeBucket(metric: string, bucket: string): number | null {
  if (bucket === 'count') return null;
  if (bucket === 'overflow') {
    if (metric === 'cls') return 0.51;
    if (metric === 'last_good_age_ms') return 60 * 60 * 1000 + 1;
    if (metric === 'live_matches_head_bytes') return 512 * 1024 + 1;
    if (metric === 'live_matches_full_bytes') return 8 * 1024 * 1024 + 1;
    return 10_001;
  }
  const parsed = Number(bucket);
  return Number.isFinite(parsed) ? parsed : null;
}

function quantileBucket(accumulator: SummaryAccumulator, quantile: number): string | null {
  const target = accumulator.sampleCount * quantile;
  let seen = 0;
  const buckets = [...accumulator.buckets.entries()].sort(
    (left, right) =>
      (representativeBucket(accumulator.metric, left[0]) ?? Number.POSITIVE_INFINITY) -
      (representativeBucket(accumulator.metric, right[0]) ?? Number.POSITIVE_INFINITY),
  );
  for (const [bucket, count] of buckets) {
    seen += count;
    if (seen >= target) return bucket;
  }
  return null;
}

function approximateQuantile(accumulator: SummaryAccumulator, quantile: number): number | null {
  if (!NUMERIC_METRICS.has(accumulator.metric as ClientSignalMetric)) return null;
  const bucket = quantileBucket(accumulator, quantile);
  return bucket === null || bucket === 'overflow'
    ? null
    : representativeBucket(accumulator.metric, bucket);
}

function quantileIsOverflow(accumulator: SummaryAccumulator, quantile: number): boolean {
  return quantileBucket(accumulator, quantile) === 'overflow';
}

export async function getClientSignalSummary(
  since: Date,
  until: Date,
): Promise<Record<string, unknown>> {
  const client = await getDbClient();
  const sinceTimestamp = clientSignalSqlTimestamp(since, 'summary start');
  const untilTimestamp = clientSignalSqlTimestamp(until, 'summary end');
  const rows = await client<SummaryRow[]>`
    SELECT client, release, surface, metric, device_group, sample_source, result, bucket,
           SUM(sample_count)::bigint AS sample_count,
           SUM(value_sum)::double precision AS value_sum
    FROM ops.client_signal_windows
    WHERE window_start >= ${sinceTimestamp}::timestamptz
      AND window_start < ${untilTimestamp}::timestamptz
    GROUP BY client, release, surface, metric, device_group, sample_source, result, bucket
  `;
  const grouped = new Map<string, SummaryAccumulator>();
  for (const row of rows) {
    const key = [
      row.client,
      row.release,
      row.surface,
      row.metric,
      row.device_group,
      row.sample_source,
    ].join('\u0000');
    const sampleCount = Number(row.sample_count);
    const valueSum = Number(row.value_sum);
    const accumulator = grouped.get(key) ?? {
      client: row.client,
      release: row.release,
      surface: row.surface,
      metric: row.metric,
      deviceGroup: row.device_group,
      sampleSource: row.sample_source,
      sampleCount: 0,
      valueSum: 0,
      errorCount: 0,
      staleCount: 0,
      unavailableCount: 0,
      buckets: new Map(),
    };
    accumulator.sampleCount += Number.isFinite(sampleCount) ? sampleCount : 0;
    accumulator.valueSum += Number.isFinite(valueSum) ? valueSum : 0;
    accumulator.errorCount +=
      row.result === 'error' || row.result === 'timeout' || row.result === 'auth_error'
        ? sampleCount
        : 0;
    accumulator.staleCount += row.result === 'stale' ? sampleCount : 0;
    accumulator.unavailableCount += row.result === 'unavailable' ? sampleCount : 0;
    accumulator.buckets.set(row.bucket, (accumulator.buckets.get(row.bucket) ?? 0) + sampleCount);
    grouped.set(key, accumulator);
  }
  const metrics = [...grouped.values()].map((item) => ({
    client: item.client,
    release: item.release,
    surface: item.surface,
    metric: item.metric,
    deviceGroup: item.deviceGroup,
    sampleSource: item.sampleSource,
    sampleCount: item.sampleCount,
    approximateP75: approximateQuantile(item, 0.75),
    approximateP95: approximateQuantile(item, 0.95),
    approximateP75Overflow: quantileIsOverflow(item, 0.75),
    approximateP95Overflow: quantileIsOverflow(item, 0.95),
    errorRate: item.sampleCount > 0 ? item.errorCount / item.sampleCount : 0,
    staleRate: item.sampleCount > 0 ? item.staleCount / item.sampleCount : 0,
    unavailableRate: item.sampleCount > 0 ? item.unavailableCount / item.sampleCount : 0,
  }));
  const legacySummary = {
    schemaVersion: 1,
    legacy: true,
    countSemantics: 'observed_samples',
    rateSemantics: 'sample_only',
    windowStart: since.toISOString(),
    windowEnd: until.toISOString(),
    sampleCount: metrics.reduce((total, item) => total + item.sampleCount, 0),
    groups: metrics,
  };
  const v2 = await getClientSignalV2Summary(since, until);
  return { ...legacySummary, v2 };
}

type SummaryRowV2 = {
  client: string;
  client_release: string;
  ingest_release: string;
  surface: string;
  metric: string;
  device_group: string;
  sample_source: string;
  result: string;
  reason_code: string;
  measurement_kind: string;
  error_class: string | null;
  fingerprint: string | null;
  bucket: string;
  observed_count: string | number;
  occurrence_count: string | number;
  estimated_count: string | number;
  value_sum: string | number;
  first_observed_at: Date | string;
  last_observed_at: Date | string;
};

type SummaryAccumulatorV2 = {
  client: string;
  clientRelease: string;
  ingestRelease: string;
  surface: string;
  metric: string;
  deviceGroup: string;
  sampleSource: string;
  result: string;
  reasonCode: string;
  measurementKind: string;
  errorClass: string | null;
  fingerprint: string | null;
  observedCount: number;
  occurrenceCount: number;
  estimatedCount: number;
  valueSum: number;
  buckets: Map<string, number>;
  firstObservedAt: Date;
  lastObservedAt: Date;
};

function v2RepresentativeBucket(metric: string, bucket: string): number | null {
  if (bucket === 'count') return null;
  if (bucket === 'overflow') {
    if (metric === 'cls') return 0.51;
    if (metric === 'last_good_age_ms') return 60 * 60 * 1000 + 1;
    if (metric === 'live_matches_head_bytes') return 512 * 1024 + 1;
    if (metric === 'live_matches_full_bytes') return 8 * 1024 * 1024 + 1;
    return 10_001;
  }
  const parsed = Number(bucket);
  return Number.isFinite(parsed) ? parsed : null;
}

function v2QuantileBucket(accumulator: SummaryAccumulatorV2, quantile: number): string | null {
  const target = accumulator.estimatedCount * quantile;
  let seen = 0;
  const buckets = [...accumulator.buckets.entries()].sort(
    (left, right) =>
      (v2RepresentativeBucket(accumulator.metric, left[0]) ?? Number.POSITIVE_INFINITY) -
      (v2RepresentativeBucket(accumulator.metric, right[0]) ?? Number.POSITIVE_INFINITY),
  );
  for (const [bucket, count] of buckets) {
    seen += count;
    if (seen >= target) return bucket;
  }
  return null;
}

function v2ApproximateQuantile(accumulator: SummaryAccumulatorV2, quantile: number): number | null {
  if (!NUMERIC_METRICS.has(accumulator.metric as ClientSignalMetric)) return null;
  const bucket = v2QuantileBucket(accumulator, quantile);
  return bucket === null || bucket === 'overflow'
    ? null
    : v2RepresentativeBucket(accumulator.metric, bucket);
}

function v2QuantileOverflow(accumulator: SummaryAccumulatorV2, quantile: number): boolean {
  return v2QuantileBucket(accumulator, quantile) === 'overflow';
}

async function getClientSignalV2Summary(
  since: Date,
  until: Date,
): Promise<Record<string, unknown>> {
  const client = await getDbClient();
  const sinceTimestamp = clientSignalSqlTimestamp(since, 'v2 summary start');
  const untilTimestamp = clientSignalSqlTimestamp(until, 'v2 summary end');
  const rows = await client<SummaryRowV2[]>`
    SELECT client, client_release, ingest_release, surface, metric, device_group,
           sample_source, result, reason_code, measurement_kind, error_class,
           fingerprint, bucket, SUM(observed_count)::bigint AS observed_count,
           SUM(occurrence_count)::bigint AS occurrence_count,
           SUM(estimated_count)::double precision AS estimated_count,
           SUM(value_sum)::double precision AS value_sum,
           MIN(first_observed_at) AS first_observed_at,
           MAX(last_observed_at) AS last_observed_at
    FROM ops.client_signal_v2_windows
    WHERE window_start >= ${sinceTimestamp}::timestamptz
      AND window_start < ${untilTimestamp}::timestamptz
    GROUP BY client, client_release, ingest_release, surface, metric, device_group,
             sample_source, result, reason_code, measurement_kind, error_class,
             fingerprint, bucket
  `;
  const grouped = new Map<string, SummaryAccumulatorV2>();
  for (const row of rows) {
    const key = [
      row.client,
      row.client_release,
      row.ingest_release,
      row.surface,
      row.metric,
      row.device_group,
      row.sample_source,
      row.result,
      row.reason_code,
      row.measurement_kind,
      row.error_class ?? '',
      row.fingerprint ?? '',
    ].join('\u0000');
    const observedCount = Number(row.observed_count);
    const occurrenceCount = Number(row.occurrence_count);
    const estimatedCount = Number(row.estimated_count);
    const valueSum = Number(row.value_sum);
    const accumulator = grouped.get(key) ?? {
      client: row.client,
      clientRelease: row.client_release,
      ingestRelease: row.ingest_release,
      surface: row.surface,
      metric: row.metric,
      deviceGroup: row.device_group,
      sampleSource: row.sample_source,
      result: row.result,
      reasonCode: row.reason_code,
      measurementKind: row.measurement_kind,
      errorClass: row.error_class,
      fingerprint: row.fingerprint,
      observedCount: 0,
      occurrenceCount: 0,
      estimatedCount: 0,
      valueSum: 0,
      buckets: new Map(),
      firstObservedAt: new Date(row.first_observed_at),
      lastObservedAt: new Date(row.last_observed_at),
    };
    accumulator.observedCount += Number.isFinite(observedCount) ? observedCount : 0;
    accumulator.occurrenceCount += Number.isFinite(occurrenceCount) ? occurrenceCount : 0;
    accumulator.estimatedCount += Number.isFinite(estimatedCount) ? estimatedCount : 0;
    accumulator.valueSum += Number.isFinite(valueSum) ? valueSum : 0;
    const firstObservedAt = new Date(row.first_observed_at);
    const lastObservedAt = new Date(row.last_observed_at);
    if (Number.isFinite(firstObservedAt.getTime())) {
      accumulator.firstObservedAt = new Date(
        Math.min(accumulator.firstObservedAt.getTime(), firstObservedAt.getTime()),
      );
    }
    if (Number.isFinite(lastObservedAt.getTime())) {
      accumulator.lastObservedAt = new Date(
        Math.max(accumulator.lastObservedAt.getTime(), lastObservedAt.getTime()),
      );
    }
    accumulator.buckets.set(
      row.bucket,
      (accumulator.buckets.get(row.bucket) ?? 0) +
        (Number.isFinite(estimatedCount) ? estimatedCount : 0),
    );
    grouped.set(key, accumulator);
  }
  const groups = [...grouped.values()].map((item) => ({
    client: item.client,
    clientRelease: item.clientRelease,
    ingestRelease: item.ingestRelease,
    surface: item.surface,
    metric: item.metric,
    deviceGroup: item.deviceGroup,
    sampleSource: item.sampleSource,
    result: item.result,
    reasonCode: item.reasonCode,
    measurementKind: item.measurementKind,
    errorClass: item.errorClass,
    fingerprint: item.fingerprint,
    observedCount: item.observedCount,
    occurrenceCount: item.occurrenceCount,
    estimatedCount: item.estimatedCount,
    firstObservedAt: item.firstObservedAt.toISOString(),
    lastObservedAt: item.lastObservedAt.toISOString(),
    estimatedBucketCounts: Object.fromEntries(
      [...item.buckets.entries()].sort(
        (left, right) =>
          (v2RepresentativeBucket(item.metric, left[0]) ?? Number.POSITIVE_INFINITY) -
          (v2RepresentativeBucket(item.metric, right[0]) ?? Number.POSITIVE_INFINITY),
      ),
    ),
    estimatedValueMean:
      NUMERIC_METRICS.has(item.metric as ClientSignalMetric) && item.estimatedCount > 0
        ? item.valueSum / item.estimatedCount
        : null,
    approximateP75: v2ApproximateQuantile(item, 0.75),
    approximateP95: v2ApproximateQuantile(item, 0.95),
    approximateP75Overflow: v2QuantileOverflow(item, 0.75),
    approximateP95Overflow: v2QuantileOverflow(item, 0.95),
  }));
  const estimatedTotal = groups.reduce((total, item) => total + item.estimatedCount, 0);
  const estimatedErrors = groups.reduce(
    (total, item) =>
      total +
      (item.result === 'error' || item.result === 'timeout' || item.result === 'auth_error'
        ? item.estimatedCount
        : 0),
    0,
  );
  const resultEstimatedCounts = groups.reduce<Record<string, number>>((counts, item) => {
    counts[item.result] = (counts[item.result] ?? 0) + item.estimatedCount;
    return counts;
  }, {});
  const rateForResult = (result: string): number =>
    estimatedTotal > 0 ? (resultEstimatedCounts[result] ?? 0) / estimatedTotal : 0;
  return {
    schemaVersion: 2,
    legacy: false,
    countSemantics: 'observed_and_estimated',
    rateSemantics: 'estimated_weighted',
    windowStart: since.toISOString(),
    windowEnd: until.toISOString(),
    observedCount: groups.reduce((total, item) => total + item.observedCount, 0),
    estimatedCount: estimatedTotal,
    errorRate: estimatedTotal > 0 ? estimatedErrors / estimatedTotal : 0,
    staleRate: rateForResult('stale'),
    unavailableRate: rateForResult('unavailable'),
    timeoutRate: rateForResult('timeout'),
    authErrorRate: rateForResult('auth_error'),
    ordinaryErrorRate: rateForResult('error'),
    resultEstimatedCounts,
    groups,
  };
}

export async function purgeClientSignalRetention(
  now = new Date(),
): Promise<{ windows: number; batches: number; v2Windows: number; v2Batches: number }> {
  const cutoffs = clientSignalRetentionCutoffs(now);
  return withDatabaseTransaction(async (transaction) => {
    await transaction`SET LOCAL statement_timeout = '5s'`;
    const windows = await transaction`
			DELETE FROM ops.client_signal_windows
			WHERE window_start < ${cutoffs.windowBefore}::timestamptz
		`;
    const batches = await transaction`
			DELETE FROM ops.client_signal_batches
			WHERE received_at < ${cutoffs.batchesBefore}::timestamptz
		`;
    const v2Windows = await transaction`
      DELETE FROM ops.client_signal_v2_windows
      WHERE window_start < ${cutoffs.windowBefore}::timestamptz
    `;
    const v2Batches = await transaction`
      DELETE FROM ops.client_signal_v2_batches
      WHERE received_at < ${cutoffs.batchesBefore}::timestamptz
    `;
    return {
      windows: windows.count ?? 0,
      batches: batches.count ?? 0,
      v2Windows: v2Windows.count ?? 0,
      v2Batches: v2Batches.count ?? 0,
    };
  });
}
