import { describe, expect, test } from 'bun:test';

import {
  formalAcquisitionJobId,
  requestWindow,
  youtubeFeedRetryDelayMs,
} from '../../../src/content/acquisition/formal-run-repository';
import { compileXSemanticRequest } from '../../../src/content/acquisition/x-query-compiler';

describe('daily discovery windows and feed retry', () => {
  const input = {
    adapterKind: 'X_SEMANTIC',
    dbNow: new Date('2026-09-12T13:00:00Z'),
    checkpoint: {},
    bootstrapCutoffAt: new Date('2026-09-12T13:00:00Z'),
    bootstrapEnabled: true,
    lookbackMinutes: 360,
  };

  test('first scan covers the previous complete UTC date, including at midnight', () => {
    for (const dbNow of [input.dbNow, new Date('2026-09-12T00:00:00Z')]) {
      const window = requestWindow({ ...input, dbNow });
      expect(window.windowStart.toISOString()).toBe('2026-09-11T00:00:00.000Z');
      expect(window.windowEnd.toISOString()).toBe('2026-09-12T00:00:00.000Z');
      const request = compileXSemanticRequest({ ...window, semanticProfileKey: 'availability-v1' });
      expect(request.fromDate).toBe('2026-09-11');
      expect(request.toDate).toBe('2026-09-12');
    }
  });

  test('old same-day checkpoint cannot create a zero-date range', () => {
    const window = requestWindow({ ...input, checkpoint: { windowEnd: '2026-09-12T05:00:00Z' } });
    expect(window.windowStart.toISOString()).toBe('2026-09-11T00:00:00.000Z');
  });

  test('retains missed days after downtime and advances to the next full day', () => {
    const window = requestWindow({ ...input, checkpoint: { windowEnd: '2026-09-09T12:00:00Z' } });
    expect(window.windowStart.toISOString()).toBe('2026-09-09T00:00:00.000Z');
    const next = requestWindow({
      ...input,
      dbNow: new Date('2026-09-13T13:01:00Z'),
      checkpoint: { windowEnd: window.windowEnd.toISOString() },
    });
    expect(next.windowStart.toISOString()).toBe('2026-09-12T00:00:00.000Z');
  });

  test('backs off channel feed failures without affecting transcripts or other adapters', () => {
    expect(
      [1, 2, 3, 10].map((n) =>
        youtubeFeedRetryDelayMs('YOUTUBE_CHANNEL', 'FEED_POLL', 'HTTP_STATUS', n),
      ),
    ).toEqual([900000, 3600000, 21600000, 21600000]);
    expect(
      youtubeFeedRetryDelayMs('YOUTUBE_CHANNEL', 'YOUTUBE_TRANSCRIPT', 'HTTP_STATUS', 3),
    ).toBeNull();
    expect(youtubeFeedRetryDelayMs('RSS_ATOM', 'FEED_POLL', 'HTTP_STATUS', 3)).toBeNull();
    expect(youtubeFeedRetryDelayMs('YOUTUBE_CHANNEL', 'FEED_POLL', 'HTTP_TIMEOUT', 2)).toBe(
      3600000,
    );
  });
});

describe('formal acquisition job IDs', () => {
  const base = {
    targetId: 'partition-id',
    jobKind: 'X_KEYWORD_SCAN',
    windowEnd: new Date('2026-08-24T11:47:04.453Z'),
    profileRevision: 1,
    attemptNo: 1,
  } as const;

  test('separates requests with the same target/window and different immutable request hashes', () => {
    expect(formalAcquisitionJobId({ ...base, requestHash: 'old-request' })).not.toBe(
      formalAcquisitionJobId({ ...base, requestHash: 'new-request' }),
    );
  });

  test('is deterministic for the same request identity', () => {
    expect(formalAcquisitionJobId({ ...base, requestHash: 'request' })).toBe(
      formalAcquisitionJobId({ ...base, requestHash: 'request' }),
    );
  });
});
