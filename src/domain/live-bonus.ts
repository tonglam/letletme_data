import { z } from 'zod';

import type { EventId, TeamId } from '../types/base.type';
import type { Fixture, FixtureStat } from '../types';

export type LiveBonusByTeam = Readonly<Record<string, Record<string, number>>>;

export interface LiveBonusCachePayload {
  readonly eventId: EventId;
  readonly byTeam: LiveBonusByTeam;
}

export const LiveBonusByTeamSchema = z.record(z.record(z.number().int().min(0)));

export const LiveBonusCachePayloadSchema = z.object({
  eventId: z.number().int().positive(),
  byTeam: LiveBonusByTeamSchema,
});

export function validateLiveBonusCachePayload(data: unknown): LiveBonusCachePayload {
  return LiveBonusCachePayloadSchema.parse(data);
}

export function safeValidateLiveBonusCachePayload(data: unknown): LiveBonusCachePayload | null {
  const result = LiveBonusCachePayloadSchema.safeParse(data);
  return result.success ? result.data : null;
}

export function getBonusForElement(
  payload: LiveBonusCachePayload,
  teamId: string,
  elementId: string,
): number {
  return payload.byTeam[teamId]?.[elementId] ?? 0;
}

export function hasAnyBonus(payload: LiveBonusCachePayload): boolean {
  return Object.values(payload.byTeam).some((team) => Object.keys(team).length > 0);
}

type BonusCandidate = {
  readonly elementId: number;
  readonly teamId: TeamId;
  readonly value: number;
};

function statCandidates(
  stat: FixtureStat | undefined,
  fixture: Pick<Fixture, 'teamA' | 'teamH'>,
): BonusCandidate[] {
  if (!stat) return [];
  return [
    ...stat.h.map((item) => ({
      elementId: item.element,
      teamId: fixture.teamH,
      value: item.value,
    })),
    ...stat.a.map((item) => ({
      elementId: item.element,
      teamId: fixture.teamA,
      value: item.value,
    })),
  ];
}

/**
 * Rank one fixture's combined BPS rows and apply FPL's tied 3/2/1 tiers.
 */
export function calculateFixtureBonus(candidates: readonly BonusCandidate[]): Map<number, number> {
  const bonusByElement = new Map<number, number>();
  const ranked = candidates
    .filter((candidate) => candidate.value > 0)
    .sort((left, right) => right.value - left.value);

  if (ranked.length === 0) return bonusByElement;

  const awardTier = (bonus: number, fromIndex: number): number => {
    const tierValue = ranked[fromIndex].value;
    let index = fromIndex;
    while (index < ranked.length && ranked[index].value === tierValue) {
      bonusByElement.set(ranked[index].elementId, bonus);
      index += 1;
    }
    return index;
  };

  let index = awardTier(3, 0);
  if (index >= 3 || index >= ranked.length) return bonusByElement;
  if (index === 1) {
    index = awardTier(2, index);
    if (index >= 3 || index >= ranked.length) return bonusByElement;
  }
  awardTier(1, index);
  return bonusByElement;
}

/**
 * Build the canonical live-bonus contract from fixture-scoped FPL stats.
 *
 * Official `bonus` rows win once present. Before settlement, fixture-level
 * `bps` supplies a provisional estimate. Awards are summed across every
 * fixture in an event, preserving double-gameweek identity.
 */
export function computeFixtureSummedBonusByTeam(
  fixtures: readonly Pick<
    Fixture,
    'finished' | 'finishedProvisional' | 'started' | 'stats' | 'teamA' | 'teamH'
  >[],
): Map<TeamId, Map<number, number>> {
  const byTeam = new Map<TeamId, Map<number, number>>();

  const addBonus = (candidate: BonusCandidate) => {
    if (
      !Number.isInteger(candidate.elementId) ||
      candidate.elementId <= 0 ||
      candidate.value <= 0
    ) {
      return;
    }
    const team = byTeam.get(candidate.teamId) ?? new Map<number, number>();
    team.set(candidate.elementId, (team.get(candidate.elementId) ?? 0) + candidate.value);
    byTeam.set(candidate.teamId, team);
  };

  for (const fixture of fixtures) {
    if (!fixture.started && !fixture.finished && !fixture.finishedProvisional) continue;

    const official = statCandidates(
      fixture.stats.find((stat) => stat.identifier === 'bonus'),
      fixture,
    ).filter((candidate) => candidate.value > 0);

    if (official.length > 0) {
      official.forEach(addBonus);
      continue;
    }

    if (fixture.finished || fixture.finishedProvisional) continue;

    const bps = statCandidates(
      fixture.stats.find((stat) => stat.identifier === 'bps'),
      fixture,
    );
    const teamByElement = new Map(
      bps.map((candidate) => [candidate.elementId, candidate.teamId] as const),
    );
    for (const [elementId, value] of calculateFixtureBonus(bps)) {
      const teamId = teamByElement.get(elementId);
      if (teamId !== undefined) addBonus({ elementId, teamId, value });
    }
  }

  return byTeam;
}
