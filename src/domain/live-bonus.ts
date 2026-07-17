import { z } from 'zod';

import type { EventId, TeamId } from '../types/base.type';

import type { LiveFixturesByTeam } from './live-fixtures';

/**
 * Live Bonus Cache Data
 *
 * Cache structure: LiveBonus:{season}:{eventId} -> hash of teamId -> {elementId: bonus}
 * Example: LiveBonus:2526:22 -> {"1": "{\"123\":3,\"456\":2,\"789\":1}", "2": "{\"234\":3}"}
 */
export type LiveBonusByTeam = Readonly<Record<string, Record<string, number>>>;

export interface LiveBonusCachePayload {
  readonly eventId: EventId;
  readonly byTeam: LiveBonusByTeam;
}

export const LiveBonusByTeamSchema = z.record(z.record(z.number().int().min(0).max(3)));

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

/**
 * Live bonus match logic (FP-11 / H7).
 *
 * FPL awards bonus per MATCH, not per team: the top 3 BPS players across
 * BOTH teams of a fixture receive 3/2/1 (max 6 points per match, tie
 * handling aside). Awarding a top-3 per team inflated a match to up to 12
 * bonus points. Pairing must also be per fixture so double gameweeks map
 * every opponent, not just the first fixture's.
 */

export interface PlayingMatch {
  readonly teamA: TeamId;
  readonly teamB: TeamId;
  /** Unordered pair + kickoff so two fixtures between the same clubs stay distinct. */
  readonly matchKey: string;
  /** True when the fixture is finished (status Finished or fixture.finished). */
  readonly finished: boolean;
}

/** Minimal event-live shape the bonus calculation needs. */
export interface BonusEligibleLive {
  readonly elementId: number;
  readonly teamId: TeamId;
  readonly minutes: number | null;
  readonly bps: number | null;
  readonly bonus: number | null;
}

/**
 * Build unique matches from the live-fixture cache. Every Playing/Finished
 * fixture contributes one match. Keys are unordered team pair + kickoffTime
 * so (a) DGW teams map every opponent and (b) two fixtures between the same
 * clubs in one event are not collapsed (FP-11 Codex P3).
 */
export function buildPlayingMatches(liveFixtures: LiveFixturesByTeam | null): PlayingMatch[] {
  const matches = new Map<string, PlayingMatch>();

  if (!liveFixtures) {
    return [];
  }

  for (const [teamIdStr, statusMap] of Object.entries(liveFixtures)) {
    const teamId = Number.parseInt(teamIdStr, 10);
    if (Number.isNaN(teamId)) {
      continue;
    }

    const fixtures = [...(statusMap.Playing || []), ...(statusMap.Finished || [])];
    for (const fixture of fixtures) {
      const againstId = fixture.againstId;
      const teamA = Math.min(teamId, againstId);
      const teamB = Math.max(teamId, againstId);
      const key = `${teamA}-${teamB}-${fixture.kickoffTime ?? 'unknown'}`;
      const finished = fixture.finished === true;
      const existing = matches.get(key);
      if (!existing) {
        matches.set(key, { teamA, teamB, matchKey: key, finished });
      } else if (finished && !existing.finished) {
        // Either side of the fixture may report finished; prefer finished=true.
        matches.set(key, { ...existing, finished: true });
      }
    }
  }

  return [...matches.values()];
}

/**
 * Rank a combined match bucket (both teams) by BPS and award 3/2/1.
 * Ties share the tier and consume its slots, matching FPL: two tied at the
 * top both get 3 and the next player gets 1; players tied for second push
 * the 1-point tier out once three or more players already scored.
 */
export function calculateMatchBonus(matchLives: BonusEligibleLive[]): Map<number, number> {
  const bonusMap = new Map<number, number>();
  const ranked = matchLives
    .filter((el) => (el.bps ?? 0) > 0)
    .sort((a, b) => (b.bps ?? 0) - (a.bps ?? 0));

  if (ranked.length === 0) {
    return bonusMap;
  }

  // Award `bonus` to the whole tied tier starting at fromIndex; returns the
  // index of the next distinct BPS tier.
  const award = (bonus: number, fromIndex: number): number => {
    const tierBps = ranked[fromIndex].bps ?? 0;
    let index = fromIndex;
    while (index < ranked.length && (ranked[index].bps ?? 0) === tierBps) {
      bonusMap.set(ranked[index].elementId, bonus);
      index += 1;
    }
    return index;
  };

  let index = award(3, 0);
  if (index >= 3 || index >= ranked.length) {
    return bonusMap;
  }
  if (index === 1) {
    // Exactly one outright leader — the runner-up tier earns 2
    index = award(2, index);
    if (index >= 3 || index >= ranked.length) {
      return bonusMap;
    }
  }
  award(1, index);
  return bonusMap;
}

