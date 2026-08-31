export type MyFplManagerReviewStatus = 'PROVISIONAL' | 'FINAL';

export type MyFplManagerReviewPickInput = Readonly<{
  element: number;
  position: number;
  webName: string;
  teamShortName: string;
  elementTypeName: string;
  isCaptain: boolean;
  isViceCaptain: boolean;
  multiplier: number;
  totalPoints: number;
  isPlayed: boolean;
  autoSub: boolean;
}>;

export type MyFplAutomaticSubstitutionInput = Readonly<{
  elementIn: number;
  elementOut: number;
}>;

export type MyFplManagerReviewGameweekInput = Readonly<{
  eventId: number;
  status: MyFplManagerReviewStatus;
  eventPoints: number;
  eventRank: number | null;
  overallPoints: number;
  overallRank: number | null;
  eventTransfers: number;
  eventTransfersCost: number;
  eventNetPoints: number;
  eventBenchPoints: number;
  eventAutoSubPoints: number;
  eventChip: string;
  eventCaptainPoints: number;
  playedCaptainElement: number | null;
  playedCaptainWebName: string | null;
  playedCaptainTeamShortName: string | null;
  teamValue: number | null;
  bank: number | null;
  picks: readonly MyFplManagerReviewPickInput[];
  automaticSubstitutions: readonly MyFplAutomaticSubstitutionInput[];
}>;

export type MyFplManagerTimelineRow = Readonly<{
  eventId: number;
  status: MyFplManagerReviewStatus;
  eventPoints: number;
  eventRank: number | null;
  overallPoints: number;
  overallRank: number | null;
  overallRankDelta: number | null;
  eventTransfers: number;
  eventTransfersCost: number;
  eventNetPoints: number;
  eventBenchPoints: number;
  eventAutoSubPoints: number;
  eventChip: string;
  eventCaptainPoints: number;
  captainWebName: string | null;
  captainTeamShortName: string | null;
  teamValue: number | null;
  bank: number | null;
  review: MyFplManagerGameweekReview;
}>;

export type MyFplManagerPositionPoints = Readonly<{
  goalkeeper: number;
  defender: number;
  midfielder: number;
  forward: number;
  total: number;
}>;

export type MyFplManagerCaptainReview = Readonly<{
  captainElement: number | null;
  captainWebName: string | null;
  captainTeamShortName: string | null;
  captainBasePoints: number;
  captainContribution: number;
  viceCaptainElement: number | null;
  viceCaptainWebName: string | null;
  viceCaptainBasePoints: number;
  bestSquadElement: number | null;
  bestSquadWebName: string | null;
  bestSquadPoints: number;
  regretPoints: number | null;
}>;

export type MyFplManagerAutomaticSubstitution = Readonly<{
  elementIn: number;
  elementInWebName: string;
  elementOut: number;
  elementOutWebName: string;
  pointsGained: number;
}>;

export type MyFplManagerGameweekReview = Readonly<{
  formation: string;
  lineupBasePoints: number;
  bestElevenPoints: number;
  benchRegretPoints: number | null;
  positionPoints: MyFplManagerPositionPoints;
  captain: MyFplManagerCaptainReview;
  automaticSubstitutions: readonly MyFplManagerAutomaticSubstitution[];
}>;

export type MyFplManagerFormationCount = Readonly<{
  formation: string;
  gameweeks: number;
}>;

export type MyFplManagerChipReview = Readonly<{
  chip: string;
  eventId: number;
  status: MyFplManagerReviewStatus;
  eventNetPoints: number;
  otherGameweeksAverageNetPoints: number | null;
  differenceFromOtherGameweeks: number | null;
  overallRankDelta: number | null;
}>;

export type MyFplManagerSeasonSummary = Readonly<{
  gameweeksReviewed: number;
  provisionalGameweeks: number;
  totalNetPoints: number;
  averageNetPoints: number;
  medianNetPoints: number;
  bestGameweekId: number | null;
  bestNetPoints: number | null;
  worstGameweekId: number | null;
  worstNetPoints: number | null;
  totalHitPoints: number;
  hitGameweeks: number;
  totalBenchPoints: number;
  averageBenchPoints: number;
  zeroBenchGameweeks: number;
  highBenchGameweeks: number;
  totalAutoSubPoints: number;
  autoSubGameweeks: number;
  totalCaptainPoints: number;
  uniqueCaptains: number;
  captainBlankGameweeks: number;
  topCaptainWebName: string | null;
  topCaptainGameweeks: number;
  topCaptainRate: number;
  bestOverallRank: number | null;
  worstOverallRank: number | null;
  overallRankChange: number | null;
  currentImprovementStreak: number;
  longestImprovementStreak: number;
  formations: readonly MyFplManagerFormationCount[];
  positionPoints: MyFplManagerPositionPoints;
  chips: readonly MyFplManagerChipReview[];
}>;

