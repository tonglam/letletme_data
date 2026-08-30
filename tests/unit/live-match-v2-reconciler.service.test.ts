import { describe, expect, test } from 'bun:test';

import type {
  MatchCheckpointDesired,
  MatchDeskPublication,
} from '../../src/cache/live-match-publication-v2';
import {
  reconcileLiveMatchCheckpointObligationsV2,
  type LiveMatchCheckpointHead,
  type LiveMatchCheckpointReconcilerDependencies,
} from '../../src/services/live-match-v2-reconciler.service';

const season = { seasonId: 2026, seasonCode: '2627' } as const;
const now = '2026-08-31T10:00:00.000Z';
const revision = 'a'.repeat(64);

const publication = (input: {
  generation?: number;
  publicationId?: string;
  finalized?: boolean;
  checkpointedAt?: string | null;
} = {}): MatchDeskPublication => {
  const generation = input.generation ?? 12;
  return {
    contractVersion: 'live-matches-v2',
    publicationId:
      input.publicationId ?? `00000000-0000-4000-8000-${String(generation).padStart(12, '0')}`,
    generation,
    season: season.seasonCode,
    eventId: 2,
    state: input.finalized ? 'FINALIZED' : 'LIVE_ACTIVE',
    sourceCheckedAt: now,
    publishedAt: now,
    checkpointedAt: input.checkpointedAt ?? null,
    expectedNextCheckAt: null,
    staleAt: null,
    revisions: {
      lifecycle: { revision, contentUpdatedAt: now },
      fixtureIdentity: { revision, contentUpdatedAt: now },
      scoreState: { revision, contentUpdatedAt: now },
    },
    desk: {
      name: 'desk',
      key: `llm:data:v2:fpl:live-match:desk:${season.seasonCode}:2:${generation}:desk`,
      type: 'string',
      count: 1,
      bytes: 2,
      sha256: revision,
    },
  };
};

const desired = (
  current: MatchDeskPublication,
  final = current.state === 'FINALIZED',
): MatchCheckpointDesired => ({
  contractVersion: 'live-matches-v2',
  kind: 'desk',
  season: season.seasonCode,
  eventId: 2,
  publicationId: current.publicationId,
  generation: current.generation,
  requestedAt: now,
  final,
});

function dependencies(input: {
  current: MatchDeskPublication;
  desired: MatchCheckpointDesired | null;
  head?: LiveMatchCheckpointHead;
  enqueue?: LiveMatchCheckpointReconcilerDependencies['enqueue'];
  setDesired?: LiveMatchCheckpointReconcilerDependencies['setDesired'];
  markCheckpointed?: LiveMatchCheckpointReconcilerDependencies['markCheckpointed'];
  clearDesired?: LiveMatchCheckpointReconcilerDependencies['clearDesired'];
}): LiveMatchCheckpointReconcilerDependencies {
  return {
    listScopes: async () => [{ eventId: 2, kind: 'desk' }],
    readHeads: async () =>
      new Map(input.head ? [['2:desk', input.head] as const] : []),
    readCurrent: async () => ({ publication: input.current }),
    readDesired: async () => input.desired,
    setDesired: input.setDesired ?? (async () => desired(input.current)),
    markCheckpointed:
      input.markCheckpointed ??
      (async (_kind, current, checkpointedAt) => ({
        ...current,
        checkpointedAt: checkpointedAt.toISOString(),
      })),
    clearDesired: input.clearDesired ?? (async () => undefined),
    enqueue: input.enqueue ?? (async () => undefined),
  };
}

describe('Live Matches V2 checkpoint reconciler', () => {
  test('retries a retained desired marker after the first enqueue fails', async () => {
    const current = publication();
    const retained = desired(current);
    let attempts = 0;
    const deps = dependencies({
      current,
      desired: retained,
      enqueue: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('queue unavailable');
      },
    });

    const first = await reconcileLiveMatchCheckpointObligationsV2(season, deps);
    const second = await reconcileLiveMatchCheckpointObligationsV2(season, deps);

    expect(first).toEqual([{ eventId: 2, kind: 'desk', status: 'failed' }]);
    expect(second).toEqual([
      {
        eventId: 2,
        kind: 'desk',
        status: 'enqueued',
        publicationId: current.publicationId,
        generation: current.generation,
      },
    ]);
    expect(attempts).toBe(2);
  });

  test('never supersedes an exact final obligation with another current', async () => {
    const final = publication({ generation: 12, finalized: true });
    const unexpectedCurrent = publication({ generation: 13 });
    let writes = 0;
    const deps = dependencies({
      current: unexpectedCurrent,
      desired: desired(final, true),
      setDesired: async () => {
        writes += 1;
        return desired(unexpectedCurrent);
      },
      enqueue: async () => {
        writes += 1;
      },
    });

    const result = await reconcileLiveMatchCheckpointObligationsV2(season, deps);

    expect(result).toEqual([
      {
        eventId: 2,
        kind: 'desk',
        status: 'blocked-final',
        publicationId: final.publicationId,
        generation: final.generation,
      },
    ]);
    expect(writes).toBe(0);
  });

  test('closes an exact DB head with Redis CAS before clearing desired', async () => {
    const current = publication();
    const retained = desired(current);
    const order: string[] = [];
    const checkpointedAt = new Date('2026-08-31T10:00:05.000Z');
    const deps = dependencies({
      current,
      desired: retained,
      head: {
        publicationId: current.publicationId,
        generation: current.generation,
        checkpointedAt,
      },
      markCheckpointed: async (_kind, value, clock) => {
        order.push(`mark:${clock.toISOString()}`);
        return { ...value, checkpointedAt: clock.toISOString() };
      },
      clearDesired: async () => {
        order.push('clear');
      },
    });

    const result = await reconcileLiveMatchCheckpointObligationsV2(season, deps);

    expect(result[0]?.status).toBe('matched');
    expect(order).toEqual([`mark:${checkpointedAt.toISOString()}`, 'clear']);
  });
});
