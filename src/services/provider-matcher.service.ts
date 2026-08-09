import { and, eq, sql } from 'drizzle-orm';

import {
  matchesInUnderstat as understatMatches,
  playersInUnderstat as understatPlayers,
  playerMatchStatsInUnderstat as understatPlayerMatchStats,
  playerSeasonsInUnderstat as understatPlayerSeasons,
  teamsInUnderstat as understatTeams,
  teamSeasonsInUnderstat as understatTeamSeasons,
} from '../db/schemas/index.schema';
import { getDb } from '../db/singleton';
import {
  isVerifiedProviderLinkStatus,
  type ProviderEntityLink,
  type ProviderLinkStatus,
} from '../domain/provider-identity';
import { providerIdentityRepository } from '../repositories/provider-identity';
import { fplSeasonDataRepository } from '../repositories/fpl-season-data';

const RULE_VERSION = 'understat-fpl-v1';
const VERIFIED_STATUSES = ['auto_verified', 'manual_verified'] as const;

export function isAutoMappingProtectedStatus(status: ProviderLinkStatus): boolean {
  return isVerifiedProviderLinkStatus(status) || status === 'quarantined' || status === 'rejected';
}

type FplFixturePlayerEvidence = {
  fixtureCode: number;
  playerCode: number;
  teamCode: number;
  elementType: number;
  minutes: number;
  starts: number | null;
  goals: number;
  assists: number;
  ownGoals: number;
  yellowCards: number;
  redCards: number;
  name: string;
  nameAvailable: boolean;
};

type UnderstatRosterEvidence = {
  matchId: number;
  playerId: number;
  teamId: number;
  position: string;
  seasonPosition: string | null;
  minutes: number;
  started: boolean;
  goals: number;
  assists: number;
  ownGoals: number;
  yellowCards: number;
  redCards: number;
  name: string;
};

function fplName(row: {
  firstName: string | null;
  secondName: string | null;
  webName: string | null;
}): string {
  return (
    [row.firstName, row.secondName].filter(Boolean).join(' ').trim() ||
    row.webName ||
    'Unknown FPL player'
  );
}

function understatPositionTypes(position: string, seasonPosition: string | null): Set<number> {
  const source = position === 'Sub' ? (seasonPosition ?? '') : position;
  const result = new Set<number>();
  if (source.includes('GK')) result.add(1);
  if (/(^|\s|,|\/)(D|DC|DL|DR|DM)/.test(source) || /D[CLRMC]/.test(source)) result.add(2);
  if (/(^|\s|,|\/)(M|MC|ML|MR|AM)/.test(source) || /[AD]?M[CLR]?/.test(source)) {
    result.add(3);
  }
  if (/(^|\s|,|\/)(F|FW|ST)/.test(source) || source.includes('FW')) result.add(4);
  return result;
}

export function rosterEvidenceCompatible(
  fpl: FplFixturePlayerEvidence,
  understat: UnderstatRosterEvidence,
  mappedTeamCode: number | undefined,
): boolean {
  return (
    mappedTeamCode === fpl.teamCode &&
    understatPositionTypes(understat.position, understat.seasonPosition).has(fpl.elementType) &&
    (fpl.starts === null || understat.started === fpl.starts > 0) &&
    Math.abs(understat.minutes - fpl.minutes) <= 2 &&
    understat.goals === fpl.goals &&
    understat.ownGoals === fpl.ownGoals &&
    understat.yellowCards === fpl.yellowCards &&
    understat.redCards === fpl.redCards
  );
}

export function resolveUniqueProviderAssignments(
  candidates: ReadonlyMap<number, ReadonlySet<number>>,
): Map<number, number> {
  const remaining = new Map(
    [...candidates].map(([left, right]) => [left, new Set(right)] as const),
  );
  const assignments = new Map<number, number>();
  let changed = true;
  while (changed) {
    changed = false;
    const singletons = [...remaining]
      .filter(([, values]) => values.size === 1)
      .map(([left, values]) => [left, [...values][0]] as const)
      .sort((left, right) => left[0] - right[0]);
    const counts = new Map<number, number>();
    for (const [, right] of singletons) counts.set(right, (counts.get(right) ?? 0) + 1);
    for (const [left, right] of singletons) {
      if ((counts.get(right) ?? 0) !== 1 || !remaining.has(left)) continue;
      assignments.set(left, right);
      remaining.delete(left);
      for (const values of remaining.values()) values.delete(right);
      changed = true;
    }
  }
  return assignments;
}

