import { describe, expect, test } from 'bun:test';

import {
  CLIENT_SIGNAL_MAX_BYTES,
  CLIENT_SIGNAL_MAX_SAMPLES,
  ClientSignalValidationError,
  clientSignalRetentionCutoffs,
  parseClientSignalBatch,
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

  test('keeps the body budget explicit', () => {
    expect(CLIENT_SIGNAL_MAX_BYTES).toBe(16 * 1024);
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
