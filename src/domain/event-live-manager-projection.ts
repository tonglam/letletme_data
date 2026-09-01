import type { Fixture } from '../types';

import type { EventLive } from './event-lives';
import type { EventLiveManagerPick } from './event-live-manager-score';

export const EVENT_LIVE_PROJECTION_ALGORITHM_VERSION = 'fpl-projected-autosubs-v1';
export const EVENT_LIVE_OFFICIAL_MULTIPLIERS_ALGORITHM_VERSION =
  'fpl-official-current-multipliers-v1';

export type EffectiveLineupRow = Readonly<{
  elementId: number;
  position: number;
  sourceMultiplier: number;
  effectiveMultiplier: number;
  pickActive: boolean;
  autoSub: boolean;
  isCaptain: boolean;
  isViceCaptain: boolean;
  captainForScoring: boolean;
  /** The starter accepted as the outgoing leg of this projected auto-sub. */
  autoSubForElementId?: number | null;
}>;

/** Validate the complete scoring lineup before it crosses a storage/API boundary. */
export const isEffectiveLineup = (value: unknown): value is readonly EffectiveLineupRow[] => {
  if (!Array.isArray(value) || value.length !== 15) return false;
  const elements = new Set<number>();
  const positions = new Set<number>();
  let captainCount = 0;
  let viceCaptainCount = 0;
  let scoringCaptainCount = 0;
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
    const row = candidate as Partial<EffectiveLineupRow>;
    const elementId = row.elementId;
    const position = row.position;
    const sourceMultiplier = row.sourceMultiplier;
    const effectiveMultiplier = row.effectiveMultiplier;
    if (
      typeof elementId !== 'number' ||
      !Number.isSafeInteger(elementId) ||
      elementId <= 0 ||
      typeof position !== 'number' ||
      !Number.isSafeInteger(position) ||
      position < 1 ||
      position > 15 ||
      typeof sourceMultiplier !== 'number' ||
      !Number.isSafeInteger(sourceMultiplier) ||
      sourceMultiplier < 0 ||
      sourceMultiplier > 3 ||
      typeof effectiveMultiplier !== 'number' ||
      !Number.isSafeInteger(effectiveMultiplier) ||
      effectiveMultiplier < 0 ||
      effectiveMultiplier > 3 ||
      typeof row.pickActive !== 'boolean' ||
      typeof row.autoSub !== 'boolean' ||
      typeof row.isCaptain !== 'boolean' ||
      typeof row.isViceCaptain !== 'boolean' ||
      typeof row.captainForScoring !== 'boolean' ||
      (row.autoSubForElementId !== undefined &&
        row.autoSubForElementId !== null &&
        (!Number.isSafeInteger(row.autoSubForElementId) || row.autoSubForElementId <= 0)) ||
      elements.has(elementId) ||
      positions.has(position) ||
      (row.pickActive ? effectiveMultiplier <= 0 : effectiveMultiplier !== 0) ||
      (row.isCaptain && row.isViceCaptain)
    ) {
      return false;
    }
    elements.add(elementId);
    positions.add(position);
    if (row.isCaptain) captainCount += 1;
    if (row.isViceCaptain) viceCaptainCount += 1;
    if (row.captainForScoring) {
      scoringCaptainCount += 1;
      if (!row.pickActive || effectiveMultiplier <= 0) return false;
    }
  }
  return (
    captainCount === 1 &&
    viceCaptainCount === 1 &&
    scoringCaptainCount <= 1 &&
    elements.size === 15 &&
    positions.size === 15
  );
};

export type ProjectedEventLiveManagerScore = Readonly<{
  entryId: number;
  eventPoints: number;
  netEventPoints: number;
  transferCost: number;
  picksCheckedAt: string;
  effectiveLineup: readonly EffectiveLineupRow[];
}>;

/**
 * Score directly with the multipliers currently present on entry picks. This
 * is an internal diagnostic mode; the public live path uses the projected
 * auto-substitution algorithm above. Keeping the mode pure still gives it a
 * deterministic revision without allowing it to share projected
 * materializations.
 */