export function candidatesWithMinimumMatchObservations(
  candidatesByPlayer: ReadonlyMap<number, ReadonlySet<number>>,
  observationsByPair: ReadonlyMap<string, ReadonlySet<number>>,
  minimumObservations = 2,
): Map<number, Set<number>> {
  return new Map(
    [...candidatesByPlayer].map(([playerCode, values]) => [
      playerCode,
      new Set(
        [...values].filter(
          (playerId) =>
            (observationsByPair.get(`${playerCode}:${playerId}`)?.size ?? 0) >= minimumObservations,
        ),
      ),
    ]),
  );
}

export function providerTeamConfirmedForSeason(link: ProviderEntityLink, season: string): boolean {
  const confirmedSeasons = link.evidence.confirmedSeasons;
  return (
    Array.isArray(confirmedSeasons) &&
    confirmedSeasons.every((value) => typeof value === 'string') &&
    confirmedSeasons.includes(season)
  );
}

function verifiedTeamMap(links: ProviderEntityLink[], season: string): Map<number, number> {
  return new Map(
    links
      .filter(
        (link) =>
          link.entityType === 'team' &&
          link.leftProvider === 'understat' &&
          link.rightProvider === 'fpl' &&
          link.leftEntityId !== null &&
          isVerifiedProviderLinkStatus(link.status) &&
          providerTeamConfirmedForSeason(link, season),
      )
      .map((link) => [Number(link.leftEntityId), Number(link.rightEntityId)]),
  );
}

export async function manualVerifyProviderTeam(input: {
  season: string;
  understatTeamId: number;
  fplTeamCode: number;
  reviewedBy: string;
}) {
  const db = await getDb();
  const [understatTeam, fplTeam] = await Promise.all([
    db
      .select({
        id: understatTeams.teamId,
        title: understatTeamSeasons.sourceTitle,
      })
      .from(understatTeamSeasons)
      .innerJoin(understatTeams, eq(understatTeamSeasons.teamId, understatTeams.teamId))
      .where(
        and(
          eq(understatTeamSeasons.seasonCode, input.season),
          eq(understatTeamSeasons.teamId, input.understatTeamId),
        ),
      )
      .limit(1),
    fplSeasonDataRepository.findTeamByCode(input.season, input.fplTeamCode),
  ]);
  if (!understatTeam[0] || !fplTeam) throw new Error('Unknown provider team identity');
  const allTeamLinks = await providerIdentityRepository.findEntityLinks({ entityType: 'team' });
  const verified = allTeamLinks.filter((link) => isVerifiedProviderLinkStatus(link.status));
  const conflict = verified.find(
    (link) =>
      link.leftProvider === 'understat' &&
      link.rightProvider === 'fpl' &&
      ((link.leftEntityId === String(input.understatTeamId) &&
        link.rightEntityId !== String(input.fplTeamCode)) ||
        (link.rightEntityId === String(input.fplTeamCode) &&
          link.leftEntityId !== String(input.understatTeamId))),
  );
  if (conflict) {
    throw new Error(`Provider team mapping conflicts with verified link ${conflict.id}`);
  }
  const existingPair = allTeamLinks.find(
    (link) =>
      link.leftProvider === 'understat' &&
      link.leftEntityId === String(input.understatTeamId) &&
      link.rightProvider === 'fpl' &&
      link.rightEntityId === String(input.fplTeamCode),
  );
  const priorConfirmedSeasons = Array.isArray(existingPair?.evidence.confirmedSeasons)
    ? existingPair.evidence.confirmedSeasons.filter(
        (value): value is string => typeof value === 'string',
      )
    : [];
  const confirmedSeasons = [...new Set([...priorConfirmedSeasons, input.season])].sort();
  const link = await providerIdentityRepository.upsertEntityLink({
    entityType: 'team',
    leftProvider: 'understat',
    leftEntityId: String(input.understatTeamId),
    rightProvider: 'fpl',
    rightEntityId: String(input.fplTeamCode),
    status: 'manual_verified',
    method: 'manual-season-team-confirmation',
    ruleVersion: RULE_VERSION,
    season: input.season,
    reviewedBy: input.reviewedBy,
    evidence: {
      understatTitle: understatTeam[0].title,
      fplName: fplTeam.name,
      fplTeamId: fplTeam.id,
      confirmedSeasons,
    },
  });
  await Promise.all([
    providerIdentityRepository.upsertAlias({
      entityType: 'team',
      provider: 'understat',
      providerEntityId: String(input.understatTeamId),
      alias: understatTeam[0].title,
      source: 'provider-current-name',
    }),
    providerIdentityRepository.upsertAlias({
      entityType: 'team',
      provider: 'fpl',
      providerEntityId: String(input.fplTeamCode),
      alias: fplTeam.name,
      source: 'provider-current-name',
    }),
  ]);
  return link;
}

