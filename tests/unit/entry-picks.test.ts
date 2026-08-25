import { describe, expect, test } from 'bun:test';

import {
  isCompleteEntryPicks,
  isEntryPicksPayloadForEvent,
  resolveScoringCaptainPick,
} from '../../src/domain/entry-picks';

describe('entry picks payload identity', () => {
  test('accepts only the requested event', () => {
    const payload = { entry_history: { event: 12 } };

    expect(isEntryPicksPayloadForEvent(payload, 12)).toBe(true);
    expect(isEntryPicksPayloadForEvent(payload, 11)).toBe(false);
    expect(isEntryPicksPayloadForEvent({ entry_history: {} }, 12)).toBe(false);
  });
});

describe('entry picks multiplier completeness', () => {
  const picks = Array.from({ length: 15 }, (_, index) => ({
    element: index + 1,
    position: index + 1,
    multiplier: index === 0 ? 2 : index < 11 ? 1 : 0,
    is_captain: index === 0,
    is_vice_captain: index === 1,
  }));

  test('accepts finalized automatic substitutions and captain promotion', () => {
    const finalized = picks.map((pick) => {
      if (pick.is_captain) return { ...pick, multiplier: 0 };
      if (pick.is_vice_captain) return { ...pick, multiplier: 2 };
      if (pick.position === 3) return { ...pick, multiplier: 0 };
      if (pick.position === 12) return { ...pick, multiplier: 1 };
      return pick;
    });

    expect(isCompleteEntryPicks(finalized)).toBe(true);
    expect(resolveScoringCaptainPick(finalized)?.element).toBe(2);
  });

  test('keeps the selected captain before any promotion is applied', () => {
    expect(resolveScoringCaptainPick(picks)?.element).toBe(1);
  });

  test('accepts official bench captain roles and a displaced captain multiplier', () => {
    const benchVice = picks.map((pick) => ({
      ...pick,
      is_vice_captain: pick.position === 13,
    }));
    const promotedVice = picks.map((pick) => {
      if (pick.is_captain) return { ...pick, multiplier: 1 };
      if (pick.is_vice_captain) return { ...pick, multiplier: 2 };
      return pick;
    });
    const benchCaptain = picks.map((pick) => ({
      ...pick,
      multiplier: pick.position === 1 ? 2 : pick.position < 11 ? 1 : 0,
      is_captain: pick.position === 14,
      is_vice_captain: pick.position === 1,
    }));

    expect(isCompleteEntryPicks(benchVice)).toBe(true);
    expect(isCompleteEntryPicks(promotedVice)).toBe(true);
    expect(isCompleteEntryPicks(benchCaptain)).toBe(true);
    expect(resolveScoringCaptainPick(promotedVice)?.element).toBe(2);
    expect(resolveScoringCaptainPick(benchCaptain)?.element).toBe(1);
  });

  test('rejects scoring bonuses outside the captain roles or on both roles', () => {
    expect(
      isCompleteEntryPicks(
        picks.map((pick) => (pick.position === 12 ? { ...pick, multiplier: 2 } : pick)),
      ),
    ).toBe(false);
    expect(
      isCompleteEntryPicks(
        picks.map((pick) => (pick.is_vice_captain ? { ...pick, multiplier: 2 } : pick)),
      ),
    ).toBe(false);
  });
});
