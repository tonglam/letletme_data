import { and, eq, sql } from 'drizzle-orm';

import {
  entityAliasesInBridge as providerEntityAliases,
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
import { contentHash } from '../utils/content-hash';
import { withMutationScopes } from '../utils/mutation-scopes';

const TEAM_RULE_ID = 'understat-fpl-team-season-confirmation';
const MATCH_RULE_ID = 'understat-fpl-match-kickoff-score';
export const PLAYER_RULE_ID = 'understat-fpl-player-roster-evidence';
export const PLAYER_RECOVERY_RULE_ID = 'understat-fpl-player-roster-recovery-v1';
const VERIFIED_STATUSES = ['auto_verified', 'manual_verified'] as const;
const MIN_PLAYER_MAPPING_OBSERVATIONS = 2;
const TRUSTED_PLAYER_ALIAS_SOURCES = new Set(['manual-season-confirmation']);

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

type FplFixtureOutcomeEvidence = Pick<
  FplFixturePlayerEvidence,
  'teamCode' | 'minutes' | 'starts' | 'goals' | 'ownGoals' | 'yellowCards' | 'redCards'
>;

type UnderstatFixtureOutcomeEvidence = Pick<
  UnderstatRosterEvidence,
  'teamId' | 'minutes' | 'started' | 'goals' | 'ownGoals' | 'yellowCards' | 'redCards'
>;

export type ProviderPlayerNameAliases = Readonly<{
  fpl: readonly string[];
  understat: readonly string[];
}>;

export type UnderstatPlayerMappingRecoveryDisposition =
  | 'recoverable'
  | 'identity_conflict'
  | 'insufficient_evidence'
  | 'manual_review';

export type UnderstatPlayerMappingRecoveryItem = Readonly<{
  linkId: string;
  understatPlayerId: number | null;
  fplPlayerCode: number;
  understatName: string | null;
  fplName: string | null;
  originalStatus: ProviderLinkStatus;
  sourceEvidenceHash: string;
  evidenceHash: string;
  priorConfirmedSeasons: readonly string[];
  observedMatchIds: readonly number[];
  fixtureCodes: readonly number[];
  disposition: UnderstatPlayerMappingRecoveryDisposition;
  reasonCodes: readonly string[];
}>;

export type UnderstatPlayerMappingRecoveryReport = Readonly<{
  season: string;
  generatedAt: string;
  items: readonly UnderstatPlayerMappingRecoveryItem[];
  summary: Readonly<Record<UnderstatPlayerMappingRecoveryDisposition, number>>;
}>;

export type UnderstatPlayerMappingRecoveryApproval = Readonly<{
  linkId: string;
  understatPlayerId: number;
  fplPlayerCode: number;
  evidenceHash: string;
}>;

export type UnderstatPlayerMappingRecoveryApplyResult = Readonly<{
  season: string;
  applied: readonly string[];
  skipped: readonly Readonly<{ linkId: string; reason: string }>[];
}>;

/** Ignore a completed-match roster row only when it proves no participation. */
export function hasUnderstatFixtureParticipation(
  row: Pick<
    UnderstatRosterEvidence,
    'minutes' | 'started' | 'goals' | 'assists' | 'ownGoals' | 'yellowCards' | 'redCards'
  >,
): boolean {
  return (
    row.minutes > 0 ||
    row.started ||
    row.goals !== 0 ||
    row.assists !== 0 ||
    row.ownGoals !== 0 ||
    row.yellowCards !== 0 ||
    row.redCards !== 0
  );
}

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

function fplHasFullName(row: { firstName: string | null; secondName: string | null }): boolean {
  return Boolean(row.firstName?.trim() && row.secondName?.trim());
}

const PROVIDER_HTML_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  apos: String.fromCodePoint(39),
  gt: '>',
  lt: '<',
  nbsp: ' ',
  quot: '"',
  rdquo: '”',
  ldquo: '“',
  rsquo: '’',
  lsquo: '‘',
};

const PROVIDER_COMPATIBILITY_LETTERS: Readonly<Record<string, string>> = {
  Æ: 'AE',
  æ: 'ae',
  Ð: 'D',
  ð: 'd',
  Đ: 'D',
  đ: 'd',
  Ł: 'L',
  ł: 'l',
  Ø: 'O',
  ø: 'o',
  Þ: 'TH',
  þ: 'th',
  ß: 'ss',
  Ħ: 'H',
  ħ: 'h',
  Ŀ: 'L',
  ŀ: 'l',
  ı: 'i',
  Ŧ: 'T',
  ŧ: 't',
  Œ: 'OE',
  œ: 'oe',
};

