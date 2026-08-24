import { describe, expect, test } from 'bun:test';

import { selectCanonicalPriceChangeContext } from '../../src/services/jobs-status.service';

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