export async function reconcileProviderMatches(season: string) {
  const db = await getDb();
  const [entityLinks, allExistingLinks, understatRows, fplRows] = await Promise.all([
    providerIdentityRepository.findEntityLinks({
      entityType: 'team',
      statuses: [...VERIFIED_STATUSES],
    }),
    providerIdentityRepository.findMatchLinks({ season }),
    db.select().from(understatMatches).where(eq(understatMatches.seasonCode, season)),
    fplSeasonDataRepository.findFixtures(season),
  ]);
  const existingLinks = allExistingLinks.filter(
    (link) => link.leftProvider === 'understat' && link.rightProvider === 'fpl',
  );
  const teamMap = verifiedTeamMap(entityLinks, season);
  const fplByCode = new Map(fplRows.map((row) => [String(row.fixtureCode), row]));
  let quarantined = 0;
  const protectedLinks = existingLinks.filter((link) => isAutoMappingProtectedStatus(link.status));
  const protectedLeftMatchIds = new Set(protectedLinks.map((link) => link.leftMatchId));
  const protectedRightMatchIds = new Set(protectedLinks.map((link) => link.rightMatchId));
  for (const link of existingLinks.filter((candidate) =>
    isVerifiedProviderLinkStatus(candidate.status),
  )) {
    const understat = understatRows.find((row) => String(row.matchId) === link.leftMatchId);
    const fpl = fplByCode.get(link.rightMatchId);
    if (!understat || !fpl) continue;
    const valid =
      fpl.finished &&
      fpl.kickoffAt &&
      teamMap.get(understat.homeTeamId) === fpl.homeTeamCode &&
      teamMap.get(understat.awayTeamId) === fpl.awayTeamCode &&
      Math.abs(understat.kickoffAt.getTime() - fpl.kickoffAt.getTime()) <= 10 * 60 * 1000 &&
      understat.homeGoals === fpl.homeGoals &&
      understat.awayGoals === fpl.awayGoals;
    if (!valid) {
      await providerIdentityRepository.updateMatchStatus(link.id, 'quarantined');
      quarantined += 1;
    }
  }

  let verified = 0;
  let ambiguous = 0;
  for (const match of understatRows.filter((row) => row.isResult)) {
    if (protectedLeftMatchIds.has(String(match.matchId))) continue;
    const homeTeamCode = teamMap.get(match.homeTeamId);
    const awayTeamCode = teamMap.get(match.awayTeamId);
    if (!homeTeamCode || !awayTeamCode) continue;
    const candidates = fplRows.filter(
      (fixture) =>
        !protectedRightMatchIds.has(String(fixture.fixtureCode)) &&
        fixture.finished &&
        fixture.kickoffAt !== null &&
        fixture.homeTeamCode === homeTeamCode &&
        fixture.awayTeamCode === awayTeamCode &&
        Math.abs(match.kickoffAt.getTime() - fixture.kickoffAt.getTime()) <= 10 * 60 * 1000 &&
        match.homeGoals === fixture.homeGoals &&
        match.awayGoals === fixture.awayGoals,
    );
    const status = candidates.length === 1 ? 'auto_verified' : 'ambiguous';
    for (const candidate of candidates) {
      await providerIdentityRepository.upsertMatchLink({
        season,
        leftProvider: 'understat',
        leftMatchId: String(match.matchId),
        rightProvider: 'fpl',
        rightMatchId: String(candidate.fixtureCode),
        status,
        method: 'verified-teams-kickoff-score',
        ruleVersion: RULE_VERSION,
        evidence: {
          kickoffDifferenceSeconds:
            Math.abs(match.kickoffAt.getTime() - candidate.kickoffAt!.getTime()) / 1000,
          homeTeamCode,
          awayTeamCode,
          score: [match.homeGoals, match.awayGoals],
          candidateCount: candidates.length,
        },
      });
      if (status === 'auto_verified') verified += 1;
      else ambiguous += 1;
    }
  }
  return { verified, ambiguous, quarantined };
}

function intersect(values: Set<number>, candidates: Set<number>): Set<number> {
  return new Set([...values].filter((value) => candidates.has(value)));
}

