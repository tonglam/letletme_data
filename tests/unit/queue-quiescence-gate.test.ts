import { describe, expect, test } from 'bun:test';

import {
  assertQueueQuiescence,
  findUnsettledRetiredCascades,
  retiredCascadeId,
} from '../../scripts/queue-quiescence-gate';

const accepted = () => ({
  nonTerminalSyncRuns: 0,
  stagingPublications: 0,
  runnableQueues: {
    'data-sync-p0': {
      waiting: 0,
      active: 0,
      delayed: 0,
      prioritized: 0,
      'waiting-children': 0,
    },
  },
  unsettledRetiredCascadeIds: [] as string[],
});

describe('queue quiescence gate', () => {
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
        runnableQueues: { 'data-sync-p0': { waiting: 1 } },
      }),
    ).toThrow('runnable jobs');
    expect(() =>
      assertQueueQuiescence({ ...accepted(), unsettledRetiredCascadeIds: ['2627-1-123'] }),
    ).toThrow('incomplete');
  });

  test('recognizes only a retired cascade with a terminal enqueue marker as settled', () => {
    const prefix = 'llm:retired:queue:coordination:tournament-cascade';
    expect(retiredCascadeId(`${prefix}:meta:2627-1-123`)).toEqual({
      id: '2627-1-123',
      settled: false,
    });
    expect(
      findUnsettledRetiredCascades([
        `${prefix}:meta:2627-1-123`,
        `${prefix}:structure-done:2627-1-123:tournament-points-race`,
        `${prefix}:refresh-enqueued:2627-1-123`,
        `${prefix}:meta:2627-2-456`,
      ]),
    ).toEqual(['2627-2-456']);
  });
});
