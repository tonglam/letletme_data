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
      isFPLSeason: async () => true,
    });

    expect(resolved).toEqual({ event: event(4), phase: 'current' });
  });

  test('uses the next event before GW1', async () => {
    const resolved = await resolvePlayerSyncEvent(TEST_SEASON, new Date(), {
      getCurrentEvent: async () => null,
      getNextEvent: async () => event(1),
      isFPLSeason: async () => false,
    });

    expect(resolved).toEqual({ event: event(1), phase: 'preseason' });
  });

  test('keeps GW1 in preseason until the fixture-derived season window opens', async () => {
    const resolved = await resolvePlayerSyncEvent(TEST_SEASON, new Date(), {
      getCurrentEvent: async () => event(1),
      getNextEvent: async () => event(2),
      isFPLSeason: async () => false,
    });

    expect(resolved).toEqual({ event: event(1), phase: 'preseason' });
  });

  test('rejects the repository-selected current event after the season window', async () => {
    const resolved = await resolvePlayerSyncEvent(TEST_SEASON, new Date(), {
      getCurrentEvent: async () => event(38, true),
      getNextEvent: async () => null,
      isFPLSeason: async () => false,
    });

    expect(resolved).toBeNull();
  });

  test('uses GW38 while the season window is still active', async () => {
    const resolved = await resolvePlayerSyncEvent(TEST_SEASON, new Date(), {
      getCurrentEvent: async () => event(38, true),
      getNextEvent: async () => null,
      isFPLSeason: async () => true,
    });

    expect(resolved).toEqual({ event: event(38, true), phase: 'current' });
  });
});
