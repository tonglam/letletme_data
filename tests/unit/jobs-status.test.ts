import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  safeSchedulerLaneErrorCode,
  safeSchedulerObligationLatest,
  selectCanonicalPriceChangeContext,
} from '../../src/services/jobs-status.service';

const quote = String.fromCharCode(39);

const dbActive = {
  publicationId: '00000000-0000-4000-8000-000000000010',
  revision: 10,
};

const dbContext = {
  fetchedAt: '2026-08-23T01:00:00.000Z',
  expectedPlayerCount: 10,
  observedPlayerCount: 9,
};

const dbDelivery = {
  manifest: {
    dataset: 'fpl:price-changes' as const,
    publicationId: dbActive.publicationId,
    revision: dbActive.revision,
  } as never,
  items: [
    {
      manifest: { name: 'context' } as never,
      payload: JSON.stringify(dbContext),
    },
  ],
};

describe('selectCanonicalPriceChangeContext', () => {
  test('uses matching Redis delivery', () => {
    const result = selectCanonicalPriceChangeContext({
      dbActive,
      dbDelivery: null,
      redisActive: {
        manifest: {
          publicationId: dbActive.publicationId,
          revision: dbActive.revision,
        } as never,
        items: { context: { ...dbContext, observedPlayerCount: 10 } },
      } as never,
    });

    expect(result).toEqual({
      context: { ...dbContext, observedPlayerCount: 10 },
      publicationId: dbActive.publicationId,
      source: 'redis',
    });
  });

  test('falls back to the canonical DB delivery when Redis is stale', () => {
    const result = selectCanonicalPriceChangeContext({
      dbActive,
      dbDelivery,
      redisActive: {
        manifest: {
          publicationId: '00000000-0000-4000-8000-000000000009',
          revision: 9,
        } as never,
        items: { context: { fetchedAt: 'stale' } },
      } as never,
    });

    expect(result).toEqual({
      context: dbContext,
      publicationId: dbActive.publicationId,
      source: 'database',
    });
  });

  test('does not invent a publication from an orphaned Redis pointer', () => {
    const result = selectCanonicalPriceChangeContext({
      dbActive: null,
      dbDelivery: null,
      redisActive: {
        manifest: {
          publicationId: '00000000-0000-4000-8000-000000000009',
          revision: 9,
        } as never,
        items: { context: dbContext },
      } as never,
    });

    expect(result).toEqual({ context: null, publicationId: null, source: 'none' });
  });
});

describe('safeSchedulerLaneErrorCode', () => {
  test('does not expose persisted lane error text or identifiers', () => {
    const raw =
      'provider https://example.invalid/entry/123456 failed for entry_id=987654 token=secret-value';

    expect(safeSchedulerLaneErrorCode(raw)).toBe('TRANSIENT_INFRA');
    expect(safeSchedulerLaneErrorCode(raw)).not.toContain('123456');
    expect(safeSchedulerLaneErrorCode(raw)).not.toContain('secret-value');
  });

  test('keeps an empty lane error distinguishable from a classified error', () => {
    expect(safeSchedulerLaneErrorCode(null)).toBeNull();
    expect(safeSchedulerLaneErrorCode('')).toBeNull();
  });

  test('preserves the bounded classification and provider code prefix', () => {
    expect(
      safeSchedulerLaneErrorCode(
        'SOURCE_NOT_READY:HTTP_ERROR provider https://example.invalid/entry/123 unavailable',
      ),
    ).toBe('SOURCE_NOT_READY:HTTP_ERROR');
    expect(safeSchedulerLaneErrorCode('CONFIG_AUTH:AUTH_FAILED credentials=secret')).toBe(
      'CONFIG_AUTH:AUTH_FAILED',
    );
  });
});

describe('safeSchedulerObligationLatest', () => {
  test('keeps operational fields and replaces raw error text with a code', () => {
    const result = safeSchedulerObligationLatest({
      periodKey: 'price-change-1',
      status: 'failed',
      dueAt: new Date('2026-08-27T03:00:00.000Z'),
      generation: 4,
      attempts: 2,
      lastError: 'provider https://example.invalid/entry/123 failed token=secret',
      nextAttemptAt: null,
    });

    expect(result).toEqual({
      periodKey: 'price-change-1',
      status: 'failed',
      dueAt: new Date('2026-08-27T03:00:00.000Z'),
      generation: 4,
      attempts: 2,
      nextAttemptAt: null,
      lastErrorCode: 'TRANSIENT_INFRA',
    });
    expect(result).not.toHaveProperty('lastError');
  });

  test('returns null when there is no latest obligation', () => {
    expect(safeSchedulerObligationLatest(null)).toBeNull();
  });
});

describe('jobs status hot-path isolation', () => {
  test('routes frequent status probes through the sectioned control projection', () => {
    const route = readFileSync('src/api/jobs.api.ts', 'utf8');
    const control = readFileSync('src/services/jobs-control-status.service.ts', 'utf8');

    expect(route).toContain('getJobsControlStatus');
    expect(route).not.toContain(
      ['from ', quote, '../services/jobs-status.service', quote].join(''),
    );
    for (const forbidden of [
      'schedulerObligationSummary',
      'listFreshnessWindows',
      'listQueueHealthWindows',
      'listGovernanceCases',
      'countGovernanceCases',
    ]) {
      expect(control).not.toContain(forbidden);
    }
    expect(control).toContain(
      ['publicationConsistencyMode: ', quote, 'IDENTITY_ONLY', quote].join(''),
    );
    expect(control).toContain(['case ', quote, 'myFplIntegrity', quote].join(''));
    expect(control).toContain(['case ', quote, 'tournamentReviewV2', quote].join(''));
    expect(control).toContain(['case ', quote, 'liveFinalRetention', quote].join(''));
    expect(control).toContain(['case ', quote, 'clientSignals', quote].join(''));
  });
});
