import { describe, expect, test } from 'bun:test';

import {
  EVENT_LIVE_OFFICIAL_MULTIPLIERS_ALGORITHM_VERSION,
  EVENT_LIVE_PROJECTION_ALGORITHM_VERSION,
  projectOfficialCurrentMultiplierScore,
  projectEventLiveManagerScore,
} from '../../src/domain/event-live-manager-projection';
import type { EventLive } from '../../src/domain/event-lives';
import type { EventLiveManagerPick } from '../../src/domain/event-live-manager-score';
import type { Fixture } from '../../src/types';

const checkedAt = new Date('2026-08-25T10:00:00.000Z');

const fixture = (teamH: number, teamA: number, finished: boolean): Fixture => ({
  id: teamH * 100 + teamA,
  code: teamH * 100 + teamA,
  event: 1,
  finished,
  finishedProvisional: false,
  kickoffTime: checkedAt,
  minutes: finished ? 90 : 0,
  provisionalStartTime: false,
  started: finished,
  teamA,
  teamAScore: finished ? 1 : null,
  teamH,
  teamHScore: finished ? 1 : null,
  stats: [],
  teamHDifficulty: 3,
  teamADifficulty: 3,
  pulseId: teamH * 100 + teamA,
  createdAt: checkedAt,
  updatedAt: checkedAt,
});

const live = (elementId: number, totalPoints: number, minutes = 90): EventLive => ({
  eventId: 1,
  elementId,
  minutes,
  goalsScored: 0,
  assists: 0,
  cleanSheets: 0,
  goalsConceded: 0,
  ownGoals: 0,
  penaltiesSaved: 0,
  penaltiesMissed: 0,
  yellowCards: 0,
  redCards: 0,
  saves: 0,
  bonus: 0,
  bps: 0,
  defensiveContribution: 0,
  starts: minutes > 0,
  expectedGoals: null,
  expectedAssists: null,
  expectedGoalInvolvements: null,
  expectedGoalsConceded: null,
  inDreamTeam: false,
  totalPoints,
  createdAt: checkedAt,
});

const picks = (): EventLiveManagerPick[] => {
  const positions = [
    [1, 1, 1, 1],
    [2, 2, 2, 2],
    [3, 2, 3, 2],
    [4, 2, 4, 3],
    [5, 2, 5, 4],
    [6, 3, 6, 5],
    [7, 3, 7, 6],
    [8, 3, 8, 7],
    [9, 4, 9, 8],
    [10, 4, 10, 9],
    [11, 4, 11, 10],
    [12, 2, 12, 11],
    [13, 3, 13, 12],
    [14, 4, 14, 13],
    [15, 2, 15, 14],
  ] as const;
  return positions.map(([position, elementType, elementId, teamId]) => ({
    entryId: 101,
    position,
    elementId,
    multiplier: position === 1 ? 2 : position <= 11 ? 1 : 0,
    isCaptain: position === 1,
    isViceCaptain: position === 2,
    transfersCost: position === 1 ? 0 : null,
    sourceUpdatedAt: checkedAt,
    elementType,
    teamId,
    activeChip: null,
  }));
};

