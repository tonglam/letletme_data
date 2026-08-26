import { withDatabaseTransaction, getDbClient } from '../db/singleton';
import type postgres from 'postgres';

export const CLIENT_SIGNAL_MAX_BYTES = 16 * 1024;
export const CLIENT_SIGNAL_MAX_SAMPLES = 50;
export const CLIENT_SIGNAL_WINDOW_MS = 5 * 60 * 1000;
export const CLIENT_SIGNAL_BATCH_RETENTION_MS = 48 * 60 * 60 * 1000;
export const CLIENT_SIGNAL_WINDOW_RETENTION_MS = 28 * 24 * 60 * 60 * 1000;

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

type ValueOf<T extends readonly string[]> = T[number];
export type ClientSignalClient = ValueOf<typeof CLIENTS>;
export type ClientSignalSurface = ValueOf<typeof SURFACES>;
export type ClientSignalMetric = ValueOf<typeof METRICS>;
export type ClientSignalDeviceGroup = ValueOf<typeof DEVICE_GROUPS>;
export type ClientSignalSampleSource = ValueOf<typeof SAMPLE_SOURCES>;
export type ClientSignalResult = ValueOf<typeof RESULTS>;

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
    const numericMetric = [
      'route_ready_ms',
      'api_duration_ms',
      'graphql_proxy_ms',
      'lcp_ms',
      'inp_ms',
      'cls',
      'last_good_age_ms',
    ].includes(sample.metric);
    if (numericMetric && typeof sample.value !== 'number') {
      throw new ClientSignalValidationError(`value is required for ${sample.metric}`);
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

function bucketFor(metric: ClientSignalMetric, value: number | undefined): string {
  if (value === undefined) return 'count';
  const thresholds =
    metric === 'cls'
      ? [0.02, 0.05, 0.1, 0.25, 0.5]
      : metric === 'last_good_age_ms'
        ? [10, 30, 50, 60].map((minutes) => minutes * 60 * 1000)
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
    const bucket = bucketFor(sample.metric, sample.value);
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
            row.windowStart,
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
    return 10_001;
  }
  const parsed = Number(bucket);
  return Number.isFinite(parsed) ? parsed : null;
}

function approximateQuantile(accumulator: SummaryAccumulator, quantile: number): number | null {
  if (
    ![
      'route_ready_ms',
      'api_duration_ms',
      'graphql_proxy_ms',
      'lcp_ms',
      'inp_ms',
      'cls',
      'last_good_age_ms',
    ].includes(accumulator.metric)
  )
    return null;
  const target = accumulator.sampleCount * quantile;
  let seen = 0;
  const buckets = [...accumulator.buckets.entries()].sort(
    (left, right) =>
      (representativeBucket(accumulator.metric, left[0]) ?? Number.POSITIVE_INFINITY) -
      (representativeBucket(accumulator.metric, right[0]) ?? Number.POSITIVE_INFINITY),
  );
  for (const [bucket, count] of buckets) {
    seen += count;
    if (seen >= target) return representativeBucket(accumulator.metric, bucket);
  }
  return null;
}

export async function getClientSignalSummary(since: Date): Promise<Record<string, unknown>> {
  const client = await getDbClient();
  const rows = await client<SummaryRow[]>`
    SELECT client, release, surface, metric, device_group, sample_source, result, bucket,
           SUM(sample_count)::bigint AS sample_count,
           SUM(value_sum)::double precision AS value_sum
    FROM ops.client_signal_windows
    WHERE window_start >= ${since}
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
    errorRate: item.sampleCount > 0 ? item.errorCount / item.sampleCount : 0,
    staleRate: item.sampleCount > 0 ? item.staleCount / item.sampleCount : 0,
    unavailableRate: item.sampleCount > 0 ? item.unavailableCount / item.sampleCount : 0,
  }));
  return {
    windowStart: since.toISOString(),
    sampleCount: metrics.reduce((total, item) => total + item.sampleCount, 0),
    groups: metrics,
  };
}

export async function purgeClientSignalRetention(
  now = new Date(),
): Promise<{ windows: number; batches: number }> {
  return withDatabaseTransaction(async (transaction) => {
    await transaction`SET LOCAL statement_timeout = '5s'`;
    const windows = await transaction`
      DELETE FROM ops.client_signal_windows
      WHERE window_start < ${new Date(now.getTime() - CLIENT_SIGNAL_WINDOW_RETENTION_MS)}
    `;
    const batches = await transaction`
      DELETE FROM ops.client_signal_batches
      WHERE received_at < ${new Date(now.getTime() - CLIENT_SIGNAL_BATCH_RETENTION_MS)}
    `;
    return { windows: windows.count ?? 0, batches: batches.count ?? 0 };
  });
}
