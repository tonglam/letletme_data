import { describe, expect, test } from 'bun:test';

import type { DbEntryEventResult, DbEventLive } from '../../src/db/schemas/index.schema';
import { validateAutomaticSubs } from '../../src/repositories/entry-event-results';
import {
  buildEntryResultData,
  findEventEligibleEntryIds,
  findMissingLeagueResultEntryIds,
  isEntryResultRichEnough,
  latestFreshnessTimestamp,
} from '../../src/services/league-event-results.service';
import type { RawFPLEntryEventPicksResponse } from '../../src/types';

describe('league event result convergence', () => {
  test('rejects malformed fallback automatic substitutions', () => {
    const picks = Array.from({ length: 15 }, (_, index) => ({
      element: index + 1,
      position: index + 1,
      multiplier: index === 0 ? 2 : index < 11 ? 1 : 0,
      is_captain: index === 0,
      is_vice_captain: index === 1,
    }));
    expect(() =>
      validateAutomaticSubs(123, 9, {
        active_chip: null,
        automatic_subs: [{ entry: 999, event: 9, element_in: 1, element_out: 2 }],
        entry_history: {
          event: 9,
          points: 1,
          total_points: 1,
          rank: 1,
          overall_rank: 1,
          bank: 0,
          value: 1000,
          event_transfers: 0,
          event_transfers_cost: 0,
          points_on_bench: 0,
        },
        picks,
      }),
    ).toThrow('Refusing invalid automatic substitutions');
  });

  test('rejects repeated or conflicting automatic-substitution elements', () => {
    const picks = Array.from({ length: 15 }, (_, index) => ({
      element: index + 1,
      position: index + 1,
      multiplier: index === 0 ? 2 : index < 11 ? 1 : 0,
      is_captain: index === 0,
      is_vice_captain: index === 1,
    }));
    const payload = {
      active_chip: null,
      entry_history: {
        event: 9,
        points: 1,
        total_points: 1,
        rank: 1,
        overall_rank: 1,
        bank: 0,
        value: 1000,
        event_transfers: 0,
        event_transfers_cost: 0,
        points_on_bench: 0,
      },
      picks,
    };

    expect(() =>
      validateAutomaticSubs(123, 9, {
        ...payload,
        automatic_subs: [
          { entry: 123, event: 9, element_in: 12, element_out: 3 },
          { entry: 123, event: 9, element_in: 12, element_out: 4 },
        ],
      }),
    ).toThrow('Refusing invalid automatic substitutions');
    expect(() =>
      validateAutomaticSubs(123, 9, {
        ...payload,
        automatic_subs: [
          { entry: 123, event: 9, element_in: 12, element_out: 3 },
          { entry: 123, event: 9, element_in: 3, element_out: 4 },
        ],
      }),
    ).toThrow('Refusing invalid automatic substitutions');
  });

  test('requires rich evidence at or after the requested freshness boundary', () => {
    const cutoff = new Date('2026-08-04T10:00:00.000Z');
    expect(isEntryResultRichEnough(undefined, cutoff)).toBe(false);
    expect(
      isEntryResultRichEnough({ richSyncedAt: new Date('2026-08-04T09:59:59.999Z') }, cutoff),
    ).toBe(false);
    expect(isEntryResultRichEnough({ richSyncedAt: cutoff }, cutoff)).toBe(true);
    expect(isEntryResultRichEnough({ richSyncedAt: null })).toBe(false);
  });

  test('chooses the later exact timestamp inside one JavaScript millisecond', () => {
    const earlier = '2026-08-04T10:00:00.000100Z';
    const later = '2026-08-04T10:00:00.000900Z';
    expect(new Date(earlier).getTime()).toBe(new Date(later).getTime());
    expect(latestFreshnessTimestamp(earlier, later)).toBe(later);
    expect(latestFreshnessTimestamp(later, earlier)).toBe(later);
  });

  test('recomputes a stale cached manager score from fetched picks and event-live', () => {
    const core = {
      eventPicks: null,
      eventAutoSub: null,
      eventPoints: 23,
      eventTransfers: 0,
      eventTransfersCost: 0,
      eventNetPoints: 23,
      eventBenchPoints: 3,
      eventAutoSubPoints: null,
      eventRank: 10,
      eventChip: null,
      overallPoints: 100,
      overallRank: 1000,
      teamValue: 1005,
      bank: 5,
    } as DbEntryEventResult;
    const fallback = {
      active_chip: null,
      automatic_subs: [],
      entry_history: {
        event: 9,
        points: 23,
        total_points: 100,
        rank: 10,
        overall_rank: 1000,
        bank: 5,
        value: 1005,
        event_transfers: 0,
        event_transfers_cost: 0,
        points_on_bench: 3,
      },
      picks: Array.from({ length: 15 }, (_, index) => ({
        element: index + 7,
        position: index + 1,
        multiplier: index === 0 ? 2 : index < 11 ? 1 : 0,
        is_captain: index === 0,
        is_vice_captain: index === 1,
      })),
    } satisfies RawFPLEntryEventPicksResponse;
    const eventLive = new Map(
      fallback.picks.map((pick) => [
        pick.element,
        {
          elementId: pick.element,
          totalPoints:
            pick.element === 7
              ? 8
              : pick.element === 8
                ? 9
                : pick.element === 9
                  ? 10
                  : pick.element === 10 || pick.element === 11
                    ? 1
                    : 0,
          minutes: 90,
        } as DbEventLive,
      ]),
    );

    const result = buildEntryResultData(core, fallback, 9, eventLive, new Map([[7, 3]]));
    expect(result).toMatchObject({
      eventPoints: 37,
      eventNetPoints: 37,
      overallPoints: 114,
      captainId: 7,
      captainPoints: 16,
      highestScoreElementId: 9,
    });
  });

  test('uses the promoted vice-captain multiplier for finalized captain aggregates', () => {
    const fallback = {
      active_chip: null,
      automatic_subs: [],
      entry_history: {
        event: 9,
        points: 55,
        total_points: 500,
        rank: 10,
        overall_rank: 1000,
        bank: 5,
        value: 1005,
        event_transfers: 1,
        event_transfers_cost: 4,
        points_on_bench: 3,
      },
      picks: Array.from({ length: 15 }, (_, index) => ({
        element: index + 1,
        position: index + 1,
        multiplier: index === 0 ? 0 : index === 1 ? 2 : index === 11 ? 1 : index < 11 ? 1 : 0,
        is_captain: index === 0,
        is_vice_captain: index === 1,
      })),
    } satisfies RawFPLEntryEventPicksResponse;
    const eventLive = new Map(
      fallback.picks.map((pick) => [
        pick.element,
        {
          elementId: pick.element,
          totalPoints:
            pick.element === 1 ? 5 : pick.element === 2 ? 7 : pick.element === 12 ? 6 : 0,
          minutes: pick.element === 1 ? 0 : 90,
        } as DbEventLive,
      ]),
    );

    expect(buildEntryResultData(undefined, fallback, 9, eventLive, new Map())).toMatchObject({
      captainId: 1,
      viceCaptainId: 2,
      playedCaptainId: 2,
      captainPoints: 14,
      viceCaptainPoints: 7,
      eventBenchPoints: 5,
    });
  });

  test('rejects a result when event-live omits one required pick', () => {
    const fallback = {
      active_chip: null,
      automatic_subs: [],
      entry_history: {
        event: 9,
        points: 55,
        total_points: 500,
        rank: 10,
        overall_rank: 1000,
        bank: 5,
        value: 1005,
        event_transfers: 1,
        event_transfers_cost: 4,
        points_on_bench: 3,
      },
      picks: Array.from({ length: 15 }, (_, index) => ({
        element: index + 1,
        position: index + 1,
        multiplier: index === 0 ? 2 : index < 11 ? 1 : 0,
        is_captain: index === 0,
        is_vice_captain: index === 1,
      })),
    } satisfies RawFPLEntryEventPicksResponse;
    const partialLive = new Map(
      fallback.picks
        .slice(0, 14)
        .map((pick) => [
          pick.element,
          { elementId: pick.element, totalPoints: 0, minutes: 0 } as DbEventLive,
        ]),
    );

    expect(buildEntryResultData(undefined, fallback, 9, partialLive, new Map())).toBeNull();
  });

  test('rejects fallback picks from a different event', () => {
    const fallback = {
      active_chip: null,
      automatic_subs: [],
      entry_history: {
        event: 8,
        points: 55,
        total_points: 500,
        rank: 10,
        overall_rank: 1000,
        bank: 5,
        value: 1005,
        event_transfers: 1,
        event_transfers_cost: 4,
        points_on_bench: 3,
      },
      picks: Array.from({ length: 15 }, (_, index) => ({
        element: index + 1,
        position: index + 1,
        multiplier: index === 0 ? 2 : index < 11 ? 1 : 0,
        is_captain: index === 0,
        is_vice_captain: index === 1,
      })),
    } satisfies RawFPLEntryEventPicksResponse;
    const eventLive = new Map(
      fallback.picks.map((pick) => [
        pick.element,
        { elementId: pick.element, totalPoints: 0, minutes: 0 } as DbEventLive,
      ]),
    );

    expect(buildEntryResultData(undefined, fallback, 9, eventLive, new Map())).toBeNull();
  });

  test('returns the exact missing canonical result IDs', () => {
    expect(findMissingLeagueResultEntryIds([1, 2, 3, 4], new Set([1, 3]))).toEqual([2, 4]);
  });

  test('excludes managers from gameweeks before their first entry event', () => {
    expect(
      findEventEligibleEntryIds(
        [1, 2, 3, 4],
        [
          { id: 1, startedEvent: 1 },
          { id: 2, startedEvent: 10 },
          { id: 3, startedEvent: null },
        ],
        9,
      ),
    ).toEqual([1, 3, 4]);
  });
});