export type MyFplManagerHoldingPeriod = Readonly<{
  element: number;
  webName: string;
  teamShortName: string;
  elementTypeName: string;
  startedEventId: number;
  endedEventId: number | null;
  gameweeksHeld: number;
  starts: number;
  captaincies: number;
  pointsWhileOwned: number;
  scoringContribution: number;
}>;

export type MyFplManagerReview = Readonly<{
  throughEventId: number;
  timeline: readonly MyFplManagerTimelineRow[];
  summary: MyFplManagerSeasonSummary;
  holdings: readonly MyFplManagerHoldingPeriod[];
}>;

const positionKey = (position: string): keyof Omit<MyFplManagerPositionPoints, 'total'> | null => {
  if (position === 'GKP') return 'goalkeeper';
  if (position === 'DEF') return 'defender';
  if (position === 'MID') return 'midfielder';
  if (position === 'FWD') return 'forward';
  return null;
};

type MutablePositionPoints = {
  -readonly [Key in keyof MyFplManagerPositionPoints]: MyFplManagerPositionPoints[Key];
};

const emptyPositionPoints = (): MutablePositionPoints => ({
  goalkeeper: 0,
  defender: 0,
  midfielder: 0,
  forward: 0,
  total: 0,
});

const round = (value: number, digits = 2): number => {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
};

const median = (values: readonly number[]): number => {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? round((ordered[middle - 1]! + ordered[middle]!) / 2)
    : ordered[middle]!;
};

const effectiveLineup = (
  gameweek: MyFplManagerReviewGameweekInput,
): readonly MyFplManagerReviewPickInput[] => {
  if (gameweek.eventChip === 'BENCH_BOOST') {
    return gameweek.picks.filter((pick) => pick.position <= 11);
  }
  const active = gameweek.picks.filter((pick) => pick.multiplier > 0);
  return active.length === 11 ? active : gameweek.picks.filter((pick) => pick.position <= 11);
};

const formation = (gameweek: MyFplManagerReviewGameweekInput): string => {
  const counts = new Map<string, number>();
  for (const pick of effectiveLineup(gameweek)) {
    counts.set(pick.elementTypeName, (counts.get(pick.elementTypeName) ?? 0) + 1);
  }
  return `${counts.get('DEF') ?? 0}-${counts.get('MID') ?? 0}-${counts.get('FWD') ?? 0}`;
};

const bestLegalElevenPoints = (picks: readonly MyFplManagerReviewPickInput[]): number => {
  const pointsByPosition = new Map<string, number[]>();
  for (const pick of picks) {
    const points = pointsByPosition.get(pick.elementTypeName) ?? [];
    points.push(pick.totalPoints);
    pointsByPosition.set(pick.elementTypeName, points);
  }
  for (const points of pointsByPosition.values()) points.sort((left, right) => right - left);

  let best = Number.NEGATIVE_INFINITY;
  for (let defenders = 3; defenders <= 5; defenders += 1) {
    for (let midfielders = 2; midfielders <= 5; midfielders += 1) {
      const forwards = 10 - defenders - midfielders;
      if (forwards < 1 || forwards > 3) continue;
      const goalkeeperPoints = pointsByPosition.get('GKP')?.[0];
      const defenderPoints = pointsByPosition.get('DEF')?.slice(0, defenders) ?? [];
      const midfielderPoints = pointsByPosition.get('MID')?.slice(0, midfielders) ?? [];
      const forwardPoints = pointsByPosition.get('FWD')?.slice(0, forwards) ?? [];
      if (
        goalkeeperPoints === undefined ||
        defenderPoints.length !== defenders ||
        midfielderPoints.length !== midfielders ||
        forwardPoints.length !== forwards
      ) {
        continue;
      }
      best = Math.max(
        best,
        goalkeeperPoints +
          defenderPoints.reduce((sum, value) => sum + value, 0) +
          midfielderPoints.reduce((sum, value) => sum + value, 0) +
          forwardPoints.reduce((sum, value) => sum + value, 0),
      );
    }
  }
  return Number.isFinite(best) ? best : 0;
};

