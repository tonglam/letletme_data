import { describe, expect, test } from 'bun:test';

import {
  effectiveSourceMediaDeliveryState,
  sourceMediaRetryOffsetsMs,
} from '../../../src/content/media/source-media-repository';
import { getSourceMediaRuntimeConfig } from '../../../src/content/media/source-media-config';

describe('source-media delivery state', () => {
  test('turns every non-terminal gate into effective PARTIAL at the 20-minute deadline', () => {
    const deadline = new Date('2026-08-23T10:20:00.000Z');
    for (const status of ['PENDING', 'RUNNING', 'PARTIAL', 'UNAVAILABLE']) {
      expect(
        effectiveSourceMediaDeliveryState({
          status,
          releaseDeadlineAt: deadline,
          now: new Date('2026-08-23T10:19:59.999Z'),
        }),
      ).toBe('PENDING');
      expect(
        effectiveSourceMediaDeliveryState({
          status,
          releaseDeadlineAt: deadline,
          now: deadline,
        }),
      ).toBe('PARTIAL');
    }
    expect(
      effectiveSourceMediaDeliveryState({
        status: 'CHECKED_NONE',
        releaseDeadlineAt: deadline,
        now: deadline,
      }),
    ).toBe('CHECKED_NONE');
  });

  test('locks the bounded retry schedule through the final 24-hour repair attempt', () => {
    expect(sourceMediaRetryOffsetsMs).toEqual([
      0,
      60_000,
      5 * 60_000,
      15 * 60_000,
      60 * 60_000,
      6 * 60 * 60_000,
      24 * 60 * 60_000,
    ]);
  });

  test('keeps production fetch concurrency fixed at two', () => {
    const previous = process.env.CONTENT_MEDIA_CONCURRENCY;
    try {
      process.env.CONTENT_MEDIA_CONCURRENCY = '2';
      expect(getSourceMediaRuntimeConfig().concurrency).toBe(2);
      process.env.CONTENT_MEDIA_CONCURRENCY = '3';
      expect(() => getSourceMediaRuntimeConfig()).toThrow(
        'CONTENT_MEDIA_CONCURRENCY is fixed at 2',
      );
    } finally {
      if (previous === undefined) delete process.env.CONTENT_MEDIA_CONCURRENCY;
      else process.env.CONTENT_MEDIA_CONCURRENCY = previous;
    }
  });

  test('cannot advertise retention while the media worker is disabled', () => {
    const previousEnabled = process.env.CONTENT_MEDIA_WORKER_ENABLED;
    const previousRetention = process.env.CONTENT_MEDIA_RETENTION_ENABLED;
    try {
      process.env.CONTENT_MEDIA_WORKER_ENABLED = 'false';
      process.env.CONTENT_MEDIA_RETENTION_ENABLED = 'true';
      expect(() => getSourceMediaRuntimeConfig()).toThrow(
        'CONTENT_MEDIA_RETENTION_ENABLED requires CONTENT_MEDIA_WORKER_ENABLED',
      );
    } finally {
      if (previousEnabled === undefined) delete process.env.CONTENT_MEDIA_WORKER_ENABLED;
      else process.env.CONTENT_MEDIA_WORKER_ENABLED = previousEnabled;
      if (previousRetention === undefined) delete process.env.CONTENT_MEDIA_RETENTION_ENABLED;
      else process.env.CONTENT_MEDIA_RETENTION_ENABLED = previousRetention;
    }
  });
});
