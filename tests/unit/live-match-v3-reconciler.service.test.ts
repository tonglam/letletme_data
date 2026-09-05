import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import type {
  MatchCheckpointDesired,
  MatchDeskPublication,
} from '../../src/cache/live-match-publication-v3';
import {
  reconcileLiveMatchCheckpointObligationsV3,
  type LiveMatchCheckpointHead,
  type LiveMatchCheckpointReconcilerDependencies,
} from '../../src/services/live-match-v3-reconciler.service';

const season = { seasonId: 2026, seasonCode: '2627' } as const;
const now = '2026-08-31T10:00:00.000Z';
const revision = 'a'.repeat(64);

const publication = (
  input: {
    generation?: number;
    publicationId?: string;
    finalized?: boolean;
    checkpointedAt?: string | null;
  } = {},
): MatchDeskPublication => {
  const generation = input.generation ?? 12;
  return {
    contractVersion: 'live-matches-v3',
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
      key: `llm:data:v3:fpl:live-match:desk:${season.seasonCode}:2:${generation}:desk`,
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
  contractVersion: 'live-matches-v3',
  kind: 'desk',
  season: season.seasonCode,
  eventId: 2,
  publicationId: current.publicationId,
  generation: current.generation,
  requestedAt: now,
  final,
  force: false,
});

function dependencies(input: {
  current: MatchDeskPublication;
  desired: MatchCheckpointDesired | null;
  head?: LiveMatchCheckpointHead;
  enqueue?: LiveMatchCheckpointReconcilerDependencies['enqueue'];
  setDesired?: LiveMatchCheckpointReconcilerDependencies['setDesired'];
  readCheckpoint?: LiveMatchCheckpointReconcilerDependencies['readCheckpoint'];
  markCheckpointed?: LiveMatchCheckpointReconcilerDependencies['markCheckpointed'];
  clearDesired?: LiveMatchCheckpointReconcilerDependencies['clearDesired'];
}): LiveMatchCheckpointReconcilerDependencies {
  return {
    listScopes: async () => [{ eventId: 2, kind: 'desk' }],
    readHeads: async () => new Map(input.head ? [['2:desk', input.head] as const] : []),
    readCurrent: async () => ({ publication: input.current }),
    readCheckpoint: input.readCheckpoint ?? (async () => ({ publication: input.current })),
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

describe('Live Matches V3 checkpoint reconciler', () => {
  test('discovers only the current active event plus retained desired markers', () => {
    const source = readFileSync('src/services/live-match-v3-reconciler.service.ts', 'utf8');
    expect(source).toContain('liveMatchActiveEventKey(season)');
    expect(source).toContain('checkpoint:${season}:*:*');
    expect(source).not.toContain('desk:${season}:*:active');
    expect(source).not.toContain('detail:${season}:*:active');
  });

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

    const first = await reconcileLiveMatchCheckpointObligationsV3(season, deps);
    const second = await reconcileLiveMatchCheckpointObligationsV3(season, deps);

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

    const result = await reconcileLiveMatchCheckpointObligationsV3(season, deps);

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
        finalized: false,
      },
      markCheckpointed: async (_kind, value, clock) => {
        order.push(`mark:${clock.toISOString()}`);
        return { ...value, checkpointedAt: clock.toISOString() };
      },
      clearDesired: async () => {
        order.push('clear');
      },
    });

    const result = await reconcileLiveMatchCheckpointObligationsV3(season, deps);

    expect(result[0]?.status).toBe('matched');
    expect(order).toEqual([`mark:${checkpointedAt.toISOString()}`, 'clear']);
  });

  test('does not close an identity-only head when the self-contained checkpoint is invalid', async () => {
    const current = publication();
    const retained = desired(current);
    let enqueued = 0;
    const deps = dependencies({
      current,
      desired: retained,
      head: {
        publicationId: current.publicationId,
        generation: current.generation,
        checkpointedAt: new Date('2026-08-31T10:00:05.000Z'),
        finalized: false,
      },
      readCheckpoint: async () => null,
      enqueue: async () => {
        enqueued += 1;
      },
    });

    const result = await reconcileLiveMatchCheckpointObligationsV3(season, deps);

    expect(result).toEqual([
      {
        eventId: 2,
        kind: 'desk',
        status: 'enqueued',
        publicationId: current.publicationId,
        generation: current.generation,
      },
    ]);
    expect(enqueued).toBe(1);
  });

  test('does not enqueue a Redis identity that conflicts with an immutable final checkpoint', async () => {
    const current = publication({ generation: 13, finalized: true });
    let writes = 0;
    const deps = dependencies({
      current,
      desired: desired(current, true),
      head: {
        publicationId: '00000000-0000-4000-8000-000000000012',
        generation: 12,
        checkpointedAt: new Date('2026-08-31T09:59:00.000Z'),
        finalized: true,
      },
      enqueue: async () => {
        writes += 1;
      },
      setDesired: async () => {
        writes += 1;
        return desired(current, true);
      },
    });

    const result = await reconcileLiveMatchCheckpointObligationsV3(season, deps);

    expect(result).toEqual([
      {
        eventId: 2,
        kind: 'desk',
        status: 'blocked-final',
        publicationId: '00000000-0000-4000-8000-000000000012',
        generation: 12,
      },
    ]);
    expect(writes).toBe(0);
  });

  test('clears a stale final desired marker after Redis is restored to the durable final', async () => {
    const current = publication({ generation: 12, finalized: true, checkpointedAt: now });
    const stale = desired(publication({ generation: 13, finalized: true }), true);
    const cleared: MatchCheckpointDesired[] = [];
    const deps = dependencies({
      current,
      desired: stale,
      head: {
        publicationId: current.publicationId,
        generation: current.generation,
        checkpointedAt: new Date(now),
        finalized: true,
      },
      readCheckpoint: async () => ({ publication: current }),
      clearDesired: async (value) => {
        cleared.push(value);
      },
    });

    const result = await reconcileLiveMatchCheckpointObligationsV3(season, deps);

    expect(result[0]?.status).toBe('matched');
    expect(cleared).toEqual([stale]);
  });
});
