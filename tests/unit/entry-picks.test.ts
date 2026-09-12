import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';

import {
  isCompleteEntryPicks,
  isEntryPicksPayloadForEvent,
  resolveScoringCaptainPick,
} from '../../src/domain/entry-picks';
import { entryInfoRepository } from '../../src/repositories/entry-infos';
import { tournamentEntryRepository } from '../../src/repositories/tournament-entries';
import { tournamentInfoRepository } from '../../src/repositories/tournament-infos';
import * as trends from '../../src/services/tournament-trends-publication.service';
import { publishActiveTournamentTrendScopesAfterEntryPicks } from '../../src/services/tournament-event-picks.service';
import { TEST_SEASON } from '../fixtures/seasons.fixtures';

afterEach(() => mock.restore());

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

describe('entry-picks Trends publication trigger', () => {
  function stubActiveTournamentScope() {
    spyOn(tournamentInfoRepository, 'findActive').mockResolvedValue([
      { id: 901 },
      { id: 902 },
    ] as never);
    spyOn(tournamentEntryRepository, 'findEntryIdsByTournamentId').mockImplementation(
      async (_season, tournamentId) => (tournamentId === 901 ? [101] : [102]),
    );
    spyOn(entryInfoRepository, 'findByIds').mockResolvedValue([
      { id: 101, startedEvent: 1 },
      { id: 102, startedEvent: 5 },
    ] as never);
  }

  test('publishes eligible active tournament scopes after the scan completes', async () => {
    stubActiveTournamentScope();
    const publisher = spyOn(trends, 'publishTournamentTrendScopes').mockResolvedValue({
      succeeded: 1,
      failed: 0,
      results: [{ isActive: true }],
    } as never);

    await publishActiveTournamentTrendScopesAfterEntryPicks(TEST_SEASON, 4);

    expect(publisher).toHaveBeenCalledWith(TEST_SEASON, 4, [901]);
  });

  test('fails when a required scope publication is not active', async () => {
    stubActiveTournamentScope();
    spyOn(trends, 'publishTournamentTrendScopes').mockResolvedValue({
      succeeded: 1,
      failed: 0,
      results: [{ isActive: false }],
    } as never);

    await expect(publishActiveTournamentTrendScopesAfterEntryPicks(TEST_SEASON, 4)).rejects.toThrow(
      'Tournament Trends publication failed after entry picks converged',
    );
  });

  test('fails when a required scope publication throws', async () => {
    stubActiveTournamentScope();
    spyOn(trends, 'publishTournamentTrendScopes').mockResolvedValue({
      succeeded: 0,
      failed: 1,
      results: [],
    } as never);

    await expect(publishActiveTournamentTrendScopesAfterEntryPicks(TEST_SEASON, 4)).rejects.toThrow(
      'Tournament Trends publication failed after entry picks converged',
    );
  });
});
