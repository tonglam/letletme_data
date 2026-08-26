import { describe, expect, test } from 'bun:test';

import type { FPLBootstrapResponse } from '../../src/clients/fpl';
import {
  buildPriceChangeHotSnapshot,
  isPriceChangeHotSnapshotNewer,
  PRICE_CHANGE_HOT_TTL_MS,
  sha256Bytes,
} from '../../src/services/price-change-hot.service';
import type { PriceChangeBoard } from '../../src/services/price-change-predictions.service';
import { buildCoreSnapshotFixture } from '../fixtures/core-snapshot.fixtures';
import { TEST_SEASON } from '../fixtures/seasons.fixtures';

function priceBootstrap(playerCount = 2): FPLBootstrapResponse {
  const source = buildCoreSnapshotFixture({ playerCount }).bootstrap;
  return {
    ...source,
    game_config: {
      settings: { price_change_deadlines: ['2026-08-26T07:00:00.000Z'] },
    },
    elements: source.elements.map((element, index) => ({
      ...element,
      price_change_percent: index === 0 ? 2.5 : -1.25,
      price_change_hourly_rate: index === 0 ? 0.25 : -0.1,
      price_change_projections: [
        {
          offset: 0,
          projected_percent: index === 0 ? 2.5 : -1.25,
          likelihood: index === 0 ? 5 : -4,
        },
      ],
      price_change_locked_until: null,
      price_change_calibrating: false,
    })),
  } as unknown as FPLBootstrapResponse;
}

describe('price-change hot snapshot', () => {
  function durableBoard(fetchedAt: string): PriceChangeBoard {
    return {
      status: 'READY',
      source: 'FPL_BOOTSTRAP',
      deadline: null,
      nextDeadlines: [],
      fetchedAt,
      sourceCheckedAt: fetchedAt,
      staleAt: fetchedAt,
      revision: 'durable-revision',
      expectedPlayerCount: 0,
      observedPlayerCount: 0,
      players: [],
    };
  }

  test('builds a complete provisional board without Core ID admission', () => {
    const detectedAt = new Date('2026-08-26T07:00:03.000Z');
    const fetchedAt = new Date('2026-08-26T07:00:02.500Z');
    const snapshot = buildPriceChangeHotSnapshot({
      season: TEST_SEASON,
      bootstrap: priceBootstrap(2),
      sourceHash: 'a'.repeat(64),
      detectedAt,
      fetchedAt,
      corePlayerCount: 1,
      corePlayerDelta: 1,
    });

    expect(snapshot.board.status).toBe('READY');
    expect(snapshot.board.observedPlayerCount).toBe(2);
    expect(snapshot.expectedPlayerCount).toBe(2);
    expect(snapshot.corePlayerCount).toBe(1);
    expect(snapshot.corePlayerDelta).toBe(1);
    expect(snapshot.reconciliation.state).toBe('pending');
    expect(snapshot.expiresAt).toBe(
      new Date(detectedAt.getTime() + PRICE_CHANGE_HOT_TTL_MS).toISOString(),
    );
  });

  test('hashes exact source bytes for the reconciliation hand-off', () => {
    const bytes = new TextEncoder().encode('{"bootstrap":true}');
    expect(sha256Bytes(bytes)).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Bytes(bytes)).toBe(sha256Bytes(bytes.slice()));
  });

  test('orders a slow hot response by probe start, not fetch completion', () => {
    const snapshot = buildPriceChangeHotSnapshot({
      season: TEST_SEASON,
      bootstrap: priceBootstrap(2),
      sourceHash: 'b'.repeat(64),
      detectedAt: new Date('2026-08-26T07:00:03.000Z'),
      fetchedAt: new Date('2026-08-26T07:00:08.000Z'),
    });

    expect(isPriceChangeHotSnapshotNewer(snapshot, durableBoard('2026-08-26T07:00:05.000Z'))).toBe(
      false,
    );
  });

  test('uses durable request-start evidence for overlapping fetches', () => {
    const snapshot = buildPriceChangeHotSnapshot({
      season: TEST_SEASON,
      bootstrap: priceBootstrap(2),
      sourceHash: 'c'.repeat(64),
      detectedAt: new Date('2026-08-26T07:00:03.000Z'),
      fetchedAt: new Date('2026-08-26T07:00:08.000Z'),
    });
    const durable = {
      ...durableBoard('2026-08-26T07:00:08.000Z'),
      sourceCheckedAt: '2026-08-26T07:00:01.000Z',
    };

    expect(isPriceChangeHotSnapshotNewer(snapshot, durable)).toBe(true);
  });
});
