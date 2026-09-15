import { describe, expect, test } from 'bun:test';

import {
  CLIENT_SIGNAL_MAX_BYTES,
  CLIENT_SIGNAL_MAX_SAMPLES,
  ClientSignalValidationError,
  clientSignalBucketFor,
  clientSignalRetentionCutoffs,
  aggregateClientSignalBatchV2,
  CLIENT_SIGNAL_V2_SUMMARY_GROUP_LIMIT,
  parseClientSignalBatch,
  parseClientSignalBatchV2,
} from '../../src/services/client-signals.service';

const now = Date.parse('2026-08-27T00:00:00.000Z');

const validBatch = () => ({
  schemaVersion: 1,
  batchId: '11111111-1111-4111-8111-111111111111',
  client: 'web',
  release: 'abc123',
  sentAt: new Date(now).toISOString(),
  samples: [
    {
      observedAt: new Date(now).toISOString(),
      surface: 'live_matches',
      metric: 'route_ready_ms',
      deviceGroup: 'desktop',
      sampleSource: 'real',
      result: 'ok',
      value: 249,
    },
  ],
});

const validBatchV2 = () => ({
  schemaVersion: 2,
  batchId: '22222222-2222-4222-8222-222222222222',
  client: 'web',
  clientRelease: 'web-abc123',
  ingestRelease: 'ingest-def456',
  sentAt: new Date(now).toISOString(),
  samples: [
    {
      observedAt: new Date(now).toISOString(),
      surface: 'home',
      metric: 'route_ready_ms',
      deviceGroup: 'desktop',
      sampleSource: 'real',
      result: 'ok',
      reasonCode: 'none',
      measurementKind: 'initial_navigation',
      samplingProbability: 0.25,
      metricName: 'HOME_TEAM_DESK_READY',
      navigationId: 'nav-12345678',
      cacheStatus: 'miss',
      value: 249,
    },
  ],
});