describe('revision-pinned projected manager score', () => {
  test('projects the first eligible bench player and captain multiplier', () => {
    const managerPicks = picks();
    const liveByElement = new Map(
      managerPicks.map((pick) => [pick.elementId, live(pick.elementId, 1)]),
    );
    liveByElement.set(3, live(3, 0, 0));
    liveByElement.set(12, live(12, 5));

    const result = projectEventLiveManagerScore({
      entryId: 101,
      picks: managerPicks,
      liveByElement,
      fixtures: [fixture(2, 97, true), fixture(11, 98, false)],
    });

    expect(EVENT_LIVE_PROJECTION_ALGORITHM_VERSION).toBe('fpl-projected-autosubs-v1');
    expect(result).not.toBeNull();
    expect(result?.effectiveLineup.find((pick) => pick.elementId === 12)).toMatchObject({
      effectiveMultiplier: 1,
      autoSub: true,
      pickActive: true,
    });
    expect(result?.effectiveLineup.find((pick) => pick.elementId === 3)).toMatchObject({
      effectiveMultiplier: 0,
      pickActive: false,
    });
    expect(result?.effectiveLineup.find((pick) => pick.elementId === 1)).toMatchObject({
      captainForScoring: true,
      effectiveMultiplier: 2,
    });
    expect(result?.eventPoints).toBe(16);
  });

  test('returns null for incomplete or ambiguous picks', () => {
    const managerPicks = picks();
    managerPicks[1] = { ...managerPicks[1], isViceCaptain: true, isCaptain: true };
    const liveByElement = new Map(
      managerPicks.map((pick) => [pick.elementId, live(pick.elementId, 1)]),
    );
    expect(
      projectEventLiveManagerScore({
        entryId: 101,
        picks: managerPicks,
        liveByElement,
        fixtures: [],
      }),
    ).toBeNull();
  });

  test('does not mark an inactive vice captain as the scoring captain', () => {
    const managerPicks = picks();
    managerPicks[1] = { ...managerPicks[1], multiplier: 0 };
    const liveByElement = new Map(
      managerPicks.map((pick) => [pick.elementId, live(pick.elementId, 1)]),
    );
    liveByElement.set(1, live(1, 0, 0));

    const result = projectEventLiveManagerScore({
      entryId: 101,
      picks: managerPicks,
      liveByElement,
      fixtures: [fixture(1, 99, true), fixture(2, 98, true)],
    });

    expect(result).not.toBeNull();
    expect(result?.effectiveLineup.find((pick) => pick.elementId === 2)).toMatchObject({
      pickActive: false,
      effectiveMultiplier: 0,
      captainForScoring: false,
    });
    expect(result?.effectiveLineup.filter((pick) => pick.captainForScoring)).toHaveLength(0);
  });

  test('keeps official current multipliers separate from projected autosubs', () => {
    const managerPicks = picks();
    const liveByElement = new Map(
      managerPicks.map((pick) => [pick.elementId, live(pick.elementId, 1)]),
    );
    liveByElement.set(3, live(3, 0, 0));
    liveByElement.set(12, live(12, 5));

    const result = projectOfficialCurrentMultiplierScore({
      entryId: 101,
      picks: managerPicks,
      liveByElement,
    });

    expect(EVENT_LIVE_OFFICIAL_MULTIPLIERS_ALGORITHM_VERSION).toBe(
      'fpl-official-current-multipliers-v1',
    );
    expect(result?.eventPoints).toBe(11);
    expect(result?.effectiveLineup.find((pick) => pick.elementId === 12)).toMatchObject({
      effectiveMultiplier: 0,
      autoSub: false,
    });
  });

  test('marks a promoted vice captain in official current multipliers', () => {
    const managerPicks = picks();
    managerPicks[0] = { ...managerPicks[0], multiplier: 0 };
    managerPicks[1] = { ...managerPicks[1], multiplier: 2 };
    const liveByElement = new Map(
      managerPicks.map((pick) => [pick.elementId, live(pick.elementId, 1)]),
    );
    liveByElement.set(1, live(1, 0, 0));

    const result = projectOfficialCurrentMultiplierScore({
      entryId: 101,
      picks: managerPicks,
      liveByElement,
    });

    expect(result?.effectiveLineup.find((pick) => pick.elementId === 1)).toMatchObject({
      effectiveMultiplier: 0,
      captainForScoring: false,
    });
    expect(result?.effectiveLineup.find((pick) => pick.elementId === 2)).toMatchObject({
      effectiveMultiplier: 2,
      isViceCaptain: true,
      captainForScoring: true,
    });
    expect(result?.effectiveLineup.filter((pick) => pick.captainForScoring)).toHaveLength(1);
  });

  test('retains automatic substitutions already applied by the picks payload', () => {
    const managerPicks = picks();
    managerPicks[2] = { ...managerPicks[2], multiplier: 0 };
    managerPicks[11] = { ...managerPicks[11], multiplier: 1 };
    const liveByElement = new Map(
      managerPicks.map((pick) => [pick.elementId, live(pick.elementId, 1)]),
    );
    liveByElement.set(3, live(3, 0, 0));

    const result = projectEventLiveManagerScore({
      entryId: 101,
      picks: managerPicks,
      liveByElement,
      fixtures: [fixture(2, 97, true)],
    });

    expect(result).not.toBeNull();
    expect(result?.effectiveLineup.find((pick) => pick.elementId === 12)).toMatchObject({
      effectiveMultiplier: 1,
      pickActive: true,
      autoSub: true,
      autoSubForElementId: 3,
    });
    expect(result?.effectiveLineup.find((pick) => pick.elementId === 3)).toMatchObject({
      effectiveMultiplier: 0,
      pickActive: false,
    });
  });

  test('reconstructs applied substitutions against the selected XI formation', () => {
    const managerPicks = picks();
    // Start with exactly three defenders and four midfielders so a midfielder
    // cannot replace the absent defender, while a later defender can.
    managerPicks[4] = { ...managerPicks[4], elementType: 3, multiplier: 0 };
    managerPicks[1] = { ...managerPicks[1], multiplier: 0 };
    managerPicks[11] = { ...managerPicks[11], elementType: 3, multiplier: 1 };
    managerPicks[12] = { ...managerPicks[12], elementType: 2, multiplier: 1 };
    const liveByElement = new Map(
      managerPicks.map((pick) => [pick.elementId, live(pick.elementId, 1)]),
    );
    liveByElement.set(2, live(2, 0, 0));
    liveByElement.set(5, live(5, 0, 0));

    const result = projectEventLiveManagerScore({
      entryId: 101,
      picks: managerPicks,
      liveByElement,
      fixtures: [fixture(2, 97, true), fixture(4, 98, true)],
    });

    expect(result).not.toBeNull();
    expect(result?.effectiveLineup.find((pick) => pick.elementId === 12)).toMatchObject({
      autoSub: true,
      autoSubForElementId: 5,
    });
    expect(result?.effectiveLineup.find((pick) => pick.elementId === 13)).toMatchObject({
      autoSub: true,
      autoSubForElementId: 2,
    });
  });

  test('uses the revision-pinned event total for the manager chip', () => {
    const managerPicks = picks();
    managerPicks[0] = { ...managerPicks[0], activeChip: 'manager' };
    const liveByElement = new Map(
      managerPicks.map((pick) => [pick.elementId, live(pick.elementId, 1)]),
    );

    const result = projectEventLiveManagerScore({
      entryId: 101,
      picks: managerPicks,
      liveByElement,
      fixtures: [],
      // The projected player contribution is 12; the extra seven points are
      // the Assistant Manager contribution carried by entry_history.points.
      reportedEventPoints: 19,
    });

    expect(result?.eventPoints).toBe(19);
    expect(result?.netEventPoints).toBe(19);
  });

  test('adds manager points without discarding projected lineup changes', () => {
    const managerPicks = picks();
    managerPicks[0] = { ...managerPicks[0], activeChip: 'manager' };
    const liveByElement = new Map(
      managerPicks.map((pick) => [pick.elementId, live(pick.elementId, 1)]),
    );
    liveByElement.set(3, live(3, 0, 0));
    liveByElement.set(12, live(12, 5));

    const result = projectEventLiveManagerScore({
      entryId: 101,
      picks: managerPicks,
      liveByElement,
      fixtures: [fixture(2, 97, true)],
      // Source multipliers contribute 11 points; the reported gross total
      // carries eight Assistant Manager points. The projected auto-sub then
      // raises the player component to 16, for a final total of 24.
      reportedEventPoints: 19,
    });

    expect(result?.eventPoints).toBe(24);
    expect(result?.effectiveLineup.find((pick) => pick.elementId === 12)).toMatchObject({
      autoSub: true,
      pickActive: true,
    });
  });

  test('fails closed when the manager chip has no manager scoring input', () => {
    const managerPicks = picks();
    managerPicks[0] = { ...managerPicks[0], activeChip: 'manager' };
    const liveByElement = new Map(
      managerPicks.map((pick) => [pick.elementId, live(pick.elementId, 1)]),
    );

    expect(
      projectEventLiveManagerScore({
        entryId: 101,
        picks: managerPicks,
        liveByElement,
        fixtures: [],
      }),
    ).toBeNull();
  });
});
