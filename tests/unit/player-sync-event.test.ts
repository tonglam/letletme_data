import { describe, expect, test } from 'bun:test';

import { resolvePlayerSyncEvent } from '../../src/services/player-sync-event.service';
import type { Event } from '../../src/types';
import { TEST_SEASON } from '../fixtures/seasons.fixtures';

const event = (id: number, finished = false) => ({ id, finished }) as Event;

describe('resolvePlayerSyncEvent', () => {
  test('uses the current event inside the season window', async () => {
    const resolved = await resolvePlayerSyncEvent(TEST_SEASON, new Date(), {
      getCurrentEvent: async () => event(4),
      getNextEvent: async () => event(5),
    });

    expect(resolved).toEqual({ event: event(4), phase: 'current' });
  });

  test('uses the next event before GW1', async () => {
    const resolved = await resolvePlayerSyncEvent(TEST_SEASON, new Date(), {
      getCurrentEvent: async () => null,
      getNextEvent: async () => event(1),
    });

    expect(resolved).toEqual({ event: event(1), phase: 'preseason' });
  });

  test('treats the published current GW as current without calendar inference', async () => {
    const resolved = await resolvePlayerSyncEvent(TEST_SEASON, new Date(), {
      getCurrentEvent: async () => event(1),
      getNextEvent: async () => event(2),
    });

    expect(resolved).toEqual({ event: event(1), phase: 'current' });
  });

  test('keeps the repository-selected current event authoritative at GW38', async () => {
    const resolved = await resolvePlayerSyncEvent(TEST_SEASON, new Date(), {
      getCurrentEvent: async () => event(38, true),
      getNextEvent: async () => null,
    });

    expect(resolved).toEqual({ event: event(38, true), phase: 'current' });
  });
});