describe('anonymous client signal contract', () => {
  test('accepts the fixed schema and normalizes timestamps', () => {
    expect(parseClientSignalBatch(validBatch(), now)).toMatchObject({
      schemaVersion: 1,
      client: 'web',
      release: 'abc123',
      samples: [{ metric: 'route_ready_ms', value: 249 }],
    });
  });

  test('rejects identity, URL and free-text fields', () => {
    expect(() => parseClientSignalBatch({ ...validBatch(), userId: 'secret' }, now)).toThrow(
      ClientSignalValidationError,
    );
    expect(() =>
      parseClientSignalBatch(
        { ...validBatch(), samples: [{ ...validBatch().samples[0], errorMessage: 'secret' }] },
        now,
      ),
    ).toThrow(ClientSignalValidationError);
    expect(() =>
      parseClientSignalBatch({ ...validBatch(), release: 'release with spaces' }, now),
    ).toThrow(ClientSignalValidationError);
  });

  test('enforces the sample count and observed-at windows', () => {
    const samples = Array.from(
      { length: CLIENT_SIGNAL_MAX_SAMPLES + 1 },
      () => validBatch().samples[0],
    );
    expect(() => parseClientSignalBatch({ ...validBatch(), samples }, now)).toThrow(
      `samples must contain 1-${CLIENT_SIGNAL_MAX_SAMPLES} items`,
    );
    expect(() =>
      parseClientSignalBatch(
        {
          ...validBatch(),
          samples: [{ ...validBatch().samples[0], observedAt: '2026-08-25T23:59:59.999Z' }],
        },
        now,
      ),
    ).toThrow(ClientSignalValidationError);
  });

  test('requires numeric values for performance metrics', () => {
    expect(() =>
      parseClientSignalBatch(
        { ...validBatch(), samples: [{ ...validBatch().samples[0], value: undefined }] },
        now,
      ),
    ).toThrow('value is required for route_ready_ms');
    expect(
      parseClientSignalBatch(
        {
          ...validBatch(),
          samples: [{ ...validBatch().samples[0], metric: 'runtime_error', value: undefined }],
        },
        now,
      ),
    ).toMatchObject({
      samples: [{ metric: 'runtime_error' }],
    });
  });

  test('accepts the bounded Live Matches V3 client telemetry dimensions', () => {
    const sample = validBatch().samples[0];
    const batch = {
      ...validBatch(),
      samples: [
        { ...sample, metric: 'live_matches_head_ms', value: 120 },
        { ...sample, metric: 'live_matches_full_ms', value: 640 },
        { ...sample, metric: 'live_matches_head_bytes', value: 2048 },
        { ...sample, metric: 'live_matches_full_bytes', value: 68_000 },
        { ...sample, metric: 'live_matches_head_result', value: undefined },
        { ...sample, metric: 'live_matches_full_result', value: undefined },
        { ...sample, metric: 'live_matches_revision_changed', value: undefined },
      ],
    };

    expect(parseClientSignalBatch(batch, now).samples).toHaveLength(7);
  });

  test('keeps full-response byte buckets within the accepted 8 MiB range', () => {
    expect(clientSignalBucketFor('live_matches_full_bytes', 512 * 1024)).toBe(String(512 * 1024));
    expect(clientSignalBucketFor('live_matches_full_bytes', 8 * 1024 * 1024)).toBe(
      String(8 * 1024 * 1024),
    );
    expect(clientSignalBucketFor('live_matches_full_bytes', 8 * 1024 * 1024 + 1)).toBe('overflow');
    expect(clientSignalBucketFor('live_matches_head_bytes', 512 * 1024 + 1)).toBe('overflow');
  });

  test('keeps the body budget explicit', () => {
    expect(CLIENT_SIGNAL_MAX_BYTES).toBe(16 * 1024);
    expect(CLIENT_SIGNAL_V2_SUMMARY_GROUP_LIMIT).toBe(512);
  });

  test('keeps bounded marker and correlation dimensions in v2 aggregation', () => {
    const parsed = parseClientSignalBatchV2(validBatchV2(), now);
    expect(parsed.samples[0]).toMatchObject({
      metricName: 'HOME_TEAM_DESK_READY',
      navigationId: 'nav-12345678',
      cacheStatus: 'miss',
    });
    expect(aggregateClientSignalBatchV2(parsed)[0]).toMatchObject({
      metricName: 'HOME_TEAM_DESK_READY',
      navigationId: 'nav-12345678',
      cacheStatus: 'miss',
    });
    expect(() =>
      parseClientSignalBatchV2(
        {
          ...validBatchV2(),
          samples: [{ ...validBatchV2().samples[0], navigationId: 'nav-short' }],
        },
        now,
      ),
    ).toThrow(ClientSignalValidationError);
  });

  test('weights v2 success samples by their actual sampling probability', () => {
    const batch = {
      ...validBatchV2(),
      samples: [
        validBatchV2().samples[0],
        {
          ...validBatchV2().samples[0],
          result: 'error',
          reasonCode: 'unknown',
          samplingProbability: 1,
          metric: 'runtime_error',
          value: undefined,
          errorClass: 'TypeError',
          fingerprint: 'runtime.TypeError',
          occurrenceCount: 2,
        },
      ],
    };
    const parsed = parseClientSignalBatchV2(batch, now);
    const rows = aggregateClientSignalBatchV2(parsed);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.result === 'ok')).toMatchObject({
      observedCount: 1,
      occurrenceCount: 1,
      estimatedCount: 4,
    });
    expect(rows.find((row) => row.result === 'error')).toMatchObject({
      observedCount: 1,
      occurrenceCount: 2,
      estimatedCount: 2,
    });
  });

  test('preserves bounded marker and performance correlation dimensions', () => {
    const sample = validBatchV2().samples[0];
    const batch = {
      ...validBatchV2(),
      samples: [
        {
          ...sample,
          metricName: 'PLAYER_DESK_RESPONSE',
          navigationId: 'nav-12345678',
          interactionId: 'interaction-12345678',
          cacheStatus: 'stale',
        },
        {
          ...sample,
          metricName: 'HOME_TEAM_DESK_READY',
          navigationId: 'nav-12345678',
          interactionId: 'interaction-12345678',
          cacheStatus: 'stale',
        },
      ],
    };

    const parsed = parseClientSignalBatchV2(batch, now);
    expect(parsed.samples[0]).toMatchObject({
      metricName: 'PLAYER_DESK_RESPONSE',
      navigationId: 'nav-12345678',
      interactionId: 'interaction-12345678',
      cacheStatus: 'stale',
    });
    expect(aggregateClientSignalBatchV2(parsed)).toHaveLength(2);
  });

  test('rejects unsafe performance correlation dimensions', () => {
    expect(() =>
      parseClientSignalBatchV2(
        {
          ...validBatchV2(),
          samples: [{ ...validBatchV2().samples[0], navigationId: 'nav-short' }],
        },
        now,
      ),
    ).toThrow(ClientSignalValidationError);
    expect(() =>
      parseClientSignalBatchV2(
        {
          ...validBatchV2(),
          samples: [{ ...validBatchV2().samples[0], cacheStatus: 'origin' }],
        },
        now,
      ),
    ).toThrow(ClientSignalValidationError);
  });

  test('keeps v1 parsing separate and rejects forged ingest or sensitive v2 fields', () => {
    expect(parseClientSignalBatchV2(validBatchV2(), now).ingestRelease).toBe('ingest-def456');
    expect(() =>
      parseClientSignalBatchV2({ ...validBatchV2(), ingestRelease: 'bad release' }, now),
    ).toThrow(ClientSignalValidationError);
    expect(() =>
      parseClientSignalBatchV2(
        {
          ...validBatchV2(),
          samples: [{ ...validBatchV2().samples[0], errorMessage: 'secret' }],
        },
        now,
      ),
    ).toThrow(ClientSignalValidationError);
    expect(parseClientSignalBatch(validBatch(), now).schemaVersion).toBe(1);
  });

  test('serializes retention cutoffs before binding SQL parameters', () => {
    expect(clientSignalRetentionCutoffs(new Date('2026-08-27T00:00:00.000Z'))).toEqual({
      windowBefore: '2026-07-30T00:00:00.000Z',
      batchesBefore: '2026-08-25T00:00:00.000Z',
    });
    expect(() => clientSignalRetentionCutoffs(new Date('invalid'))).toThrow(
      'Client signal retention time is invalid',
    );
  });
});