export async function reconcileProviderPlayers(season: string) {
  const db = await getDb();
  const [entityLinks, matchLinks, fplRows, understatRows, fplPlayers] = await Promise.all([
    providerIdentityRepository.findEntityLinks(),
    providerIdentityRepository.findMatchLinks({ season, statuses: [...VERIFIED_STATUSES] }),
    fplSeasonDataRepository.findPlayerEvidence(season),
    db
      .select({
        matchId: understatPlayerMatchStats.matchId,
        playerId: understatPlayerMatchStats.playerId,
        teamId: understatPlayerMatchStats.teamId,
        position: understatPlayerMatchStats.position,
        seasonPosition: understatPlayerSeasons.position,
        minutes: understatPlayerMatchStats.minutes,
        started: understatPlayerMatchStats.started,
        goals: understatPlayerMatchStats.goals,
        assists: understatPlayerMatchStats.assists,
        ownGoals: understatPlayerMatchStats.ownGoals,
        yellowCards: understatPlayerMatchStats.yellowCards,
        redCards: understatPlayerMatchStats.redCards,
        name: sql<string>`COALESCE(${understatPlayerSeasons.sourceName}, ${understatPlayers.name})`,
      })
      .from(understatPlayerMatchStats)
      .innerJoin(
        understatPlayers,
        eq(understatPlayerMatchStats.playerId, understatPlayers.playerId),
      )
      .innerJoin(understatMatches, eq(understatPlayerMatchStats.matchId, understatMatches.matchId))
      .leftJoin(
        understatPlayerSeasons,
        and(
          eq(understatPlayerSeasons.playerId, understatPlayerMatchStats.playerId),
          eq(understatPlayerSeasons.seasonCode, season),
        ),
      )
      .where(eq(understatMatches.seasonCode, season)),
    fplSeasonDataRepository.findPlayers(season),
  ]);
  const teamMap = verifiedTeamMap(entityLinks, season);
  const matchMap = new Map(
    matchLinks
      .filter((link) => link.leftProvider === 'understat' && link.rightProvider === 'fpl')
      .map((link) => [Number(link.rightMatchId), Number(link.leftMatchId)]),
  );
  const rosterByMatch = new Map<number, UnderstatRosterEvidence[]>();
  for (const row of understatRows) {
    const current = rosterByMatch.get(row.matchId) ?? [];
    current.push(row);
    rosterByMatch.set(row.matchId, current);
  }
  const normalizedFpl: FplFixturePlayerEvidence[] = fplRows.map((row) => ({
    ...row,
    name: fplName(row),
    nameAvailable: Boolean(row.firstName || row.secondName || row.webName),
  }));
  const candidatesByPlayer = new Map<number, Set<number>>();
  const evidenceCount = new Map<number, number>();
  const observationsByPair = new Map<string, Set<number>>();
  for (const fpl of normalizedFpl) {
    const matchId = matchMap.get(fpl.fixtureCode);
    if (!matchId) continue;
    let candidates = new Set(
      (rosterByMatch.get(matchId) ?? [])
        .filter((understat) =>
          rosterEvidenceCompatible(fpl, understat, teamMap.get(understat.teamId)),
        )
        .map((understat) => understat.playerId),
    );
    if (candidates.size > 1) {
      const assistCandidates = new Set(
        (rosterByMatch.get(matchId) ?? [])
          .filter(
            (understat) => candidates.has(understat.playerId) && understat.assists === fpl.assists,
          )
          .map((understat) => understat.playerId),
      );
      if (assistCandidates.size > 0) candidates = assistCandidates;
    }
    const previous = candidatesByPlayer.get(fpl.playerCode);
    candidatesByPlayer.set(fpl.playerCode, previous ? intersect(previous, candidates) : candidates);
    evidenceCount.set(fpl.playerCode, (evidenceCount.get(fpl.playerCode) ?? 0) + 1);
    for (const candidate of candidates) {
      const key = `${fpl.playerCode}:${candidate}`;
      const observedMatches = observationsByPair.get(key) ?? new Set<number>();
      observedMatches.add(matchId);
      observationsByPair.set(key, observedMatches);
    }
  }

  let quarantined = 0;
  const verifiedPlayerLinks = entityLinks.filter(
    (link) =>
      link.entityType === 'player' &&
      link.leftProvider === 'understat' &&
      link.rightProvider === 'fpl' &&
      link.leftEntityId !== null &&
      isVerifiedProviderLinkStatus(link.status),
  );
  for (const link of verifiedPlayerLinks) {
    const playerCode = Number(link.rightEntityId);
    const understatPlayerId = Number(link.leftEntityId);
    const observedCandidates = candidatesByPlayer.get(playerCode);
    if (observedCandidates && !observedCandidates.has(understatPlayerId)) {
      await providerIdentityRepository.updateEntityStatus(link.id, 'quarantined');
      quarantined += 1;
    }
  }

  const protectedPlayerLinks = entityLinks.filter(
    (link) =>
      link.entityType === 'player' &&
      link.leftProvider === 'understat' &&
      link.rightProvider === 'fpl' &&
      link.leftEntityId !== null &&
      isAutoMappingProtectedStatus(link.status),
  );
  const protectedFplPlayers = new Set(
    protectedPlayerLinks.map((link) => Number(link.rightEntityId)),
  );
  const protectedUnderstatPlayers = new Set(
    protectedPlayerLinks
      .filter((link) => link.leftEntityId !== null)
      .map((link) => Number(link.leftEntityId)),
  );
  const unresolved = new Map(
    [...candidatesByPlayer]
      .filter(([playerCode]) => !protectedFplPlayers.has(playerCode))
      .map(([playerCode, values]) => [
        playerCode,
        new Set([...values].filter((playerId) => !protectedUnderstatPlayers.has(playerId))),
      ]),
  );
  const eligibleForAutoVerification = candidatesWithMinimumMatchObservations(
    unresolved,
    observationsByPair,
  );
  const assignments = resolveUniqueProviderAssignments(eligibleForAutoVerification);
  let verified = 0;
  for (const [playerCode, playerId] of assignments) {
    const fpl = normalizedFpl.find((row) => row.playerCode === playerCode);
    const understat = understatRows.find((row) => row.playerId === playerId);
    if (!fpl || !understat) continue;
    await providerIdentityRepository.upsertEntityLink({
      entityType: 'player',
      leftProvider: 'understat',
      leftEntityId: String(playerId),
      rightProvider: 'fpl',
      rightEntityId: String(playerCode),
      status: 'auto_verified',
      method: 'verified-match-roster-bipartite',
      ruleVersion: RULE_VERSION,
      season,
      evidence: {
        understatName: understat.name,
        fplName: fpl.name,
        observedMatches: observationsByPair.get(`${playerCode}:${playerId}`)?.size ?? 0,
        playerEvidenceRows: evidenceCount.get(playerCode) ?? 0,
      },
    });
    await providerIdentityRepository.upsertAlias({
      entityType: 'player',
      provider: 'understat',
      providerEntityId: String(playerId),
      alias: understat.name,
      source: 'provider-current-name',
    });
    if (fpl.nameAvailable) {
      await providerIdentityRepository.upsertAlias({
        entityType: 'player',
        provider: 'fpl',
        providerEntityId: String(playerCode),
        alias: fpl.name,
        source: 'provider-current-name',
      });
    }
    verified += 1;
  }

  let ambiguous = 0;
  let pending = 0;
  for (const [playerCode, values] of unresolved) {
    if (assignments.has(playerCode) || values.size === 0) continue;
    const status = values.size > 1 ? 'ambiguous' : 'pending';
    for (const playerId of values) {
      const fpl = normalizedFpl.find((row) => row.playerCode === playerCode);
      const understat = understatRows.find((row) => row.playerId === playerId);
      if (!fpl || !understat) continue;
      await providerIdentityRepository.upsertEntityLink({
        entityType: 'player',
        leftProvider: 'understat',
        leftEntityId: String(playerId),
        rightProvider: 'fpl',
        rightEntityId: String(playerCode),
        status,
        method: 'verified-match-roster-candidate',
        ruleVersion: RULE_VERSION,
        season,
        evidence: {
          understatName: understat.name,
          fplName: fpl.name,
          candidateCount: values.size,
          observedMatches: observationsByPair.get(`${playerCode}:${playerId}`)?.size ?? 0,
        },
      });
      if (status === 'ambiguous') ambiguous += 1;
      else pending += 1;
    }
  }

  const observedFplCodes = new Set(normalizedFpl.map((row) => row.playerCode));
  const linkedFplCodes = new Set(
    entityLinks
      .filter(
        (link) =>
          link.entityType === 'player' &&
          link.leftProvider === 'understat' &&
          link.rightProvider === 'fpl' &&
          isVerifiedProviderLinkStatus(link.status),
      )
      .map((link) => Number(link.rightEntityId)),
  );
  let notObserved = 0;
  for (const player of fplPlayers) {
    if (observedFplCodes.has(player.playerCode) || linkedFplCodes.has(player.playerCode)) continue;
    notObserved += 1;
  }
  return { verified, ambiguous, pending, quarantined, notObserved };
}

export async function reconcileProviderMappings(season: string) {
  const matches = await reconcileProviderMatches(season);
  const players = await reconcileProviderPlayers(season);
  return { season, matches, players };
}