export function projectOfficialCurrentMultiplierScore(input: {
  entryId: number;
  picks: readonly EventLiveManagerPick[];
  liveByElement: ReadonlyMap<number, EventLive>;
}): ProjectedEventLiveManagerScore | null {
  if (input.picks.length !== 15 || input.picks.some((pick) => pick.entryId !== input.entryId)) {
    return null;
  }
  const positions = new Set(input.picks.map((pick) => pick.position));
  const elements = new Set(input.picks.map((pick) => pick.elementId));
  const captains = input.picks.filter((pick) => pick.isCaptain);
  const viceCaptains = input.picks.filter((pick) => pick.isViceCaptain);
  const transferCostPicks = input.picks.filter((pick) => pick.position === 1);
  const transferCosts = new Set(transferCostPicks.map((pick) => pick.transfersCost));
  const sourceTimestamps = new Set(input.picks.map((pick) => pick.sourceUpdatedAt.getTime()));
  if (
    positions.size !== 15 ||
    [...positions].some(
      (position) => !Number.isSafeInteger(position) || position < 1 || position > 15,
    ) ||
    elements.size !== 15 ||
    transferCostPicks.length !== 1 ||
    captains.length !== 1 ||
    viceCaptains.length !== 1 ||
    transferCosts.size !== 1 ||
    sourceTimestamps.size !== 1
  ) {
    return null;
  }
  const transferCost = [...transferCosts][0];
  if (transferCost === null || !Number.isSafeInteger(transferCost) || transferCost < 0) {
    return null;
  }
  const effectiveLineup: EffectiveLineupRow[] = [];
  let eventPoints = 0;
  for (const pick of input.picks) {
    if (!Number.isSafeInteger(pick.multiplier) || pick.multiplier < 0 || pick.multiplier > 3) {
      return null;
    }
    const live = input.liveByElement.get(pick.elementId);
    if (!live || !Number.isSafeInteger(live.totalPoints)) return null;
    eventPoints += live.totalPoints * pick.multiplier;
    effectiveLineup.push({
      elementId: pick.elementId,
      position: pick.position,
      sourceMultiplier: pick.multiplier,
      effectiveMultiplier: pick.multiplier,
      pickActive: pick.multiplier > 0,
      autoSub: false,
      isCaptain: pick.isCaptain,
      isViceCaptain: pick.isViceCaptain,
      // FPL may promote the vice-captain in the official multiplier payload
      // when the original captain did not play. The scoring captain is the
      // captain-role pick carrying the applied multiplier, not necessarily the
      // row marked isCaptain.
      captainForScoring: (pick.isCaptain || pick.isViceCaptain) && pick.multiplier > 1,
    });
  }
  if (!Number.isSafeInteger(eventPoints) || !isEffectiveLineup(effectiveLineup)) return null;
  return {
    entryId: input.entryId,
    eventPoints,
    netEventPoints: eventPoints - transferCost,
    transferCost,
    picksCheckedAt: new Date([...sourceTimestamps][0]!).toISOString(),
    effectiveLineup,
  };
}

type ProjectionPick = EventLiveManagerPick & {
  elementType: number;
  teamId: number;
};

type MutableProjectionPick = ProjectionPick & {
  effectiveMultiplier: number;
  pickActive: boolean;
  autoSub: boolean;
  autoSubForElementId: number | null;
};

const isCompletedFixture = (fixture: Fixture): boolean =>
  fixture.finished || fixture.finishedProvisional;

const hasCompletedFixtures = (fixtures: readonly Fixture[]): boolean =>
  fixtures.length === 0 || fixtures.every(isCompletedFixture);

const validFormation = (picks: readonly MutableProjectionPick[]): boolean => {
  const active = picks.filter((pick) => pick.effectiveMultiplier > 0);
  const goalkeepers = active.filter((pick) => pick.elementType === 1).length;
  const defenders = active.filter((pick) => pick.elementType === 2).length;
  const midfielders = active.filter((pick) => pick.elementType === 3).length;
  const forwards = active.filter((pick) => pick.elementType === 4).length;
  return (
    goalkeepers === 1 &&
    defenders >= 3 &&
    defenders <= 5 &&
    midfielders >= 2 &&
    midfielders <= 5 &&
    forwards >= 1 &&
    forwards <= 3
  );
};

const chipIs = (chip: string | null | undefined, ...values: string[]): boolean =>
  chip !== null && chip !== undefined && values.includes(chip);

/**
 * Project the eventual FPL lineup from one immutable event-live publication.
 * This deliberately accepts all source facts as arguments so it cannot mix a
 * newer fixture/live row with an older publication during a request.
 */
