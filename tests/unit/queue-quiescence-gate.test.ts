import { describe, expect, test } from 'bun:test';

import {
  assertQuiescenceCatalogPair,
  assertQueueQuiescence,
  cascadeId,
  findUnsettledCascades,
} from '../../scripts/queue-quiescence-gate';
import { allQueueNames } from '../../src/queues/names';

const accepted = () => ({
  nonTerminalSyncRuns: 0,
  stagingPublications: 0,
  runningMediaLeases: 0,
  runnableQueues: {
    'data-sync': {
      waiting: 0,
      active: 0,
      delayed: 0,
      prioritized: 0,
      'waiting-children': 0,
      paused: 0,
    },
  },
  unsettledCascadeIds: [] as string[],
});

describe('queue quiescence gate', () => {
  test('rejects a partially initialized database catalog', () => {
    expect(() => assertQuiescenceCatalogPair(true, false)).toThrow('partial quiescence catalog');
    expect(() => assertQuiescenceCatalogPair(false, true)).toThrow('partial quiescence catalog');
    expect(() => assertQuiescenceCatalogPair(false, false)).not.toThrow();
    expect(() => assertQuiescenceCatalogPair(true, true)).not.toThrow();
  });
  test('covers every canonical BullMQ queue exactly once', () => {
    expect(allQueueNames).toEqual([
      'data-sync',
      'entry-sync',
      'league-sync',
      'live-data',
      'manager-live',
      'tournament-sync',
      'tournament-setup',
      'understat-player-sync',
      'understat-team-sync',
      'tournament-repair',
      'maintenance',
      'content-http-acquisition',
      'content-media-transcript',
      'content-x-scan',
    ]);
    expect(new Set(allQueueNames).size).toBe(14);
  });

  test('accepts a fully settled hard-cut boundary', () => {
    expect(() => assertQueueQuiescence(accepted())).not.toThrow();
  });

  test('rejects database or queue work that could be orphaned', () => {
    expect(() => assertQueueQuiescence({ ...accepted(), nonTerminalSyncRuns: 1 })).toThrow(
      'non-terminal sync run',
    );
    expect(() => assertQueueQuiescence({ ...accepted(), runningMediaLeases: 1 })).toThrow(
      'RUNNING source-media lease',
    );
    expect(() =>
      assertQueueQuiescence({
        ...accepted(),
        runnableQueues: { 'data-sync': { waiting: 1 } },
      }),
    ).toThrow('runnable jobs');
    expect(() =>
      assertQueueQuiescence({
        ...accepted(),
        runnableQueues: { 'data-sync': { paused: 1 } },
      }),
    ).toThrow('runnable jobs');
    expect(() =>
      assertQueueQuiescence({ ...accepted(), unsettledCascadeIds: ['2627-1-123'] }),
    ).toThrow('incomplete');
  });

  test('allows resumable manager refreshes but still rejects active manager work', () => {
    expect(() =>
      assertQueueQuiescence({
        ...accepted(),
        runnableQueues: {
          'manager-live': { waiting: 2, delayed: 1, prioritized: 1, active: 0 },
        },
      }),
    ).not.toThrow();
    expect(() =>
      assertQueueQuiescence({
        ...accepted(),
        runnableQueues: { 'manager-live': { waiting: 1, active: 1 } },
      }),
    ).toThrow('runnable jobs');
  });

  test('allows durable delayed jobs but still rejects executing normal-queue work', () => {
    expect(() =>
      assertQueueQuiescence({
        ...accepted(),
        runnableQueues: {
          'data-sync': { delayed: 7 },
          'live-data': { delayed: 9 },
        },
      }),
    ).not.toThrow();
    expect(() =>
      assertQueueQuiescence({
        ...accepted(),
        runnableQueues: { 'data-sync': { delayed: 7, active: 1 } },
      }),
    ).toThrow('runnable jobs');
  });

  test('recognizes only a cascade with a terminal enqueue marker as settled', () => {
    const prefix = 'llm:queue:coordination:tournament-cascade';
    expect(cascadeId(`${prefix}:meta:2627-1-123`)).toEqual({
      id: '2627-1-123',
      settled: false,
    });
    expect(
      findUnsettledCascades([
        `${prefix}:meta:2627-1-123`,
        `${prefix}:structure-done:2627-1-123:tournament-points-race`,
        `${prefix}:refresh-enqueued:2627-1-123`,
        `${prefix}:meta:2627-2-456`,
      ]),
    ).toEqual(['2627-2-456']);
  });
});
