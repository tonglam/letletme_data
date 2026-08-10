import { describe, expect, test } from 'bun:test';

import type { UnderstatSyncItem } from '../../src/domain/understat';
import {
  enqueueUnderstatFanout,
  selectUnsettledUnderstatFanoutIds,
} from '../../src/services/understat-fanout';

const item = (resourceType: string, resourceId: string, status: UnderstatSyncItem['status']) =>
  ({ resourceType, resourceId, status }) as UnderstatSyncItem;

describe('Understat fanout retries', () => {
  test('selects only valid pending or running resources for republication', () => {
    const items = [
      item('team-detail', '4', 'pending'),
      item('team-detail', '2', 'running'),
      item('team-detail', '3', 'completed'),
      item('team-detail', '5', 'failed'),
      item('team-detail', 'bad', 'pending'),
      item('match-roster', '8', 'pending'),
      item('team-detail', '4', 'pending'),
    ];

    expect(selectUnsettledUnderstatFanoutIds(items, 'team-detail')).toEqual([2, 4]);
  });

  test('reports partial publication failure without mutating sync-item state', async () => {
    const attempted: string[] = [];
    const items = [item('team-detail', '2', 'pending'), item('team-detail', '4', 'pending')];

    await expect(
      enqueueUnderstatFanout(
        'Understat team detail',
        items.map((target) => ({
          resourceType: target.resourceType,
          resourceId: target.resourceId,
          enqueue: async () => {
            attempted.push(target.resourceId);
            if (target.resourceId === '4') throw new Error('Redis unavailable');
          },
        })),
      ),
    ).rejects.toThrow('team-detail:4: Redis unavailable');

    expect(attempted).toEqual(['2', '4']);
    expect(items.map(({ status }) => status)).toEqual(['pending', 'pending']);
    expect(selectUnsettledUnderstatFanoutIds(items, 'team-detail')).toEqual([2, 4]);
  });
});