/**
 * Compute bonus per team for an event.
 *
 * Event-live rows are unique per (event, element) — minutes/bps/bonus are
 * gameweek aggregates, not fixture-scoped. Strategy:
 * 1. Always seed FPL-assigned `bonus` values into the cache first.
 * 2. Single-match buckets with official bonus: skip BPS re-estimation.
 * 3. Multi-match finished fixtures: skip BPS re-estimation (seed only) so
 *    players with official 0 are not given provisional 3/2/1.
 * 4. Multi-match live fixtures: estimate from BPS with keepMax, excluding
 *    players who already have official bonus so a settled fixture's winners
 *    do not dominate provisional ranking for other fixtures. Full fixture-
 *    level BPS would need richer data.
 */
export function computeLiveBonusByTeam(
  matches: PlayingMatch[],
  lives: BonusEligibleLive[],
): Map<TeamId, Map<number, number>> {
  const byTeam = new Map<TeamId, Map<number, number>>();
  const eligible = lives.filter((el) => (el.minutes ?? 0) > 0);

  const livesByTeam = new Map<TeamId, BonusEligibleLive[]>();
  const ownerByElement = new Map<number, TeamId>();
  for (const el of eligible) {
    const list = livesByTeam.get(el.teamId) ?? [];
    list.push(el);
    livesByTeam.set(el.teamId, list);
    ownerByElement.set(el.elementId, el.teamId);
  }

  const matchCountByTeam = new Map<TeamId, number>();
  for (const { teamA, teamB } of matches) {
    matchCountByTeam.set(teamA, (matchCountByTeam.get(teamA) ?? 0) + 1);
    matchCountByTeam.set(teamB, (matchCountByTeam.get(teamB) ?? 0) + 1);
  }

  const setBonus = (teamId: TeamId, elementId: number, bonus: number, keepMax: boolean) => {
    const teamMap = byTeam.get(teamId) ?? new Map<number, number>();
    teamMap.set(elementId, keepMax ? Math.max(teamMap.get(elementId) ?? 0, bonus) : bonus);
    byTeam.set(teamId, teamMap);
  };

  // Seed official FPL bonuses first so multi-match estimation cannot drop them.
  for (const el of eligible) {
    if ((el.bonus ?? 0) > 0) {
      setBonus(el.teamId, el.elementId, el.bonus ?? 0, true);
    }
  }

  for (const { teamA, teamB, finished } of matches) {
    const bucket = [...(livesByTeam.get(teamA) ?? []), ...(livesByTeam.get(teamB) ?? [])];
    if (bucket.length === 0) {
      continue;
    }

    const multiMatchTeam =
      (matchCountByTeam.get(teamA) ?? 0) > 1 || (matchCountByTeam.get(teamB) ?? 0) > 1;
    const hasOfficial = bucket.some((el) => (el.bonus ?? 0) > 0);

    // Settled single-match: official seed is enough.
    if (!multiMatchTeam && hasOfficial) {
      continue;
    }

    // Settled multi-match (DGW finished fixture): seed only — do not re-rank
    // remaining players with provisional 3/2/1 over FPL's official zeros.
    if (multiMatchTeam && finished) {
      continue;
    }

    // Multi-match live: exclude players with official bonus from provisional
    // BPS ranking so aggregate rows from a finished fixture do not displace
    // the live fixture's true contenders (event_lives has no fixture scope).
    const estimationBucket = multiMatchTeam ? bucket.filter((el) => (el.bonus ?? 0) === 0) : bucket;

    for (const [elementId, bonus] of calculateMatchBonus(estimationBucket)) {
      const owner = ownerByElement.get(elementId);
      if (owner !== undefined) {
        setBonus(owner, elementId, bonus, true);
      }
    }
  }

  return byTeam;
}