export function projectEventLiveManagerScore(input: {
  entryId: number;
  picks: readonly EventLiveManagerPick[];
  liveByElement: ReadonlyMap<number, EventLive>;
  fixtures: readonly Fixture[];
  /**
   * FPL's entry-history event total, captured in the same immutable picks
   * publication.  Assistant Manager adds points that do not exist in the
   * player-live rows, so that chip must use this manager-aware fact after the
   * player lineup has been projected.
   */
  reportedEventPoints?: number | null;
}): ProjectedEventLiveManagerScore | null {
  if (input.picks.length !== 15 || input.picks.some((pick) => pick.entryId !== input.entryId)) {
    return null;
  }

  const picks: MutableProjectionPick[] = input.picks.map((pick) => ({
    ...pick,
    elementType: pick.elementType ?? 0,
    teamId: pick.teamId ?? 0,
    effectiveMultiplier: pick.multiplier > 0 ? 1 : 0,
    pickActive: pick.multiplier > 0,
    autoSub: false,
    autoSubForElementId: null,
  }));
  const positions = new Set(picks.map((pick) => pick.position));
  const elements = new Set(picks.map((pick) => pick.elementId));
  const captainCount = picks.filter((pick) => pick.isCaptain).length;
  const viceCaptainCount = picks.filter((pick) => pick.isViceCaptain).length;
  const transferCostPicks = picks.filter((pick) => pick.position === 1);
  const transferCosts = new Set(transferCostPicks.map((pick) => pick.transfersCost));
  const sourceTimestamps = new Set(picks.map((pick) => pick.sourceUpdatedAt.getTime()));
  if (
    positions.size !== 15 ||
    [...positions].some(
      (position) => !Number.isSafeInteger(position) || position < 1 || position > 15,
    ) ||
    elements.size !== 15 ||
    captainCount !== 1 ||
    viceCaptainCount !== 1 ||
    transferCostPicks.length !== 1 ||
    transferCosts.size !== 1 ||
    sourceTimestamps.size !== 1 ||
    picks.some(
      (pick) =>
        pick.elementType < 1 ||
        pick.elementType > 4 ||
        pick.teamId <= 0 ||
        !Number.isSafeInteger(pick.multiplier) ||
        pick.multiplier < 0 ||
        pick.multiplier > 3,
    )
  ) {
    return null;
  }

  const transferCost = [...transferCosts][0];
  if (transferCost === null || !Number.isSafeInteger(transferCost) || transferCost < 0) {
    return null;
  }

  const fixturesByTeam = new Map<number, Fixture[]>();
  for (const fixture of input.fixtures) {
    if (fixture.event === null) continue;
    const home = fixturesByTeam.get(fixture.teamH) ?? [];
    home.push(fixture);
    fixturesByTeam.set(fixture.teamH, home);
    const away = fixturesByTeam.get(fixture.teamA) ?? [];
    away.push(fixture);
    fixturesByTeam.set(fixture.teamA, away);
  }

  // `activeChip` is stored on the position-1 row, but keep the pure
  // projector independent of repository ordering so a caller cannot change
  // scoring semantics merely by reordering the 15 picks.
  const chip = picks.find((pick) => pick.position === 1)?.activeChip ?? null;
  const managerChip = chipIs(chip, 'manager', 'MANAGER');
  if (
    managerChip &&
    (input.reportedEventPoints === null ||
      input.reportedEventPoints === undefined ||
      !Number.isSafeInteger(input.reportedEventPoints))
  ) {
    // The manager chip adds a separate manager-scoring fact that is not present
    // in player-live rows. Never publish a partial player-only score when the
    // immutable manager-aware source is unavailable.
    return null;
  }
  const benchBoost = chipIs(chip, 'bboost', 'BENCH_BOOST');
  const captainMultiplier = chipIs(chip, '3xc', 'TRIPLE_CAPTAIN') ? 3 : 2;
  const starters = picks
    .filter((pick) => pick.position <= 11)
    .sort((left, right) => left.position - right.position);
  const benchPicks = picks
    .filter((pick) => pick.position > 11)
    .sort((left, right) => left.position - right.position);
  const alreadyAppliedBench = benchPicks.filter((pick) => pick.multiplier > 0);
  const bench = benchPicks.filter((pick) => pick.multiplier === 0);
  const nonPlayingStarters = starters.filter((pick) => {
    const live = input.liveByElement.get(pick.elementId);
    const teamFixtures = fixturesByTeam.get(pick.teamId) ?? [];
    return (live?.minutes ?? 0) === 0 && hasCompletedFixtures(teamFixtures);
  });

  if (!benchBoost) {
    // FPL may already have applied an automatic substitution in the picks
    // payload. In that case the promoted bench player has a positive source
    // multiplier and the outgoing starter has a zero multiplier, so looking
    // only at zero-multiplier bench rows loses the authoritative substitution
    // evidence. Pair each such promoted player with the first no-show starter
    // that leaves a legal formation, before projecting any unresolved pairs.
    const alreadyAppliedOutgoingStarters = starters.filter((pick) => {
      const live = input.liveByElement.get(pick.elementId);
      const teamFixtures = fixturesByTeam.get(pick.teamId) ?? [];
      return (
        pick.multiplier === 0 && (live?.minutes ?? 0) === 0 && hasCompletedFixtures(teamFixtures)
      );
    });
    // Reconstruct the selected XI before applying the substitutions already
    // reflected in the FPL multipliers. Checking the current final XI alone
    // cannot distinguish crossed pairs when both final formations are legal.
    const nonPlayingStarterIds = new Set(nonPlayingStarters.map((pick) => pick.elementId));
    for (const pick of picks) {
      const selectedStarter =
        pick.position <= 11 && (pick.multiplier > 0 || nonPlayingStarterIds.has(pick.elementId));
      pick.effectiveMultiplier = selectedStarter ? 1 : 0;
      pick.pickActive = selectedStarter;
      pick.autoSub = false;
      pick.autoSubForElementId = null;
    }
    const remainingNonPlayingStarters = [...nonPlayingStarters];
    const usedOutgoingStarters = new Set<number>();
    for (const benchPlayer of alreadyAppliedBench) {
      let matched = false;
      for (const starter of alreadyAppliedOutgoingStarters) {
        if (usedOutgoingStarters.has(starter.elementId)) continue;
        const previousStarterMultiplier = starter.effectiveMultiplier;
        const previousStarterActive = starter.pickActive;
        const previousStarterAutoSub = starter.autoSub;
        const previousStarterAutoSubForElementId = starter.autoSubForElementId;
        const previousBenchMultiplier = benchPlayer.effectiveMultiplier;
        const previousBenchActive = benchPlayer.pickActive;
        const previousAutoSub = benchPlayer.autoSub;
        const previousAutoSubForElementId = benchPlayer.autoSubForElementId;
        starter.effectiveMultiplier = 0;
        starter.pickActive = false;
        benchPlayer.effectiveMultiplier = 1;
        benchPlayer.pickActive = true;
        benchPlayer.autoSub = true;
        benchPlayer.autoSubForElementId = starter.elementId;
        if (validFormation(picks)) {
          usedOutgoingStarters.add(starter.elementId);
          const remainingIndex = remainingNonPlayingStarters.findIndex(
            (candidate) => candidate.elementId === starter.elementId,
          );
          if (remainingIndex >= 0) remainingNonPlayingStarters.splice(remainingIndex, 1);
          matched = true;
          break;
        }
        starter.effectiveMultiplier = previousStarterMultiplier;
        starter.pickActive = previousStarterActive;
        starter.autoSub = previousStarterAutoSub;
        starter.autoSubForElementId = previousStarterAutoSubForElementId;
        benchPlayer.effectiveMultiplier = previousBenchMultiplier;
        benchPlayer.pickActive = previousBenchActive;
        benchPlayer.autoSub = previousAutoSub;
        benchPlayer.autoSubForElementId = previousAutoSubForElementId;
      }
      if (!matched) return null;
    }

    for (const benchPlayer of bench) {
      const benchLive = input.liveByElement.get(benchPlayer.elementId);
      const benchFixtures = fixturesByTeam.get(benchPlayer.teamId) ?? [];
      // A first-choice substitute remains eligible while their own fixture is
      // still pending. Once it is confirmed as a no-show, try the next bench
      // player instead.
      if ((benchLive?.minutes ?? 0) === 0 && hasCompletedFixtures(benchFixtures)) continue;
      if (remainingNonPlayingStarters.length === 0) break;

      for (let index = 0; index < remainingNonPlayingStarters.length; index += 1) {
        const starter = remainingNonPlayingStarters[index];
        const previousStarterMultiplier = starter.effectiveMultiplier;
        const previousBenchMultiplier = benchPlayer.effectiveMultiplier;
        const previousStarterActive = starter.pickActive;
        const previousBenchActive = benchPlayer.pickActive;
        const previousBenchAutoSub = benchPlayer.autoSub;
        const previousBenchAutoSubForElementId = benchPlayer.autoSubForElementId;

        starter.effectiveMultiplier = 0;
        starter.pickActive = false;
        benchPlayer.effectiveMultiplier = 1;
        benchPlayer.pickActive = true;
        benchPlayer.autoSub = true;
        benchPlayer.autoSubForElementId = starter.elementId;
        if (validFormation(picks)) {
          remainingNonPlayingStarters.splice(index, 1);
          break;
        }

        starter.effectiveMultiplier = previousStarterMultiplier;
        starter.pickActive = previousStarterActive;
        benchPlayer.effectiveMultiplier = previousBenchMultiplier;
        benchPlayer.pickActive = previousBenchActive;
        benchPlayer.autoSub = previousBenchAutoSub;
        benchPlayer.autoSubForElementId = previousBenchAutoSubForElementId;
      }
    }
  } else {
    for (const pick of picks) {
      pick.effectiveMultiplier = 1;
      pick.pickActive = true;
    }
  }

  const originalCaptain = picks.find((pick) => pick.isCaptain) ?? null;
  if (!originalCaptain) return null;
  const originalCaptainLive = input.liveByElement.get(originalCaptain.elementId);
  const originalCaptainFixtures = fixturesByTeam.get(originalCaptain.teamId) ?? [];
  const captainAppeared = (originalCaptainLive?.minutes ?? 0) > 0;
  const captainCompleted = hasCompletedFixtures(originalCaptainFixtures);
  const viceCaptain = picks.find((pick) => pick.isViceCaptain) ?? null;
  const viceLive = viceCaptain ? input.liveByElement.get(viceCaptain.elementId) : undefined;
  const captainForScoring =
    captainAppeared || !captainCompleted
      ? originalCaptain
      : viceCaptain &&
          (viceLive?.minutes ?? 0) > 0 &&
          viceCaptain.pickActive &&
          viceCaptain.effectiveMultiplier > 0
        ? viceCaptain
        : null;

  if (originalCaptain !== captainForScoring && originalCaptain.effectiveMultiplier > 1) {
    originalCaptain.effectiveMultiplier = 1;
  }
  if (captainForScoring && captainForScoring.effectiveMultiplier > 0) {
    captainForScoring.effectiveMultiplier = captainMultiplier;
  }

  const points = picks.reduce((sum, pick) => {
    const live = input.liveByElement.get(pick.elementId);
    if (!live || !Number.isSafeInteger(live.totalPoints)) return Number.NaN;
    return sum + live.totalPoints * pick.effectiveMultiplier;
  }, 0);
  if (!Number.isSafeInteger(points)) return null;

  // `reportedEventPoints` is the whole FPL gross total, not just the
  // Assistant Manager contribution. Derive the manager-only delta from the
  // source multipliers before adding it to the projected lineup score. Using
  // the projected score as the baseline would erase a newly inferred
  // auto-substitution or vice-captain promotion.
  const sourceMultiplierPoints = picks.reduce((sum, pick) => {
    const live = input.liveByElement.get(pick.elementId);
    if (!live || !Number.isSafeInteger(live.totalPoints)) return Number.NaN;
    return sum + live.totalPoints * pick.multiplier;
  }, 0);
  if (!Number.isSafeInteger(sourceMultiplierPoints)) return null;
  const managerPoints = managerChip ? input.reportedEventPoints! - sourceMultiplierPoints : 0;
  if (managerChip && managerPoints < 0) return null;
  const eventPoints = points + managerPoints;

  const picksCheckedAt = new Date([...sourceTimestamps][0]!).toISOString();
  return {
    entryId: input.entryId,
    eventPoints,
    netEventPoints: eventPoints - transferCost,
    transferCost,
    picksCheckedAt,
    effectiveLineup: picks.map((pick) => ({
      elementId: pick.elementId,
      position: pick.position,
      sourceMultiplier: pick.multiplier,
      effectiveMultiplier: pick.effectiveMultiplier,
      pickActive: pick.pickActive,
      autoSub: pick.autoSub,
      isCaptain: pick.isCaptain,
      isViceCaptain: pick.isViceCaptain,
      captainForScoring: pick === captainForScoring,
      autoSubForElementId: pick.autoSubForElementId,
    })),
  };
}
