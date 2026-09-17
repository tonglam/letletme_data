import { describe, expect, test } from 'bun:test';

import {
  activeDataPublicationKey,
  dataPublicationIntegrityProofKey,
  prepareDataPublication,
} from '../../src/cache/data-publication';
import {
  readCoreSnapshotLifecycle,
  selectCurrentEventIdByDeadline,
} from '../../src/cache/core-snapshot-cache';
import type { Event } from '../../src/types';
import type Redis from 'ioredis';

function event(id: number, deadlineTime: string | null, isCurrent = false): Event {
  return { id, deadlineTime, isCurrent } as Event;
}

describe('core snapshot current-event authority', () => {
  test('uses the latest elapsed deadline even while the upstream current flag lags', () => {
    const events = [
      event(1, '2026-08-15T10:00:00.000Z', true),
      event(2, '2026-08-22T10:00:00.000Z'),
      event(3, '2026-08-29T10:00:00.000Z'),
    ];

    expect(selectCurrentEventIdByDeadline(events, new Date('2026-08-22T10:00:01.000Z'))).toBe(2);
  });

  test('publishes no current event before the first deadline', () => {
    const events = [event(1, '2026-08-15T10:00:00.000Z', true), event(2, null)];

    expect(selectCurrentEventIdByDeadline(events, new Date('2026-08-14T10:00:00.000Z'))).toBeNull();
  });

  test('lifecycle control reads only the selected core items', async () => {
    const scope = { dataset: 'fpl:core' as const, seasonCode: '2627' };
    const prepared = prepareDataPublication({
      ...scope,
      revision: 7,
      publicationId: '00000000-0000-4000-8000-000000000007',
      sourceCheckedAt: new Date('2026-08-22T10:00:00.000Z'),
      state: 'active',
      items: [
        { name: 'events', value: [{ id: 4, isCurrent: true }] },
        { name: 'teams', value: [{ id: 1 }] },
        { name: 'players', value: [{ id: 1 }, { id: 2 }] },
        { name: 'phases', value: [{ id: 1 }] },
        { name: 'fixtures', value: [{ id: 41, event: 4, started: false }] },
        { name: 'currentEventId', value: 4 },
        { name: 'selectionRules', value: null },
      ],
    });
    const values = new Map<string, string>([
      [activeDataPublicationKey(scope), JSON.stringify(prepared.manifest)],
      [
        dataPublicationIntegrityProofKey(scope),
        `${prepared.manifest.publicationId}:${prepared.manifest.revision}`,
      ],
      ...prepared.items.map((item) => [item.manifest.key, item.payload] as const),
    ]);
    const gets: string[] = [];
    const commands: string[] = [];
    const redis = {
      get: async (key: string) => {
        gets.push(key);
        return values.get(key) ?? null;
      },
      mget: async (...keys: string[]) => {
        gets.push(...keys);
        return keys.map((key) => values.get(key) ?? null);
      },
      pipeline: () => {
        const pipeline = {
          exists: (key: string) => {
            commands.push(`exists:${key}`);
            return pipeline;
          },
          strlen: (key: string) => {
            commands.push(`strlen:${key}`);
            return pipeline;
          },
          exec: async () =>
            prepared.manifest.items.flatMap((item) => [
              [null, 1],
              [null, item.bytes],
            ]),
        };
        return pipeline;
      },
    } as unknown as Redis;

    await expect(readCoreSnapshotLifecycle(scope.seasonCode, redis)).resolves.toMatchObject({
      manifest: prepared.manifest,
      currentEventId: 4,
      events: [{ id: 4 }],
      fixtures: [{ id: 41 }],
    });
    expect(gets).toContain(activeDataPublicationKey(scope));
    expect(gets.some((key) => key.endsWith(':players'))).toBe(false);
    expect(commands.some((command) => command.endsWith(':players'))).toBe(true);
  });
});