const buildGameweekReview = (
  gameweek: MyFplManagerReviewGameweekInput,
): MyFplManagerGameweekReview => {
  const lineup = effectiveLineup(gameweek);
  const lineupBasePoints = lineup.reduce((sum, pick) => sum + pick.totalPoints, 0);
  const bestElevenPoints = bestLegalElevenPoints(gameweek.picks);
  const positionPoints = emptyPositionPoints();
  for (const pick of gameweek.picks) {
    const key = positionKey(pick.elementTypeName);
    if (!key || pick.multiplier <= 0) continue;
    const contribution = pick.totalPoints * pick.multiplier;
    positionPoints[key] += contribution;
    positionPoints.total += contribution;
  }

  const captain =
    gameweek.picks.find((pick) => pick.element === gameweek.playedCaptainElement) ?? null;
  const viceCaptain = gameweek.picks.find((pick) => pick.isViceCaptain) ?? null;
  const bestSquad = [...gameweek.picks].sort(
    (left, right) => right.totalPoints - left.totalPoints || left.position - right.position,
  )[0];
  const captainBasePoints = captain?.totalPoints ?? 0;
  const captainMultiplier = Math.max(1, captain?.multiplier ?? 1);
  const bestSquadPoints = bestSquad?.totalPoints ?? 0;

  const pickByElement = new Map(gameweek.picks.map((pick) => [pick.element, pick] as const));
  const automaticSubstitutions = gameweek.automaticSubstitutions.map((substitution) => {
    const elementIn = pickByElement.get(substitution.elementIn);
    const elementOut = pickByElement.get(substitution.elementOut);
    return {
      elementIn: substitution.elementIn,
      elementInWebName: elementIn?.webName ?? '',
      elementOut: substitution.elementOut,
      elementOutWebName: elementOut?.webName ?? '',
      pointsGained: elementIn?.totalPoints ?? 0,
    };
  });

  return {
    formation: formation(gameweek),
    lineupBasePoints,
    bestElevenPoints,
    benchRegretPoints:
      gameweek.status === 'PROVISIONAL' || gameweek.eventChip === 'BENCH_BOOST'
        ? null
        : Math.max(0, bestElevenPoints - lineupBasePoints),
    positionPoints,
    captain: {
      captainElement: captain?.element ?? null,
      captainWebName: gameweek.playedCaptainWebName ?? captain?.webName ?? null,
      captainTeamShortName: gameweek.playedCaptainTeamShortName ?? captain?.teamShortName ?? null,
      captainBasePoints,
      captainContribution: gameweek.eventCaptainPoints,
      viceCaptainElement: viceCaptain?.element ?? null,
      viceCaptainWebName: viceCaptain?.webName ?? null,
      viceCaptainBasePoints: viceCaptain?.totalPoints ?? 0,
      bestSquadElement: bestSquad?.element ?? null,
      bestSquadWebName: bestSquad?.webName ?? null,
      bestSquadPoints,
      regretPoints:
        gameweek.status === 'PROVISIONAL'
          ? null
          : Math.max(0, bestSquadPoints - captainBasePoints) * (captainMultiplier - 1),
    },
    automaticSubstitutions,
  };
};