function decodeProviderHtmlEntities(value: string): string {
  return value.replace(
    /&(?:#(\d+)|#x([\da-f]+)|([a-z][a-z\d]+));/giu,
    (entity, decimal, hexadecimal, named) => {
      if (decimal !== undefined || hexadecimal !== undefined) {
        const codePoint = Number.parseInt(decimal ?? hexadecimal, decimal ? 10 : 16);
        if (Number.isSafeInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff) {
          try {
            return String.fromCodePoint(codePoint);
          } catch {
            return entity;
          }
        }
        return entity;
      }
      return PROVIDER_HTML_ENTITIES[named.toLowerCase()] ?? entity;
    },
  );
}

/**
 * Normalize provider names for deterministic identity comparisons. This is
 * deliberately conservative: it removes presentation differences while
 * refusing fuzzy, surname-only, or substring matches.
 */
export function normalizeProviderPlayerName(value: string): string {
  return decodeProviderHtmlEntities(value)
    .replace(
      /[ÆæÐðĐđŁłØøÞþßĦħĿŀıŦŧŒœ]/gu,
      (letter) => PROVIDER_COMPATIBILITY_LETTERS[letter] ?? letter,
    )
    .normalize('NFKD')
    .replace(/\p{Mark}/gu, '')
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizedNames(values: readonly string[]): Set<string> {
  return new Set(values.map(normalizeProviderPlayerName).filter(Boolean));
}

function hasProviderFullName(value: string): boolean {
  return normalizeProviderPlayerName(value).split(' ').filter(Boolean).length >= 2;
}

/** Match full names or a manually confirmed provider alias exactly. */
export function providerPlayerNamesMatch(
  fplNameValue: string,
  understatNameValue: string,
  aliases: ProviderPlayerNameAliases = { fpl: [], understat: [] },
): boolean {
  const fplNames = normalizedNames([fplNameValue, ...aliases.fpl]);
  const understatNames = normalizedNames([understatNameValue, ...aliases.understat]);
  return [...fplNames].some((name) => understatNames.has(name));
}

export function rosterEvidenceAligns(
  fpl: FplFixturePlayerEvidence,
  understat: UnderstatRosterEvidence,
  mappedTeamCode: number | undefined,
  aliases: ProviderPlayerNameAliases = { fpl: [], understat: [] },
): boolean {
  const trustedAliasNames = normalizedNames([...aliases.fpl, ...aliases.understat]);
  return (
    fixtureOutcomeEvidenceAligns(fpl, understat, mappedTeamCode) &&
    ((fpl.nameAvailable && hasProviderFullName(fpl.name)) || trustedAliasNames.size > 0) &&
    providerPlayerNamesMatch(fpl.name, understat.name, aliases)
  );
}

/**
 * Compare only the fixture relationship needed for identity evidence. The
 * providers own their statistical interpretations; differences in minutes,
 * starts, position, goals, assists, or cards must never quarantine an
 * otherwise supported identity.
 */
export function fixtureOutcomeEvidenceAligns(
  fpl: FplFixtureOutcomeEvidence,
  understat: UnderstatFixtureOutcomeEvidence,
  mappedTeamCode: number | undefined,
): boolean {
  return mappedTeamCode === fpl.teamCode;
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

export function verifiedPlayerMappingConflict(
  links: readonly ProviderEntityLink[],
  understatPlayerId: number,
  fplPlayerCode: number,
): ProviderEntityLink | undefined {
  const leftId = String(understatPlayerId);
  const rightId = String(fplPlayerCode);
  return links.find(
    (link) =>
      link.entityType === 'player' &&
      link.leftProvider === 'understat' &&
      link.rightProvider === 'fpl' &&
      ((link.leftEntityId === leftId && link.rightEntityId !== rightId) ||
        (link.rightEntityId === rightId && link.leftEntityId !== leftId)),
  );
}

export function understatMinutesMatchEvidence(
  seasonMinutes: number,
  fixtureMinutes: readonly number[],
): boolean {
  return fixtureMinutes.reduce((total, minutes) => total + minutes, 0) === seasonMinutes;
}

function confirmedPlayerSeasons(link: ProviderEntityLink | undefined, season: string): string[] {
  const prior = Array.isArray(link?.evidence.confirmedSeasons)
    ? link.evidence.confirmedSeasons.filter(
        (value): value is string => typeof value === 'string' && /^\d{4}$/.test(value),
      )
    : [];
  return [...new Set([...prior, season])].sort();
}

export function shouldConfirmProviderPlayerSeason(
  link: Pick<ProviderEntityLink, 'status' | 'evidence'>,
  season: string,
  observedMatches: number,
): boolean {
  const confirmedSeasons = link.evidence.confirmedSeasons;
  return (
    isVerifiedProviderLinkStatus(link.status) &&
    observedMatches > 0 &&
    !(Array.isArray(confirmedSeasons) && confirmedSeasons.includes(season))
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
    ruleId: TEAM_RULE_ID,
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

/**
 * Confirm one exact provider-player mapping from a reviewer-approved season.
 * This is intentionally separate from the automatic reconcile pass: a manual
 * confirmation must prove the selected season, team, verified match links,
 * and complete-match roster evidence before it can change a quarantined
 * candidate. Provider statistics remain source-specific and are not compared.
 */
export async function manualVerifyProviderPlayer(input: {
  season: string;
  understatPlayerId: number;
  fplPlayerCode: number;
  reviewedBy: string;
}) {
  const db = await getDb();
  const [
    understatSeason,
    fplPlayer,
    understatEvidence,
    understatRosterEvidence,
    fplEvidence,
    fplFixtures,
    entityLinks,
    matchLinks,
  ] = await Promise.all([
    db
      .select({
        playerId: understatPlayerSeasons.playerId,
        sourceName: understatPlayerSeasons.sourceName,
        sourceTeamTitle: understatPlayerSeasons.sourceTeamTitle,
        timeMinutes: understatPlayerSeasons.timeMinutes,
        position: understatPlayerSeasons.position,
      })
      .from(understatPlayerSeasons)
      .where(
        and(
          eq(understatPlayerSeasons.seasonCode, input.season),
          eq(understatPlayerSeasons.playerId, input.understatPlayerId),
        ),
      )
      .limit(1),
    fplSeasonDataRepository
      .findPlayers(input.season)
      .then((players) => players.find((player) => player.playerCode === input.fplPlayerCode)),
    db
      .select({
        matchId: understatPlayerMatchStats.matchId,
        teamId: understatPlayerMatchStats.teamId,
        minutes: understatPlayerMatchStats.minutes,
        started: understatPlayerMatchStats.started,
        goals: understatPlayerMatchStats.goals,
        assists: understatPlayerMatchStats.assists,
        ownGoals: understatPlayerMatchStats.ownGoals,
        yellowCards: understatPlayerMatchStats.yellowCards,
        redCards: understatPlayerMatchStats.redCards,
      })
      .from(understatPlayerMatchStats)
      .innerJoin(understatMatches, eq(understatPlayerMatchStats.matchId, understatMatches.matchId))
      .where(
        and(
          eq(understatPlayerMatchStats.playerId, input.understatPlayerId),
          eq(understatMatches.seasonCode, input.season),
          eq(understatMatches.isResult, true),
        ),
      ),
    db
      .select({
        matchId: understatPlayerMatchStats.matchId,
        teamId: understatPlayerMatchStats.teamId,
        started: understatPlayerMatchStats.started,
        minutes: understatPlayerMatchStats.minutes,
        goals: understatPlayerMatchStats.goals,
        assists: understatPlayerMatchStats.assists,
        ownGoals: understatPlayerMatchStats.ownGoals,
        yellowCards: understatPlayerMatchStats.yellowCards,
        redCards: understatPlayerMatchStats.redCards,
      })
      .from(understatPlayerMatchStats)
      .innerJoin(understatMatches, eq(understatPlayerMatchStats.matchId, understatMatches.matchId))
      .where(
        and(eq(understatMatches.seasonCode, input.season), eq(understatMatches.isResult, true)),
      ),
    fplSeasonDataRepository.findPlayerEvidence(input.season),
    fplSeasonDataRepository.findFixtures(input.season),
    providerIdentityRepository.findEntityLinks(),
    providerIdentityRepository.findMatchLinks({
      season: input.season,
      statuses: [...VERIFIED_STATUSES],
    }),
  ]);

  const understatPlayer = understatSeason[0];
  if (!understatPlayer || understatPlayer.playerId !== input.understatPlayerId) {
    throw new Error('Unknown Understat player in the selected season');
  }
  if (!fplPlayer) throw new Error('Unknown FPL player in the selected season');
  if (!Number.isInteger(understatPlayer.timeMinutes) || understatPlayer.timeMinutes < 0) {
    throw new Error('Understat player minutes evidence is invalid');
  }
  const participatingUnderstatEvidence = understatEvidence.filter(hasUnderstatFixtureParticipation);
  if (participatingUnderstatEvidence.length === 0) {
    throw new Error('No completed Understat match evidence exists for the selected player');
  }
  if (
    !understatMinutesMatchEvidence(
      understatPlayer.timeMinutes,
      participatingUnderstatEvidence.map((row) => row.minutes),
    )
  ) {
    throw new Error('Understat player minutes do not match fixture evidence');
  }
  const rosterByMatch = new Map<number, typeof understatRosterEvidence>();
  for (const row of understatRosterEvidence) {
    const current = rosterByMatch.get(row.matchId) ?? [];
    current.push(row);
    rosterByMatch.set(row.matchId, current);
  }
  for (const row of participatingUnderstatEvidence) {
    const roster = rosterByMatch.get(row.matchId) ?? [];
    if (!hasCompleteRosterEvidence(roster)) {
      throw new Error(`Understat match ${row.matchId} does not have a complete roster`);
    }
  }

  const verifiedEntityLinks = entityLinks.filter((link) =>
    isVerifiedProviderLinkStatus(link.status),
  );
  const conflict = verifiedPlayerMappingConflict(
    verifiedEntityLinks,
    input.understatPlayerId,
    input.fplPlayerCode,
  );
  if (conflict)
    throw new Error(`Provider player mapping conflicts with verified link ${conflict.id}`);

  const verifiedTeamMap = new Map(
    verifiedEntityLinks
      .filter(
        (link) =>
          link.entityType === 'team' &&
          link.leftProvider === 'understat' &&
          link.rightProvider === 'fpl' &&
          link.leftEntityId !== null &&
          providerTeamConfirmedForSeason(link, input.season),
      )
      .map((link) => [Number(link.leftEntityId), Number(link.rightEntityId)]),
  );
  const verifiedMatchByUnderstatId = new Map(
    matchLinks
      .filter(
        (link) =>
          link.leftProvider === 'understat' && link.rightProvider === 'fpl' && link.leftMatchId,
      )
      .map((link) => [Number(link.leftMatchId), Number(link.rightMatchId)]),
  );
  const completedFixtureCodes = new Set(
    fplFixtures.filter((fixture) => fixture.finished).map((fixture) => fixture.fixtureCode),
  );
  const fplRowsByFixture = new Map(
    fplEvidence
      .filter(
        (row) =>
          row.playerCode === input.fplPlayerCode && completedFixtureCodes.has(row.fixtureCode),
      )
      .map((row) => [row.fixtureCode, row]),
  );
  const evidence = participatingUnderstatEvidence.map((row) => {
    const fixtureCode = verifiedMatchByUnderstatId.get(row.matchId);
    const fplRow = fixtureCode === undefined ? undefined : fplRowsByFixture.get(fixtureCode);
    const mappedTeamCode = verifiedTeamMap.get(row.teamId);
    if (
      fixtureCode === undefined ||
      !fplRow ||
      !fixtureOutcomeEvidenceAligns(fplRow, row, mappedTeamCode)
    ) {
      throw new Error(`Match/fixture evidence does not support player ${input.understatPlayerId}`);
    }
    return {
      matchId: row.matchId,
      fixtureCode,
      understatTeamId: row.teamId,
      fplTeamCode: mappedTeamCode,
      minutes: row.minutes,
      goals: row.goals,
      assists: row.assists,
      ownGoals: row.ownGoals,
      yellowCards: row.yellowCards,
      redCards: row.redCards,
    };
  });

  const existingPair = entityLinks.find(
    (link) =>
      link.entityType === 'player' &&
      link.leftProvider === 'understat' &&
      link.leftEntityId === String(input.understatPlayerId) &&
      link.rightProvider === 'fpl' &&
      link.rightEntityId === String(input.fplPlayerCode),
  );
  const link = await providerIdentityRepository.upsertEntityLink({
    entityType: 'player',
    leftProvider: 'understat',
    leftEntityId: String(input.understatPlayerId),
    rightProvider: 'fpl',
    rightEntityId: String(input.fplPlayerCode),
    status: 'manual_verified',
    method: 'manual-season-player-confirmation',
    ruleId: PLAYER_RULE_ID,
    season: input.season,
    reviewedBy: input.reviewedBy,
    evidence: {
      understatName: understatPlayer.sourceName,
      understatTeamTitle: understatPlayer.sourceTeamTitle,
      understatPosition: understatPlayer.position,
      understatMinutes: understatPlayer.timeMinutes,
      fplName: fplName(fplPlayer),
      fixtureEvidence: evidence,
      confirmedSeasons: confirmedPlayerSeasons(existingPair, input.season),
      reviewedBy: input.reviewedBy,
    },
  });
  await Promise.all([
    providerIdentityRepository.upsertAlias({
      entityType: 'player',
      provider: 'understat',
      providerEntityId: String(input.understatPlayerId),
      alias: understatPlayer.sourceName,
      source: 'manual-season-confirmation',
    }),
    providerIdentityRepository.upsertAlias({
      entityType: 'player',
      provider: 'fpl',
      providerEntityId: String(input.fplPlayerCode),
      alias: fplName(fplPlayer),
      source: 'manual-season-confirmation',
    }),
  ]);
  return { link, evidenceCount: evidence.length };
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
        ruleId: MATCH_RULE_ID,
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

export function hasCompleteRosterEvidence(
  rows: readonly Pick<UnderstatRosterEvidence, 'teamId' | 'started'>[],
): boolean {
  const startsByTeam = new Map<number, number>();
  const startedPlayerIdsByTeam = new Map<number, Set<number>>();
  const startedPlayerIds = new Set<number>();
  let playerIdsAvailable = true;
  for (const row of rows) {
    if (!row.started) continue;
    startsByTeam.set(row.teamId, (startsByTeam.get(row.teamId) ?? 0) + 1);
    const playerId = (row as Partial<Pick<UnderstatRosterEvidence, 'playerId'>>).playerId;
    if (typeof playerId !== 'number' || !Number.isSafeInteger(playerId)) {
      playerIdsAvailable = false;
      continue;
    }
    const teamPlayerIds = startedPlayerIdsByTeam.get(row.teamId) ?? new Set<number>();
    teamPlayerIds.add(playerId);
    startedPlayerIdsByTeam.set(row.teamId, teamPlayerIds);
    startedPlayerIds.add(playerId);
  }
  if (startsByTeam.size !== 2 || ![...startsByTeam.values()].every((count) => count === 11)) {
    return false;
  }
  const knownStartedPlayerCount = [...startedPlayerIdsByTeam.values()].reduce(
    (total, playerIds) => total + playerIds.size,
    0,
  );
  if (startedPlayerIds.size !== knownStartedPlayerCount) return false;
  if (!playerIdsAvailable) return true;
  return (
    [...startedPlayerIdsByTeam.entries()].every(
      ([teamId, playerIds]) => playerIds.size === startsByTeam.get(teamId),
    ) &&
    startedPlayerIds.size ===
      [...startedPlayerIdsByTeam.values()].reduce((total, playerIds) => total + playerIds.size, 0)
  );
}

type ProviderPlayerAliasRow = Readonly<{
  entityType: string;
  provider: string;
  providerEntityId: string;
  alias: string;
  source: string;
}>;

type ProviderPlayerEvidenceSnapshot = Readonly<{
  entityLinks: ProviderEntityLink[];
  fplRows: FplFixturePlayerEvidence[];
  understatRows: UnderstatRosterEvidence[];
  fplPlayers: Awaited<ReturnType<typeof fplSeasonDataRepository.findPlayers>>;
  fplByCode: Map<number, FplFixturePlayerEvidence>;
  understatById: Map<number, UnderstatRosterEvidence>;
  candidatesByPlayer: Map<number, Set<number>>;
  evidenceCount: Map<number, number>;
  observationsByPair: Map<string, Set<number>>;
  fixtureCodesByPair: Map<string, Set<number>>;
  multipleCandidatesByPlayer: Set<number>;
}>;

function aliasKey(provider: string, providerEntityId: string): string {
  return `${provider}:${providerEntityId}`;
}

function trustedPlayerAliasIndex(rows: readonly ProviderPlayerAliasRow[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const row of rows) {
    if (!TRUSTED_PLAYER_ALIAS_SOURCES.has(row.source)) continue;
    const key = aliasKey(row.provider, row.providerEntityId);
    const aliases = result.get(key) ?? [];
    aliases.push(row.alias);
    result.set(key, aliases);
  }
  return result;
}

async function collectProviderPlayerEvidence(
  season: string,
): Promise<ProviderPlayerEvidenceSnapshot> {
  const db = await getDb();
  const [entityLinks, matchLinks, fplRows, understatRows, fplPlayers, fplFixtures, aliasRows] =
    await Promise.all([
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
        .innerJoin(
          understatMatches,
          eq(understatPlayerMatchStats.matchId, understatMatches.matchId),
        )
        .leftJoin(
          understatPlayerSeasons,
          and(
            eq(understatPlayerSeasons.playerId, understatPlayerMatchStats.playerId),
            eq(understatPlayerSeasons.seasonCode, season),
          ),
        )
        .where(and(eq(understatMatches.seasonCode, season), eq(understatMatches.isResult, true))),
      fplSeasonDataRepository.findPlayers(season),
      fplSeasonDataRepository.findFixtures(season),
      db
        .select({
          entityType: providerEntityAliases.entityType,
          provider: providerEntityAliases.provider,
          providerEntityId: providerEntityAliases.providerEntityId,
          alias: providerEntityAliases.alias,
          source: providerEntityAliases.source,
        })
        .from(providerEntityAliases)
        .where(eq(providerEntityAliases.entityType, 'player')),
    ]);
  const teamMap = verifiedTeamMap(entityLinks, season);
  const verifiedPlayerPairsByFpl = new Map<number, Set<number>>();
  for (const link of entityLinks) {
    if (
      link.entityType !== 'player' ||
      link.leftProvider !== 'understat' ||
      link.rightProvider !== 'fpl' ||
      link.leftEntityId === null ||
      !isVerifiedProviderLinkStatus(link.status)
    ) {
      continue;
    }
    const fplPlayerCode = Number(link.rightEntityId);
    const understatPlayerId = Number(link.leftEntityId);
    if (!Number.isSafeInteger(fplPlayerCode) || !Number.isSafeInteger(understatPlayerId)) continue;
    const pairs = verifiedPlayerPairsByFpl.get(fplPlayerCode) ?? new Set<number>();
    pairs.add(understatPlayerId);
    verifiedPlayerPairsByFpl.set(fplPlayerCode, pairs);
  }
  const matchMap = new Map(
    matchLinks
      .filter((link) => link.leftProvider === 'understat' && link.rightProvider === 'fpl')
      .map((link) => [Number(link.rightMatchId), Number(link.leftMatchId)]),
  );
  const aliases = trustedPlayerAliasIndex(aliasRows);
  const rosterByMatch = new Map<number, UnderstatRosterEvidence[]>();
  for (const row of understatRows) {
    const current = rosterByMatch.get(row.matchId) ?? [];
    current.push(row);
    rosterByMatch.set(row.matchId, current);
  }
  const completedFixtureCodes = new Set(
    fplFixtures.filter((fixture) => fixture.finished).map((fixture) => fixture.fixtureCode),
  );
  const normalizedFpl: FplFixturePlayerEvidence[] = fplRows
    .filter((row) => completedFixtureCodes.has(row.fixtureCode))
    .map((row) => ({
      ...row,
      name: fplName(row),
      nameAvailable: fplHasFullName(row),
    }));
  const fplByCode = new Map<number, FplFixturePlayerEvidence>();
  for (const row of normalizedFpl) fplByCode.set(row.playerCode, row);
  const understatById = new Map<number, UnderstatRosterEvidence>();
  for (const row of understatRows) understatById.set(row.playerId, row);
  const candidatesByPlayer = new Map<number, Set<number>>();
  const evidenceCount = new Map<number, number>();
  const observationsByPair = new Map<string, Set<number>>();
  const fixtureCodesByPair = new Map<string, Set<number>>();
  const multipleCandidatesByPlayer = new Set<number>();
  for (const fpl of normalizedFpl) {
    const matchId = matchMap.get(fpl.fixtureCode);
    if (matchId === undefined) continue;
    const roster = rosterByMatch.get(matchId);
    if (!roster || !hasCompleteRosterEvidence(roster)) continue;
    // An existing verified ID pair is durable identity evidence. Once the
    // mapped teams and complete result match are known, record the observation
    // even when provider names or statistics differ. New pairs still use the
    // strict name/alias candidate path below.
    for (const understatPlayerId of verifiedPlayerPairsByFpl.get(fpl.playerCode) ?? []) {
      const understat = roster.find((row) => row.playerId === understatPlayerId);
      if (
        !understat ||
        !fixtureOutcomeEvidenceAligns(fpl, understat, teamMap.get(understat.teamId))
      ) {
        continue;
      }
      const key = `${fpl.playerCode}:${understatPlayerId}`;
      const observedMatches = observationsByPair.get(key) ?? new Set<number>();
      observedMatches.add(matchId);
      observationsByPair.set(key, observedMatches);
      const fixtureCodes = fixtureCodesByPair.get(key) ?? new Set<number>();
      fixtureCodes.add(fpl.fixtureCode);
      fixtureCodesByPair.set(key, fixtureCodes);
    }
    const candidates = new Set(
      roster
        .filter((understat) =>
          rosterEvidenceAligns(fpl, understat, teamMap.get(understat.teamId), {
            fpl: aliases.get(aliasKey('fpl', String(fpl.playerCode))) ?? [],
            understat: aliases.get(aliasKey('understat', String(understat.playerId))) ?? [],
          }),
        )
        .map((understat) => understat.playerId),
    );
    if (candidates.size > 1) multipleCandidatesByPlayer.add(fpl.playerCode);
    // A complete match can legitimately omit a player who was not in the
    // provider roster. Preserve evidence from other complete matches instead
    // of turning one missing observation into an identity contradiction.
    if (candidates.size === 0) continue;
    const previous = candidatesByPlayer.get(fpl.playerCode);
    candidatesByPlayer.set(fpl.playerCode, previous ? intersect(previous, candidates) : candidates);
    evidenceCount.set(fpl.playerCode, (evidenceCount.get(fpl.playerCode) ?? 0) + 1);
    for (const candidate of candidates) {
      const key = `${fpl.playerCode}:${candidate}`;
      const observedMatches = observationsByPair.get(key) ?? new Set<number>();
      observedMatches.add(matchId);
      observationsByPair.set(key, observedMatches);
      const fixtureCodes = fixtureCodesByPair.get(key) ?? new Set<number>();
      fixtureCodes.add(fpl.fixtureCode);
      fixtureCodesByPair.set(key, fixtureCodes);
    }
  }
  return {
    entityLinks,
    fplRows: normalizedFpl,
    understatRows,
    fplPlayers,
    fplByCode,
    understatById,
    candidatesByPlayer,
    evidenceCount,
    observationsByPair,
    fixtureCodesByPair,
    multipleCandidatesByPlayer,
  };
}

function linkCoversSeason(link: ProviderEntityLink, season: string): boolean {
  return (
    (!link.firstSeenSeason || link.firstSeenSeason <= season) &&
    (!link.lastSeenSeason || link.lastSeenSeason >= season)
  );
}

function quarantinedPlayerLinkHasSeasonEvidence(
  link: ProviderEntityLink,
  season: string,
  snapshot: ProviderPlayerEvidenceSnapshot,
): boolean {
  if (linkCoversSeason(link, season)) return true;
  const understatPlayerId = Number(link.leftEntityId);
  const fplPlayerCode = Number(link.rightEntityId);
  if (
    !Number.isSafeInteger(understatPlayerId) ||
    !Number.isSafeInteger(fplPlayerCode) ||
    understatPlayerId <= 0 ||
    fplPlayerCode <= 0
  ) {
    return false;
  }
  // Old reconciliation updated status without advancing last_seen_season.
  // Current-season provider rows are the durable evidence that the pair was
  // actually encountered during this audit, so do not hide those links from
  // recovery merely because their historical range is stale.
  return (
    snapshot.understatRows.some((row) => row.playerId === understatPlayerId) &&
    (snapshot.fplRows.some((row) => row.playerCode === fplPlayerCode) ||
      snapshot.fplPlayers.some((row) => row.playerCode === fplPlayerCode))
  );
}

function priorConfirmedSeasons(
  link: Pick<ProviderEntityLink, 'evidence'>,
  season: string,
): string[] {
  const confirmed = Array.isArray(link.evidence.confirmedSeasons)
    ? link.evidence.confirmedSeasons.filter(
        (value): value is string =>
          typeof value === 'string' && /^\d{4}$/.test(value) && value !== season,
      )
    : [];
  return [...new Set(confirmed)].sort();
}

function hasExplicitManualReview(
  link: Pick<ProviderEntityLink, 'reviewedBy' | 'method' | 'evidence'>,
): boolean {
  return (
    link.reviewedBy !== null ||
    link.method.startsWith('manual-') ||
    link.evidence.manualReview === true
  );
}

export function classifyQuarantinedProviderPlayerMapping(input: {
  link: Pick<ProviderEntityLink, 'reviewedBy' | 'method' | 'evidence'>;
  season: string;
  understatPlayerId: number | null;
  fplPlayerCode: number;
  observedCandidates: ReadonlySet<number> | undefined;
  observedMatchIds: readonly number[];
  hasVerifiedConflict: boolean;
  hasAmbiguousObservation?: boolean;
}): Pick<UnderstatPlayerMappingRecoveryItem, 'disposition' | 'reasonCodes'> {
  if (hasExplicitManualReview(input.link)) {
    return { disposition: 'manual_review', reasonCodes: ['MANUAL_REVIEW_REQUIRED'] };
  }
  if (input.hasVerifiedConflict) {
    return { disposition: 'identity_conflict', reasonCodes: ['VERIFIED_IDENTITY_CONFLICT'] };
  }
  const reasonCodes: string[] = [];
  if (input.understatPlayerId === null) reasonCodes.push('UNDERSTAT_ID_INVALID');
  if (!input.observedCandidates?.has(input.understatPlayerId ?? -1)) {
    reasonCodes.push('NAME_OR_TEAM_EVIDENCE_MISSING');
  } else if (input.observedCandidates.size !== 1 || input.hasAmbiguousObservation) {
    reasonCodes.push('MULTIPLE_IDENTITY_CANDIDATES');
  }
  if (input.observedMatchIds.length < MIN_PLAYER_MAPPING_OBSERVATIONS) {
    reasonCodes.push('OBSERVED_MATCHES_BELOW_MINIMUM');
  }
  if (priorConfirmedSeasons(input.link, input.season).length === 0) {
    reasonCodes.push('NO_PRIOR_CONFIRMED_SEASON');
  }
  return reasonCodes.length === 0
    ? { disposition: 'recoverable', reasonCodes: ['PRIOR_IDENTITY_AND_COMPLETE_MATCH_EVIDENCE'] }
    : { disposition: 'insufficient_evidence', reasonCodes };
}

export async function reconcileProviderPlayers(season: string) {
  const {
    entityLinks,
    fplRows: normalizedFpl,
    fplPlayers,
    fplByCode,
    understatById,
    candidatesByPlayer,
    evidenceCount,
    observationsByPair,
    multipleCandidatesByPlayer,
  } = await collectProviderPlayerEvidence(season);
  let confirmed = 0;
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
    if (
      verifiedPlayerMappingConflict(
        verifiedPlayerLinks.filter((candidate) => candidate.id !== link.id),
        understatPlayerId,
        playerCode,
      )
    ) {
      continue;
    }
    const observedMatches = observationsByPair.get(`${playerCode}:${understatPlayerId}`)?.size ?? 0;
    if (!shouldConfirmProviderPlayerSeason(link, season, observedMatches)) {
      continue;
    }
    const fpl = fplByCode.get(playerCode);
    const understat = understatById.get(understatPlayerId);
    if (!fpl || !understat) continue;
    // The entity link is shared across seasons. Keep the durable evidence
    // season-neutral and only append the newly confirmed season; otherwise a
    // repair pass for one season rewrites shared evidence and makes every
    // other season stale again.
    const confirmedSeasons = confirmedPlayerSeasons(link, season);
    await providerIdentityRepository.upsertEntityLink({
      entityType: 'player',
      leftProvider: link.leftProvider,
      leftEntityId: String(understatPlayerId),
      rightProvider: link.rightProvider,
      rightEntityId: String(playerCode),
      status: link.status,
      method: link.method,
      ruleId: link.ruleId,
      season,
      ...(link.reviewedBy ? { reviewedBy: link.reviewedBy } : {}),
      reviewedAt: link.reviewedAt,
      evidence: {
        ...link.evidence,
        confirmedSeasons,
      },
    });
    confirmed += 1;
  }

  const protectedPlayerLinks = entityLinks.filter(
    (link) =>
      link.entityType === 'player' &&
      link.leftProvider === 'understat' &&
      link.rightProvider === 'fpl' &&
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
  for (const playerCode of multipleCandidatesByPlayer) {
    eligibleForAutoVerification.set(playerCode, new Set());
  }
  const assignments = resolveUniqueProviderAssignments(eligibleForAutoVerification);
  let verified = 0;
  for (const [playerCode, playerId] of assignments) {
    const fpl = fplByCode.get(playerCode);
    const understat = understatById.get(playerId);
    if (!fpl || !understat) continue;
    const existingLink = entityLinks.find(
      (link) =>
        link.entityType === 'player' &&
        link.leftProvider === 'understat' &&
        link.leftEntityId === String(playerId) &&
        link.rightProvider === 'fpl' &&
        link.rightEntityId === String(playerCode),
    );
    await providerIdentityRepository.upsertEntityLink({
      entityType: 'player',
      leftProvider: 'understat',
      leftEntityId: String(playerId),
      rightProvider: 'fpl',
      rightEntityId: String(playerCode),
      status: 'auto_verified',
      method: 'verified-match-roster-bipartite',
      ruleId: PLAYER_RULE_ID,
      season,
      evidence: {
        understatName: understat.name,
        fplName: fpl.name,
        observedMatches: observationsByPair.get(`${playerCode}:${playerId}`)?.size ?? 0,
        playerEvidenceRows: evidenceCount.get(playerCode) ?? 0,
        confirmedSeasons: confirmedPlayerSeasons(existingLink, season),
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
    const status =
      values.size > 1 || multipleCandidatesByPlayer.has(playerCode) ? 'ambiguous' : 'pending';
    for (const playerId of values) {
      const fpl = fplByCode.get(playerCode);
      const understat = understatById.get(playerId);
      if (!fpl || !understat) continue;
      await providerIdentityRepository.upsertEntityLink({
        entityType: 'player',
        leftProvider: 'understat',
        leftEntityId: String(playerId),
        rightProvider: 'fpl',
        rightEntityId: String(playerCode),
        status,
        method: 'verified-match-roster-candidate',
        ruleId: PLAYER_RULE_ID,
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
  return { verified, confirmed, ambiguous, pending, quarantined: 0, notObserved };
}

export async function inspectQuarantinedProviderPlayers(
  season: string,
): Promise<UnderstatPlayerMappingRecoveryReport> {
  const snapshot = await collectProviderPlayerEvidence(season);
  const verifiedLinks = snapshot.entityLinks.filter(
    (link) =>
      link.entityType === 'player' &&
      link.leftProvider === 'understat' &&
      link.rightProvider === 'fpl' &&
      link.leftEntityId !== null &&
      isVerifiedProviderLinkStatus(link.status),
  );
  const quarantined = snapshot.entityLinks.filter(
    (link) =>
      link.entityType === 'player' &&
      link.leftProvider === 'understat' &&
      link.rightProvider === 'fpl' &&
      link.status === 'quarantined' &&
      quarantinedPlayerLinkHasSeasonEvidence(link, season, snapshot),
  );
  const items = quarantined.map(
    (link): Omit<UnderstatPlayerMappingRecoveryItem, 'evidenceHash'> => {
      const fplPlayerCode = Number(link.rightEntityId);
      const understatPlayerId =
        link.leftEntityId !== null && Number.isSafeInteger(Number(link.leftEntityId))
          ? Number(link.leftEntityId)
          : null;
      const key = `${fplPlayerCode}:${understatPlayerId ?? 'invalid'}`;
      const observedMatchIds = [...(snapshot.observationsByPair.get(key) ?? [])].sort(
        (a, b) => a - b,
      );
      const fixtureCodes = [...(snapshot.fixtureCodesByPair.get(key) ?? [])].sort((a, b) => a - b);
      const classification = classifyQuarantinedProviderPlayerMapping({
        link,
        season,
        understatPlayerId,
        fplPlayerCode,
        observedCandidates: snapshot.candidatesByPlayer.get(fplPlayerCode),
        observedMatchIds,
        hasAmbiguousObservation: snapshot.multipleCandidatesByPlayer.has(fplPlayerCode),
        hasVerifiedConflict:
          understatPlayerId !== null &&
          Boolean(
            verifiedPlayerMappingConflict(
              verifiedLinks.filter((candidate) => candidate.id !== link.id),
              understatPlayerId,
              fplPlayerCode,
            ),
          ),
      });
      return {
        linkId: link.id,
        understatPlayerId,
        fplPlayerCode,
        understatName:
          understatPlayerId === null
            ? null
            : (snapshot.understatById.get(understatPlayerId)?.name ?? null),
        fplName: snapshot.fplByCode.get(fplPlayerCode)?.name ?? null,
        originalStatus: link.status,
        sourceEvidenceHash: contentHash(link.evidence),
        priorConfirmedSeasons: priorConfirmedSeasons(link, season),
        observedMatchIds,
        fixtureCodes,
        ...classification,
      };
    },
  );
  const itemsWithEvidenceHash = items.map((item) => ({
    ...item,
    // Bind the approval to the complete report item, including current names,
    // match observations, classification, and the stored quarantine evidence.
    evidenceHash: contentHash({ season, item }),
  }));
  const summary: Record<UnderstatPlayerMappingRecoveryDisposition, number> = {
    recoverable: 0,
    identity_conflict: 0,
    insufficient_evidence: 0,
    manual_review: 0,
  };
  for (const item of itemsWithEvidenceHash) summary[item.disposition] += 1;
  return { season, generatedAt: new Date().toISOString(), items: itemsWithEvidenceHash, summary };
}

export async function restoreQuarantinedProviderPlayers(
  season: string,
  approvals: readonly UnderstatPlayerMappingRecoveryApproval[],
): Promise<UnderstatPlayerMappingRecoveryApplyResult> {
  const seen = new Set<string>();
  for (const approval of approvals) {
    if (
      !approval.linkId ||
      !Number.isSafeInteger(approval.understatPlayerId) ||
      approval.understatPlayerId <= 0 ||
      !Number.isSafeInteger(approval.fplPlayerCode) ||
      approval.fplPlayerCode <= 0 ||
      !/^[0-9a-f]{64}$/i.test(approval.evidenceHash)
    ) {
      throw new Error('Recovery approvals contain an invalid player mapping or evidence hash');
    }
    if (seen.has(approval.linkId))
      throw new Error(`Duplicate recovery approval ${approval.linkId}`);
    seen.add(approval.linkId);
  }
  return withMutationScopes(
    {
      queueName: 'understat-mappings',
      jobName: 'understat-mappings-recovery',
      scopes: ['understat:reference:all', `understat:reference:${season}`],
    },
    async () => {
      const report = await inspectQuarantinedProviderPlayers(season);
      const currentLinks = await providerIdentityRepository.findEntityLinks({
        entityType: 'player',
      });
      const applied: string[] = [];
      const skipped: { linkId: string; reason: string }[] = [];
      const candidates: {
        approval: UnderstatPlayerMappingRecoveryApproval;
        item: UnderstatPlayerMappingRecoveryItem;
        current: ProviderEntityLink & { leftEntityId: string };
      }[] = [];
      for (const approval of approvals) {
        const item = report.items.find((candidate) => candidate.linkId === approval.linkId);
        if (!item) {
          skipped.push({ linkId: approval.linkId, reason: 'NOT_CURRENTLY_QUARANTINED' });
          continue;
        }
        if (
          item.disposition !== 'recoverable' ||
          item.understatPlayerId !== approval.understatPlayerId ||
          item.fplPlayerCode !== approval.fplPlayerCode ||
          item.evidenceHash !== approval.evidenceHash
        ) {
          skipped.push({ linkId: approval.linkId, reason: 'APPROVAL_NO_LONGER_MATCHES_REPORT' });
          continue;
        }
        const current = currentLinks.find((candidate) => candidate.id === approval.linkId);
        if (
          !current ||
          current.status !== 'quarantined' ||
          current.leftEntityId === null ||
          current.leftEntityId !== String(approval.understatPlayerId) ||
          current.rightEntityId !== String(approval.fplPlayerCode) ||
          contentHash(current.evidence) !== item.sourceEvidenceHash
        ) {
          skipped.push({ linkId: approval.linkId, reason: 'LINK_CHANGED_BEFORE_APPLY' });
          continue;
        }
        const verifiedConflict = verifiedPlayerMappingConflict(
          currentLinks.filter((candidate) => isVerifiedProviderLinkStatus(candidate.status)),
          approval.understatPlayerId,
          approval.fplPlayerCode,
        );
        if (verifiedConflict) {
          skipped.push({ linkId: approval.linkId, reason: 'VERIFIED_IDENTITY_CONFLICT' });
          continue;
        }
        candidates.push({
          approval,
          item,
          current: { ...current, leftEntityId: current.leftEntityId },
        });
      }
      const approvalsByUnderstatId = new Map<string, number>();
      const approvalsByFplCode = new Map<string, number>();
      for (const candidate of candidates) {
        const understatId = candidate.current.leftEntityId;
        const fplCode = candidate.current.rightEntityId;
        approvalsByUnderstatId.set(understatId, (approvalsByUnderstatId.get(understatId) ?? 0) + 1);
        approvalsByFplCode.set(fplCode, (approvalsByFplCode.get(fplCode) ?? 0) + 1);
      }
      const recoveredAt = new Date().toISOString();
      for (const { approval, item, current } of candidates) {
        if (
          (approvalsByUnderstatId.get(current.leftEntityId) ?? 0) > 1 ||
          (approvalsByFplCode.get(current.rightEntityId) ?? 0) > 1
        ) {
          skipped.push({ linkId: approval.linkId, reason: 'BATCH_IDENTITY_CONFLICT' });
          continue;
        }
        await providerIdentityRepository.upsertEntityLink({
          entityType: current.entityType,
          leftProvider: current.leftProvider,
          leftEntityId: current.leftEntityId,
          rightProvider: current.rightProvider,
          rightEntityId: current.rightEntityId,
          status: 'auto_verified',
          method: 'verified-match-roster-recovery',
          ruleId: PLAYER_RECOVERY_RULE_ID,
          season,
          evidence: {
            ...current.evidence,
            confirmedSeasons: [
              ...new Set([...priorConfirmedSeasons(current, season), season]),
            ].sort(),
            recovery: {
              ruleId: PLAYER_RECOVERY_RULE_ID,
              restoredFrom: current.status,
              reasonCodes: item.reasonCodes,
              recoveredAt,
              observedMatchIds: item.observedMatchIds,
              fixtureCodes: item.fixtureCodes,
            },
          },
        });
        applied.push(approval.linkId);
      }
      return { season, applied, skipped };
    },
  );
}

export async function reconcileProviderMappings(season: string) {
  const matches = await reconcileProviderMatches(season);
  const players = await reconcileProviderPlayers(season);
  return { season, matches, players };
}
