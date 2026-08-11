import { describe, expect, test } from 'bun:test';

import {
  assertQueueQuiescence,
  cascadeId,
  findUnsettledCascades,
} from '../../scripts/queue-quiescence-gate';
import { queueNames } from '../../src/queues/names';

const accepted = () => ({
  nonTerminalSyncRuns: 0,
  stagingPublications: 0,
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
  test('covers every canonical BullMQ queue exactly once', () => {
    expect(queueNames).toEqual([
      'data-sync',
      'entry-sync',
      'league-sync',
      'live-data',
      'tournament-sync',
      'tournament-setup',
      'understat-player-sync',
      'understat-team-sync',
    ]);
    expect(new Set(queueNames).size).toBe(8);
  });

  test('accepts a fully settled hard-cut boundary', () => {
    expect(() => assertQueueQuiescence(accepted())).not.toThrow();
  });

  test('rejects database or queue work that could be orphaned', () => {
    expect(() => assertQueueQuiescence({ ...accepted(), nonTerminalSyncRuns: 1 })).toThrow(
      'non-terminal sync run',
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