const buildHoldings = (
  gameweeks: readonly MyFplManagerReviewGameweekInput[],
  throughEventId: number,
): readonly MyFplManagerHoldingPeriod[] => {
  type MutableHolding = {
    -readonly [Key in Exclude<
      keyof MyFplManagerHoldingPeriod,
      'endedEventId'
    >]: MyFplManagerHoldingPeriod[Key];
  } & {
    lastEventId: number;
  };
  const completed: MutableHolding[] = [];
  const active = new Map<number, MutableHolding>();

  for (const gameweek of gameweeks) {
    // Free Hit selections are temporary and the pre-deadline squad is restored
    // for the following event. Keep the permanent holding periods continuous,
    // but do not attribute the temporary XI's starts or points to them.
    if (gameweek.eventChip === 'FREE_HIT') {
      for (const holding of active.values()) {
        holding.lastEventId = gameweek.eventId;
        holding.gameweeksHeld += 1;
      }
      continue;
    }
    const selectedElements = new Set(gameweek.picks.map((pick) => pick.element));
    for (const [element, holding] of active) {
      if (!selectedElements.has(element)) {
        completed.push(holding);
        active.delete(element);
      }
    }
    for (const pick of gameweek.picks) {
      const existing = active.get(pick.element);
      const playedCaptain = pick.element === gameweek.playedCaptainElement;
      if (existing && existing.lastEventId === gameweek.eventId - 1) {
        existing.lastEventId = gameweek.eventId;
        existing.gameweeksHeld += 1;
        existing.starts += pick.position <= 11 ? 1 : 0;
        existing.captaincies += playedCaptain ? 1 : 0;
        existing.pointsWhileOwned += pick.totalPoints;
        existing.scoringContribution += pick.totalPoints * pick.multiplier;
        existing.teamShortName = pick.teamShortName;
        continue;
      }
      if (existing) completed.push(existing);
      active.set(pick.element, {
        element: pick.element,
        webName: pick.webName,
        teamShortName: pick.teamShortName,
        elementTypeName: pick.elementTypeName,
        startedEventId: gameweek.eventId,
        lastEventId: gameweek.eventId,
        gameweeksHeld: 1,
        starts: pick.position <= 11 ? 1 : 0,
        captaincies: playedCaptain ? 1 : 0,
        pointsWhileOwned: pick.totalPoints,
        scoringContribution: pick.totalPoints * pick.multiplier,
      });
    }
  }
  completed.push(...active.values());
  return completed
    .map(({ lastEventId, ...holding }) => ({
      ...holding,
      endedEventId: lastEventId === throughEventId ? null : lastEventId,
    }))
    .sort(
      (left, right) =>
        right.gameweeksHeld - left.gameweeksHeld ||
        right.pointsWhileOwned - left.pointsWhileOwned ||
        left.startedEventId - right.startedEventId ||
        left.element - right.element,
    );
};

const buildSummary = (timeline: readonly MyFplManagerTimelineRow[]): MyFplManagerSeasonSummary => {
  const netPoints = timeline.map((row) => row.eventNetPoints);
  const best = [...timeline].sort(
    (left, right) => right.eventNetPoints - left.eventNetPoints || left.eventId - right.eventId,
  )[0];
  const worst = [...timeline].sort(
    (left, right) => left.eventNetPoints - right.eventNetPoints || left.eventId - right.eventId,
  )[0];
  const ranks = timeline.flatMap((row) =>
    row.status === 'FINAL' && row.overallRank !== null ? [row.overallRank] : [],
  );
  const formations = new Map<string, number>();
  const captains = new Map<string, number>();
  const positionPoints = emptyPositionPoints();
  let currentImprovementStreak = 0;
  let longestImprovementStreak = 0;
  for (const row of timeline) {
    formations.set(row.review.formation, (formations.get(row.review.formation) ?? 0) + 1);
    if (row.captainWebName) {
      captains.set(row.captainWebName, (captains.get(row.captainWebName) ?? 0) + 1);
    }
    for (const key of ['goalkeeper', 'defender', 'midfielder', 'forward', 'total'] as const) {
      positionPoints[key] += row.review.positionPoints[key];
    }
    if (row.status !== 'FINAL' || row.overallRankDelta === null) {
      continue;
    }
    if (row.overallRankDelta > 0) {
      currentImprovementStreak += 1;
      longestImprovementStreak = Math.max(longestImprovementStreak, currentImprovementStreak);
    } else {
      currentImprovementStreak = 0;
    }
  }
  const topCaptain = [...captains.entries()].sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  )[0];
  const otherFinalAverageFor = (eventId: number): number | null => {
    const other = timeline.filter((row) => row.status === 'FINAL' && row.eventId !== eventId);
    return other.length === 0
      ? null
      : round(other.reduce((sum, row) => sum + row.eventNetPoints, 0) / other.length);
  };

  return {
    gameweeksReviewed: timeline.length,
    provisionalGameweeks: timeline.filter((row) => row.status === 'PROVISIONAL').length,
    totalNetPoints: netPoints.reduce((sum, value) => sum + value, 0),
    averageNetPoints:
      timeline.length === 0
        ? 0
        : round(netPoints.reduce((sum, value) => sum + value, 0) / timeline.length),
    medianNetPoints: median(netPoints),
    bestGameweekId: best?.eventId ?? null,
    bestNetPoints: best?.eventNetPoints ?? null,
    worstGameweekId: worst?.eventId ?? null,
    worstNetPoints: worst?.eventNetPoints ?? null,
    totalHitPoints: timeline.reduce((sum, row) => sum + row.eventTransfersCost, 0),
    hitGameweeks: timeline.filter((row) => row.eventTransfersCost > 0).length,
    totalBenchPoints: timeline.reduce((sum, row) => sum + row.eventBenchPoints, 0),
    averageBenchPoints:
      timeline.length === 0
        ? 0
        : round(timeline.reduce((sum, row) => sum + row.eventBenchPoints, 0) / timeline.length),
    zeroBenchGameweeks: timeline.filter((row) => row.eventBenchPoints === 0).length,
    highBenchGameweeks: timeline.filter((row) => row.eventBenchPoints >= 10).length,
    totalAutoSubPoints: timeline.reduce((sum, row) => sum + row.eventAutoSubPoints, 0),
    autoSubGameweeks: timeline.filter((row) => row.review.automaticSubstitutions.length > 0).length,
    totalCaptainPoints: timeline.reduce((sum, row) => sum + row.eventCaptainPoints, 0),
    uniqueCaptains: captains.size,
    captainBlankGameweeks: timeline.filter(
      (row) => row.status === 'FINAL' && row.review.captain.captainBasePoints === 0,
    ).length,
    topCaptainWebName: topCaptain?.[0] ?? null,
    topCaptainGameweeks: topCaptain?.[1] ?? 0,
    topCaptainRate:
      timeline.length === 0 || !topCaptain ? 0 : round((topCaptain[1] * 100) / timeline.length, 1),
    bestOverallRank: ranks.length === 0 ? null : Math.min(...ranks),
    worstOverallRank: ranks.length === 0 ? null : Math.max(...ranks),
    overallRankChange: ranks.length < 2 ? null : ranks[0]! - ranks.at(-1)!,
    currentImprovementStreak,
    longestImprovementStreak,
    formations: [...formations.entries()]
      .map(([name, gameweeks]) => ({ formation: name, gameweeks }))
      .sort(
        (left, right) =>
          right.gameweeks - left.gameweeks || left.formation.localeCompare(right.formation),
      ),
    positionPoints,
    chips: timeline
      .filter((row) => row.eventChip !== 'NONE')
      .map((row) => {
        const otherAverage = row.status === 'FINAL' ? otherFinalAverageFor(row.eventId) : null;
        return {
          chip: row.eventChip,
          eventId: row.eventId,
          status: row.status,
          eventNetPoints: row.eventNetPoints,
          otherGameweeksAverageNetPoints: otherAverage,
          differenceFromOtherGameweeks:
            otherAverage === null ? null : round(row.eventNetPoints - otherAverage),
          overallRankDelta: row.overallRankDelta,
        };
      }),
  };
};

export function buildMyFplManagerReview(
  throughEventId: number,
  gameweeks: readonly MyFplManagerReviewGameweekInput[],
): MyFplManagerReview {
  const ordered = [...gameweeks].sort((left, right) => left.eventId - right.eventId);
  const timeline = ordered.map((gameweek, index): MyFplManagerTimelineRow => {
    const previousRank = ordered[index - 1]?.overallRank ?? null;
    return {
      eventId: gameweek.eventId,
      status: gameweek.status,
      eventPoints: gameweek.eventPoints,
      eventRank: gameweek.eventRank,
      overallPoints: gameweek.overallPoints,
      overallRank: gameweek.overallRank,
      overallRankDelta:
        gameweek.status === 'PROVISIONAL' || previousRank === null || gameweek.overallRank === null
          ? null
          : previousRank - gameweek.overallRank,
      eventTransfers: gameweek.eventTransfers,
      eventTransfersCost: gameweek.eventTransfersCost,
      eventNetPoints: gameweek.eventNetPoints,
      eventBenchPoints: gameweek.eventBenchPoints,
      eventAutoSubPoints: gameweek.eventAutoSubPoints,
      eventChip: gameweek.eventChip,
      eventCaptainPoints: gameweek.eventCaptainPoints,
      captainWebName: gameweek.playedCaptainWebName,
      captainTeamShortName: gameweek.playedCaptainTeamShortName,
      teamValue: gameweek.teamValue,
      bank: gameweek.bank,
      review: buildGameweekReview(gameweek),
    };
  });
  return {
    throughEventId,
    timeline,
    summary: buildSummary(timeline),
    holdings: buildHoldings(ordered, throughEventId),
  };
}
