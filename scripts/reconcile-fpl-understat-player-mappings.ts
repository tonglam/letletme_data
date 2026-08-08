/* eslint-disable no-console -- CLI audit output */
import 'dotenv/config';

import { writeFile } from 'node:fs/promises';

import { databaseSingleton, getDbClient } from '../src/db/singleton';

const SEASONS = [
  '2526',
  '2425',
  '2324',
  '2223',
  '2122',
  '2021',
  '1920',
  '1819',
  '1718',
  '1617',
  '1516',
  '1415',
] as const;

const RULE_VERSION = 'understat-fpl-player-name-v3';

type Season = (typeof SEASONS)[number];
type Confidence = 'exact' | 'high' | 'low';
type DecisionKind =
  | 'exact'
  | 'carried-forward'
  | 'name-variant'
  | 'manual-confirmed'
  | 'ambiguous'
  | 'unmatched';
type Verification = 'auto' | 'manual';

interface FplPlayerRow {
  season: Season;
  playerId: number;
  playerCode: number;
  firstName: string | null;
  secondName: string | null;
  webName: string | null;
  elementType: number;
  teamName: string | null;
  seasonMinutes: number | null;
  seasonGoals: number | null;
  seasonAssists: number | null;
}

interface UnderstatPlayerRow {
  season: Season;
  playerId: number;
  sourceName: string;
  sourceTeamTitle: string;
  position: string | null;
  time: number;
  goals: number;
  assists: number;
}

interface Candidate {
  fpl: FplPlayerRow;
  score: number;
  confidence: Confidence;
  reason: string;
  teamScore: number;
  positionCompatible: boolean;
  statEvidence?: number | null;
}

interface Decision {
  season: Season;
  understatPlayerId: number;
  understatName: string;
  understatTeam: string;
  fpl: FplPlayerRow | null;
  kind: DecisionKind;
  confidence: Confidence;
  verification: Verification;
  score: number | null;
  reason: string;
  candidates: Array<{
    playerCode: number;
    name: string;
    team: string | null;
    score: number;
    statEvidence?: number | null;
  }>;
}

interface AcceptedPair {
  understatPlayerId: number;
  playerCode: number;
  seasons: Set<Season>;
  decisions: Decision[];
}

interface ManualApproval {
  season: Season;
  understatPlayerId: number;
  playerCode: number;
}

function normalizeName(value: string | null | undefined): string {
  if (!value) return '';
  const decoded = value
    .replace(/&#0*39;/gi, String.fromCharCode(39))
    .replace(/&#0*34;/gi, '"')
    .replace(/&amp;/gi, '&');
  const transliterated = decoded
    .replace(/[ıİ]/g, 'i')
    .replace(/[øØ]/g, 'o')
    .replace(/[łŁ]/g, 'l')
    .replace(/[đĐ]/g, 'd')
    .replace(/[ðÐ]/g, 'd')
    .replace(/[þÞ]/g, 'th')
    .replace(/[æÆ]/g, 'ae')
    .replace(/[œŒ]/g, 'oe')
    .replace(/[ß]/g, 'ss');
  return transliterated
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase('en-US')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '');
}

function nameTokens(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .replace(/&#0*39;/gi, String.fromCharCode(39))
    .replace(/&#0*34;/gi, '"')
    .replace(/&amp;/gi, '&')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLocaleLowerCase('en-US')
    .replace(/[’']/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function fplFullName(player: FplPlayerRow): string {
  return (
    [player.firstName, player.secondName].filter(Boolean).join(' ').trim() || player.webName || ''
  );
}

function tokenSimilarity(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) return 0;
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const intersection = [...leftSet].filter((token) => rightSet.has(token)).length;
  return intersection / Math.max(leftSet.size, rightSet.size);
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    }
    for (let j = 0; j <= right.length; j += 1) previous[j] = current[j] ?? 0;
  }
  return previous[right.length] ?? Math.max(left.length, right.length);
}

function normalizedEditSimilarity(left: string, right: string): number {
  if (!left || !right) return 0;
  const distance = editDistance(left, right);
  return 1 - distance / Math.max(left.length, right.length);
}

function teamSimilarity(understatTeam: string, fplTeam: string | null): number {
  const aliases: Record<string, string> = {
    mancity: 'manchestercity',
    manutd: 'manchesterunited',
    newcastle: 'newcastleunited',
    nottmforest: 'nottinghamforest',
    sheffieldutd: 'sheffieldunited',
    spurs: 'tottenham',
    westbrom: 'westbromwichalbion',
    wolves: 'wolverhamptonwanderers',
  };
  const canonicalize = (team: string | null | undefined) => {
    const normalized = normalizeName(team);
    return aliases[normalized] ?? normalized;
  };
  const splitTeams = (team: string | null | undefined): string[] =>
    (team ?? '')
      .split(/[,/;|]/)
      .map((part) => part.trim())
      .filter(Boolean);
  const leftTeams = splitTeams(understatTeam);
  const rightTeams = splitTeams(fplTeam);
  if (leftTeams.length === 0 || rightTeams.length === 0) return 0;
  return Math.max(
    ...leftTeams.flatMap((leftTeam) =>
      rightTeams.map((rightTeam) => {
        const left = canonicalize(leftTeam);
        const right = canonicalize(rightTeam);
        if (!left || !right) return 0;
        if (left === right) return 1;
        return tokenSimilarity(nameTokens(leftTeam), nameTokens(rightTeam));
      }),
    ),
  );
}

const FIRST_NAME_ALIAS_GROUPS: readonly (readonly string[])[] = [
  ['alex', 'alejandro'],
  ['fer', 'fernando'],
  ['franck', 'frank'],
  ['kiko', 'francisco'],
  ['jonny', 'jonathan'],
  ['vini', 'vinicius'],
] as const;

function firstNameSimilarity(understatFirstName: string, fplFirstNames: string[]): number {
  const aliasMatch = FIRST_NAME_ALIAS_GROUPS.some(
    (group) =>
      group.includes(understatFirstName) && group.some((name) => fplFirstNames.includes(name)),
  );
  if (aliasMatch) return 1;
  return Math.max(
    0,
    ...fplFirstNames.map((name) => normalizedEditSimilarity(understatFirstName, name)),
  );
}

function positionCompatible(understatPosition: string | null, elementType: number): boolean {
  if (!understatPosition) return true;
  if (understatPosition.includes('GK')) return elementType === 1;
  const compatibleTypes = new Set<number>();
  if (understatPosition.includes('D')) compatibleTypes.add(2);
  if (understatPosition.includes('M')) compatibleTypes.add(3);
  if (understatPosition.includes('F')) compatibleTypes.add(4);
  if (compatibleTypes.size > 0) return compatibleTypes.has(elementType);
  return true;
}

function candidateFor(
  understat: UnderstatPlayerRow,
  fpl: FplPlayerRow,
  uniqueLastNames: ReadonlyMap<string, number>,
  uniqueNameTokens: ReadonlyMap<string, number>,
): Candidate | null {
  const understatKey = normalizeName(understat.sourceName);
  const fullName = fplFullName(fpl);
  const fullKey = normalizeName(fullName);
  const webKey = normalizeName(fpl.webName);
  const understatTokens = nameTokens(understat.sourceName);
  const fullTokens = nameTokens(fullName);
  const webTokens = nameTokens(fpl.webName);
  const fplFirstNameTokens = nameTokens(fpl.firstName);
  const lastName = normalizeName(fpl.secondName);
  const teamScore = teamSimilarity(understat.sourceTeamTitle, fpl.teamName);
  const positionMatches = positionCompatible(understat.position, fpl.elementType);
  const positionBonus = positionMatches ? 0.04 : 0;
  const statEvidence = seasonStatEvidence(understat, fpl);
  const statsContradict = seasonStatsContradict(understat, fpl);

  if (understatKey && understatKey === fullKey) {
    return {
      fpl,
      score: 1 + positionBonus,
      confidence: 'exact',
      reason: 'normalized-full-name-exact',
      teamScore,
      positionCompatible: positionMatches,
    };
  }

  if (understatKey && understatKey === webKey && understatKey.length >= 4) {
    return {
      fpl,
      score: 0.98 + teamScore * 0.01 + positionBonus,
      confidence: statsContradict ? 'low' : 'high',
      reason: 'web-name-exact',
      teamScore,
      positionCompatible: positionMatches,
      statEvidence,
    };
  }

  const sortedUnderstatTokens = [...new Set(understatTokens)].sort().join('|');
  const sortedFullTokens = [...new Set(fullTokens)].sort().join('|');
  if (sortedUnderstatTokens && sortedUnderstatTokens === sortedFullTokens) {
    return {
      fpl,
      score: 0.96 + teamScore * 0.03 + positionBonus,
      confidence: 'high',
      reason: 'unordered-full-name-exact',
      teamScore,
      positionCompatible: positionMatches,
    };
  }

  const fullTokenSet = new Set(fullTokens);
  const sharedTokens = understatTokens.filter((token) => fullTokenSet.has(token));
  const understatLastToken = understatTokens.at(-1);
  const fullLastToken = fullTokens.at(-1);
  const lastTokenIsStrong = understatLastToken && understatLastToken === fullLastToken;
  const firstTokenSimilarity = normalizedEditSimilarity(
    understatTokens[0] ?? '',
    fullTokens[0] ?? '',
  );
  const lastTokenSimilarity = normalizedEditSimilarity(
    understatLastToken ?? '',
    fullLastToken ?? '',
  );
  const webLastTokenMatches = Boolean(understatLastToken && webTokens.includes(understatLastToken));
  const lastTokenOverlaps = Boolean(
    understatLastToken && (fullTokenSet.has(understatLastToken) || webLastTokenMatches),
  );
  const closeFirstNameExpandedName =
    understatTokens.length >= 2 &&
    fullTokens.length >= 2 &&
    teamScore >= 0.9 &&
    firstTokenSimilarity >= 0.8 &&
    Boolean(understatLastToken && fullTokenSet.has(understatLastToken));
  if (closeFirstNameExpandedName) {
    return {
      fpl,
      score: 0.96 + teamScore * 0.03 + firstTokenSimilarity * 0.03 + positionBonus,
      confidence: statsContradict ? 'low' : 'high',
      reason: statsContradict
        ? 'name-candidate-season-stats-contradict'
        : 'team-and-close-first-name-expanded-last-name',
      teamScore,
      positionCompatible: positionMatches,
      statEvidence,
    };
  }
  if (
    understatLastToken &&
    teamScore >= 0.5 &&
    (sharedTokens.length >= 2 ||
      (lastTokenOverlaps && lastTokenIsStrong) ||
      (understatTokens.length === 1 && lastTokenOverlaps) ||
      (lastTokenOverlaps && firstTokenSimilarity >= 0.65 && lastTokenSimilarity >= 0.8) ||
      (webLastTokenMatches && firstTokenSimilarity >= 0.65))
  ) {
    return {
      fpl,
      score: 0.9 + teamScore * 0.09 + positionBonus + firstTokenSimilarity * 0.03,
      confidence: statsContradict ? 'low' : 'high',
      reason: statsContradict
        ? 'name-candidate-season-stats-contradict'
        : 'team-and-shared-name-tokens',
      teamScore,
      positionCompatible: positionMatches,
      statEvidence,
    };
  }

  const firstNameScore = firstNameSimilarity(understatTokens[0] ?? '', fplFirstNameTokens);
  if (
    understatTokens.length > 0 &&
    firstNameScore >= 0.8 &&
    teamScore >= 0.9 &&
    statEvidence !== null &&
    statEvidence >= 0.75 &&
    !statsContradict
  ) {
    return {
      fpl,
      score: 0.94 + teamScore * 0.04 + firstNameScore * 0.02 + positionBonus,
      confidence: 'high',
      reason: 'team-and-first-name-season-stats-supported',
      teamScore,
      positionCompatible: positionMatches,
      statEvidence,
    };
  }
  const isFullNameSubset =
    understatTokens.length >= 2 && understatTokens.every((token) => fullTokenSet.has(token));
  if (isFullNameSubset) {
    return {
      fpl,
      score: 0.93 + teamScore * 0.05 + positionBonus,
      confidence: 'high',
      reason: 'full-name-subset',
      teamScore,
      positionCompatible: positionMatches,
    };
  }

  const nicknameToken = understatTokens.length === 1 ? understatTokens[0] : undefined;
  if (
    nicknameToken &&
    (fullTokenSet.has(nicknameToken) || webTokens.includes(nicknameToken)) &&
    (uniqueNameTokens.get(nicknameToken) ?? 0) === 1
  ) {
    return {
      fpl,
      score: 0.92 + teamScore * 0.06 + positionBonus,
      confidence: teamScore >= 0.5 ? 'high' : 'low',
      reason: 'unique-first-name-or-nickname',
      teamScore,
      positionCompatible: positionMatches,
    };
  }

  if (
    understatTokens.length === 1 &&
    understatKey === lastName &&
    (uniqueLastNames.get(lastName) ?? 0) === 1
  ) {
    return {
      fpl,
      score: 0.91 + teamScore * 0.08 + positionBonus,
      confidence: teamScore >= 0.5 ? 'high' : 'low',
      reason: teamScore >= 0.5 ? 'unique-last-name-team-supported' : 'unique-last-name',
      teamScore,
      positionCompatible: positionMatches,
    };
  }

  const tokenScore = tokenSimilarity(understatTokens, fullTokens);
  const editScore = normalizedEditSimilarity(understatKey, fullKey);
  const firstInitialMatches =
    understatTokens.length >= 2 &&
    fullTokens.length >= 2 &&
    understatTokens[0]?.[0] === fullTokens[0]?.[0] &&
    understatTokens.at(-1) === fullTokens.at(-1);
  const score = Math.min(
    0.84,
    Math.max(
      tokenScore * 0.72 + teamScore * 0.18 + positionBonus,
      editScore * 0.75 + teamScore * 0.15 + positionBonus,
      firstInitialMatches ? 0.76 + teamScore * 0.12 + positionBonus : 0,
    ),
  );
  if (score < 0.55) return null;
  return {
    fpl,
    score,
    confidence: score >= 0.88 ? 'high' : 'low',
    reason: firstInitialMatches ? 'initial-last-name-variant' : 'fuzzy-name-candidate',
    teamScore,
    positionCompatible: positionMatches,
    statEvidence,
  };
}

function seasonNumber(season: Season): number {
  return Number(season);
}

function fplNameForOutput(player: FplPlayerRow): string {
  return fplFullName(player) || player.webName || `code:${player.playerCode}`;
}

function seasonStatEvidence(understat: UnderstatPlayerRow, fpl: FplPlayerRow): number | null {
  if (fpl.seasonMinutes === null || fpl.seasonGoals === null || fpl.seasonAssists === null) {
    return null;
  }
  const minuteDenominator = Math.max(understat.time, fpl.seasonMinutes, 1);
  const minuteSimilarity = Math.max(
    0,
    1 - Math.abs(understat.time - fpl.seasonMinutes) / minuteDenominator,
  );
  const assistDifference = Math.abs(understat.assists - fpl.seasonAssists);
  const assistSimilarity = assistDifference === 0 ? 1 : assistDifference === 1 ? 0.5 : 0;
  return Number(
    (
      (understat.goals === fpl.seasonGoals ? 0.5 : 0) +
      assistSimilarity * 0.2 +
      minuteSimilarity * 0.3
    ).toFixed(3),
  );
}

function seasonStatsContradict(understat: UnderstatPlayerRow, fpl: FplPlayerRow): boolean {
  const evidence = seasonStatEvidence(understat, fpl);
  return evidence !== null && evidence < 0.2 && (fpl.seasonMinutes ?? 0) >= 600;
}

async function loadRows() {
  const client = await getDbClient();
  const fpl = await client.unsafe<FplPlayerRow[]>(`
    SELECT
      p.season,
      p.id AS "playerId",
      p.code AS "playerCode",
      p.first_name AS "firstName",
      p.second_name AS "secondName",
      p.web_name AS "webName",
      p.type AS "elementType",
      t.name AS "teamName",
      summary.minutes AS "seasonMinutes",
      summary.goals_scored AS "seasonGoals",
      summary.assists AS "seasonAssists"
    FROM public.players_history p
    LEFT JOIN public.teams_history t
      ON t.season = p.season AND t.id = p.team_id
    LEFT JOIN public.event_live_summaries_history summary
      ON summary.season = p.season AND summary.element_id = p.id
    WHERE p.season IN (${SEASONS.map((season) => `'${season}'`).join(', ')})
    ORDER BY p.season DESC, p.code
  `);
  const understat = await client.unsafe<UnderstatPlayerRow[]>(`
    SELECT
      s.season,
      s.player_id AS "playerId",
      s.source_name AS "sourceName",
      s.source_team_title AS "sourceTeamTitle",
      s.position,
      s.time,
      s.goals,
      s.assists
    FROM public.understat_player_seasons s
    WHERE s.season IN (${SEASONS.map((season) => `'${season}'`).join(', ')})
    ORDER BY s.season DESC, s.player_id
  `);
  return { fpl, understat };
}

async function loadPersistedManualApprovals(): Promise<ManualApproval[]> {
  const client = await getDbClient();
  return client.unsafe<ManualApproval[]>(`
    SELECT
      seasons.season AS season,
      l.left_entity_id::int AS "understatPlayerId",
      l.right_entity_id::int AS "playerCode"
    FROM public.provider_entity_links l
    CROSS JOIN LATERAL jsonb_array_elements_text(
      COALESCE(l.evidence->'confirmedSeasons', '[]'::jsonb)
    ) AS seasons(season)
    WHERE l.entity_type = 'player'
      AND l.left_provider = 'understat'
      AND l.right_provider = 'fpl'
      AND l.status = 'manual_verified'
      AND seasons.season IN (${SEASONS.map((season) => `'${season}'`).join(', ')})
  `);
}

function parseManualApprovals(): ManualApproval[] {
  return process.argv
    .filter((argument) => argument.startsWith('--approve='))
    .map((argument) => {
      const [rawSeason, rawUnderstatId, rawPlayerCode] = argument
        .slice('--approve='.length)
        .split(':');
      const season = rawSeason as Season;
      const understatPlayerId = Number(rawUnderstatId);
      const playerCode = Number(rawPlayerCode);
      if (
        !SEASONS.includes(season) ||
        !Number.isInteger(understatPlayerId) ||
        understatPlayerId <= 0 ||
        !Number.isInteger(playerCode) ||
        playerCode <= 0
      ) {
        throw new Error(
          `Invalid --approve value: ${argument}. Expected --approve=season:understatPlayerId:fplCode`,
        );
      }
      return { season, understatPlayerId, playerCode };
    });
}

function mergeManualApprovals(...approvalSets: ManualApproval[][]): ManualApproval[] {
  const merged = new Map<string, ManualApproval>();
  for (const approvals of approvalSets) {
    for (const approval of approvals) {
      merged.set(
        `${approval.season}:${approval.understatPlayerId}:${approval.playerCode}`,
        approval,
      );
    }
  }
  return [...merged.values()];
}

function buildSeasonDecisions(
  season: Season,
  fplRows: FplPlayerRow[],
  understatRows: UnderstatPlayerRow[],
  priorPairs: ReadonlyMap<number, AcceptedPair>,
): { decisions: Decision[]; accepted: AcceptedPair[] } {
  const fplByCode = new Map(fplRows.map((row) => [row.playerCode, row]));
  const uniqueLastNames = new Map<string, number>();
  const uniqueNameTokens = new Map<string, number>();
  for (const player of fplRows) {
    const lastName = normalizeName(player.secondName);
    if (lastName) uniqueLastNames.set(lastName, (uniqueLastNames.get(lastName) ?? 0) + 1);
    for (const token of new Set([
      ...nameTokens(fplFullName(player)),
      ...nameTokens(player.webName),
    ])) {
      uniqueNameTokens.set(token, (uniqueNameTokens.get(token) ?? 0) + 1);
    }
  }

  const decisions: Decision[] = [];
  const accepted: AcceptedPair[] = [];
  const takenCodes = new Set<number>();

  for (const understat of understatRows) {
    const prior = priorPairs.get(understat.playerId);
    if (prior && fplByCode.has(prior.playerCode) && !takenCodes.has(prior.playerCode)) {
      const fpl = fplByCode.get(prior.playerCode)!;
      const decision: Decision = {
        season,
        understatPlayerId: understat.playerId,
        understatName: understat.sourceName,
        understatTeam: understat.sourceTeamTitle,
        fpl,
        kind: 'carried-forward',
        confidence: 'high',
        verification: prior.decisions.some((decision) => decision.verification === 'manual')
          ? 'manual'
          : 'auto',
        score: 1,
        reason: `carried-from-${[...prior.seasons].sort((a, b) => seasonNumber(b) - seasonNumber(a))[0]}`,
        candidates: [],
      };
      decisions.push(decision);
      accepted.push({
        understatPlayerId: understat.playerId,
        playerCode: fpl.playerCode,
        seasons: new Set([season]),
        decisions: [decision],
      });
      takenCodes.add(fpl.playerCode);
      continue;
    }

    const candidates = fplRows
      .map((fpl) => candidateFor(understat, fpl, uniqueLastNames, uniqueNameTokens))
      .filter((candidate): candidate is Candidate => candidate !== null)
      .sort(
        (left, right) => right.score - left.score || left.fpl.playerCode - right.fpl.playerCode,
      );
    const identityStrongCandidates = candidates.filter(
      (candidate) =>
        candidate.confidence === 'exact' ||
        candidate.reason === 'web-name-exact' ||
        candidate.reason === 'unordered-full-name-exact',
    );
    const exactCandidates = candidates.filter((candidate) => candidate.confidence === 'exact');
    const teamSupportedHighCandidates = candidates.filter(
      (candidate) =>
        candidate.teamScore >= 0.5 &&
        (candidate.confidence === 'high' ||
          (candidate.positionCompatible && (candidate.statEvidence ?? 0) >= 0.75)),
    );
    const positionSupportedCandidates = candidates.filter(
      (candidate) => candidate.positionCompatible,
    );
    const rankedCandidates =
      exactCandidates.length > 0
        ? exactCandidates
        : teamSupportedHighCandidates.length > 0
          ? teamSupportedHighCandidates
          : identityStrongCandidates.length > 0
            ? identityStrongCandidates
            : positionSupportedCandidates.length > 0
              ? positionSupportedCandidates
              : candidates;
    const top = rankedCandidates[0];
    const second = rankedCandidates[1];
    const candidateOutput = rankedCandidates.slice(0, 5).map((candidate) => ({
      playerCode: candidate.fpl.playerCode,
      name: fplNameForOutput(candidate.fpl),
      team: candidate.fpl.teamName,
      score: Number(candidate.score.toFixed(3)),
      statEvidence: candidate.statEvidence ?? null,
    }));

    if (!top) {
      decisions.push({
        season,
        understatPlayerId: understat.playerId,
        understatName: understat.sourceName,
        understatTeam: understat.sourceTeamTitle,
        fpl: null,
        kind: 'unmatched',
        confidence: 'low',
        verification: 'auto',
        score: null,
        reason: 'no-name-candidate',
        candidates: candidateOutput,
      });
      continue;
    }

    const uniqueTop = !second || top.score - second.score >= 0.08;
    const statsIdentitySupported =
      top.reason === 'web-name-exact' &&
      top.positionCompatible &&
      top.statEvidence !== null &&
      top.statEvidence !== undefined &&
      top.statEvidence >= 0.85;
    const statsSupportedTop =
      (top.teamScore >= 0.5 || statsIdentitySupported) &&
      top.statEvidence !== null &&
      top.statEvidence !== undefined &&
      top.statEvidence >= 0.85 &&
      (!second ||
        second.statEvidence === null ||
        second.statEvidence === undefined ||
        top.statEvidence - second.statEvidence >= 0.15);
    const exact = top.confidence === 'exact' && !takenCodes.has(top.fpl.playerCode);
    const highNonExact =
      (top.confidence === 'high' || statsSupportedTop) &&
      (uniqueTop || statsSupportedTop) &&
      !takenCodes.has(top.fpl.playerCode);
    const acceptedCandidate = exact || highNonExact;
    if (acceptedCandidate) {
      const kind: DecisionKind = exact ? 'exact' : 'name-variant';
      const decision: Decision = {
        season,
        understatPlayerId: understat.playerId,
        understatName: understat.sourceName,
        understatTeam: understat.sourceTeamTitle,
        fpl: top.fpl,
        kind,
        confidence: exact ? 'exact' : 'high',
        verification: 'auto',
        score: Number(top.score.toFixed(3)),
        reason:
          statsSupportedTop && (top.confidence !== 'high' || !uniqueTop)
            ? `season-stats-supported:${top.reason}`
            : top.reason,
        candidates: candidateOutput,
      };
      decisions.push(decision);
      accepted.push({
        understatPlayerId: understat.playerId,
        playerCode: top.fpl.playerCode,
        seasons: new Set([season]),
        decisions: [decision],
      });
      takenCodes.add(top.fpl.playerCode);
      continue;
    }

    decisions.push({
      season,
      understatPlayerId: understat.playerId,
      understatName: understat.sourceName,
      understatTeam: understat.sourceTeamTitle,
      fpl: top.fpl,
      kind: 'ambiguous',
      confidence: 'low',
      verification: 'auto',
      score: Number(top.score.toFixed(3)),
      reason: takenCodes.has(top.fpl.playerCode)
        ? 'fpl-player-already-assigned-in-season'
        : !uniqueTop
          ? 'candidate-margin-below-threshold'
          : top.reason,
      candidates: candidateOutput,
    });
  }

  return { decisions, accepted };
}

function applyManualApprovals(
  result: { decisions: Decision[]; accepted: AcceptedPair[] },
  season: Season,
  fplRows: FplPlayerRow[],
  approvals: ManualApproval[],
): void {
  for (const approval of approvals.filter((item) => item.season === season)) {
    const decision = result.decisions.find(
      (item) => item.season === season && item.understatPlayerId === approval.understatPlayerId,
    );
    if (!decision) {
      throw new Error(
        `Manual approval target not found: ${season}:${approval.understatPlayerId}:${approval.playerCode}`,
      );
    }
    if (
      decision.verification === 'auto' &&
      decision.confidence === 'high' &&
      decision.fpl?.playerCode === approval.playerCode
    ) {
      continue;
    }
    const fpl = fplRows.find((row) => row.playerCode === approval.playerCode);
    if (!fpl) {
      throw new Error(`Manual approval FPL code not found in ${season}: ${approval.playerCode}`);
    }
    if (decision.fpl && decision.fpl.playerCode !== approval.playerCode) {
      throw new Error(
        `Manual approval conflicts with candidate for ${season}:${approval.understatPlayerId}: ` +
          `${decision.fpl.playerCode} vs ${approval.playerCode}`,
      );
    }
    const conflictingPair = result.accepted.find(
      (pair) =>
        pair.playerCode === approval.playerCode &&
        pair.understatPlayerId !== approval.understatPlayerId,
    );
    if (conflictingPair) {
      throw new Error(
        `Manual approval would duplicate FPL ${approval.playerCode} in ${season}: ` +
          `Understat ${conflictingPair.understatPlayerId} and ${approval.understatPlayerId}`,
      );
    }

    decision.fpl = fpl;
    decision.kind = 'manual-confirmed';
    decision.confidence = 'high';
    decision.verification = 'manual';
    decision.reason = 'manual-confirmed-by-user';
    decision.score = decision.score ?? 1;
    if (!decision.candidates.some((candidate) => candidate.playerCode === fpl.playerCode)) {
      decision.candidates.unshift({
        playerCode: fpl.playerCode,
        name: fplNameForOutput(fpl),
        team: fpl.teamName,
        score: decision.score,
      });
    }

    const existingPair = result.accepted.find(
      (pair) => pair.understatPlayerId === approval.understatPlayerId,
    );
    if (existingPair) {
      if (existingPair.playerCode !== approval.playerCode) {
        throw new Error(
          `Manual approval conflicts with accepted pair for Understat ${approval.understatPlayerId}: ` +
            `${existingPair.playerCode} vs ${approval.playerCode}`,
        );
      }
      return;
    }
    result.accepted.push({
      understatPlayerId: approval.understatPlayerId,
      playerCode: approval.playerCode,
      seasons: new Set([season]),
      decisions: [decision],
    });
  }
}

function summarize(decisions: Decision[]) {
  return {
    understatPlayers: decisions.length,
    exact: decisions.filter((decision) => decision.kind === 'exact').length,
    carriedForward: decisions.filter((decision) => decision.kind === 'carried-forward').length,
    highNonExact: decisions.filter((decision) => decision.kind === 'name-variant').length,
    manualVerified: decisions.filter((decision) => decision.verification === 'manual').length,
    lowConfidence: decisions.filter(
      (decision) => decision.confidence === 'low' && decision.kind !== 'unmatched',
    ).length,
    unmatched: decisions.filter((decision) => decision.kind === 'unmatched').length,
  };
}

function renderAudit(
  reports: Array<Record<string, unknown>>,
  decisions: readonly Decision[],
  lowConfidence: readonly Decision[],
): string {
  const nonExact = decisions.filter((decision) => decision.kind !== 'exact');
  const highNonExact = nonExact.filter(
    (decision) => decision.confidence === 'high' && decision.verification === 'auto',
  );
  const manualVerified = decisions.filter((decision) => decision.verification === 'manual');
  const lines = [
    '# Understat–FPL 球员映射审计日志',
    '',
    `- 生成时间：${new Date().toISOString()}`,
    `- 规则版本：\`${RULE_VERSION}\``,
    '- 处理顺序：2526 → 2425 → 2324 → 2223 → 2122 → 2021 → 1920 → 1819 → 1718 → 1617 → 1516 → 1415',
    '- exact normalized full name 不单独记录；所有非 exact 决策均在本文记录。',
    '- consumer 只应读取 `provider_entity_links.status IN (auto_verified, manual_verified)`。',
    '',
    '## 判定规则',
    '',
    '- `exact`：FPL `first_name + second_name` 与 Understat `source_name` 经 Unicode、重音和标点归一化后完全一致。',
    '- `high`：唯一的稳定姓名变体、昵称、反序/缩写、姓名子集，或同队且首名接近、姓氏共享的正式姓名扩展；且有球队/位置、赛季统计或跨赛季已审核结果支持；自动写为 `auto_verified`，但本文保留记录并抽样复核。',
    '- `low`：候选不唯一、同队同姓/同名冲突、无法从现有 FPL 档案确定，或只有弱模糊相似度；不写入 verified link，等待人工逐条确认。',
    '- 逐赛季向下继承只复用已经接受的 Understat player id ↔ FPL code；一旦新赛季出现冲突，保持 low，不静默重绑。',
    '',
    '## 逐赛季结果',
    '',
    '| 赛季 | FPL 球员 | Understat 球员 | exact | 向下继承 | high 非 exact | manual | low（不含 unmatched） | unmatched | 状态 |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
  ];
  for (const report of reports) {
    const season = String(report.season);
    const status = typeof report.status === 'string' ? report.status : 'candidate-audit';
    lines.push(
      `| ${season} | ${String(report.fplPlayers ?? 0)} | ${String(report.understatPlayers ?? 0)} | ${String(report.exact ?? '-')} | ${String(report.carriedForward ?? '-')} | ${String(report.highNonExact ?? '-')} | ${String(report.manualVerified ?? '-')} | ${String(report.lowConfidence ?? '-')} | ${String(report.unmatched ?? '-')} | ${status} |`,
    );
  }
  lines.push(
    '',
    `合计：${nonExact.length} 条非 exact 决策，其中自动 high ${highNonExact.length} 条、manual ${manualVerified.length} 条、low ${lowConfidence.length} 条。`,
    '',
    '## High 非 exact 全量日志',
    '',
    '| 赛季 | Understat id | Understat 名称 | FPL code | FPL 名称 | 类型 | 置信度 | 分数 | 规则 |',
    '| --- | ---: | --- | ---: | --- | --- | --- | ---: | --- |',
  );
  for (const decision of highNonExact) {
    lines.push(
      `| ${decision.season} | ${decision.understatPlayerId} | ${decision.understatName} | ${decision.fpl?.playerCode ?? '-'} | ${decision.fpl ? fplNameForOutput(decision.fpl) : '-'} | ${decision.kind} | ${decision.confidence} | ${decision.score ?? '-'} | ${decision.reason} |`,
    );
  }
  lines.push(
    '',
    '## High 置信抽样复核',
    '',
    '按赛季取排序后的前 2 条 high 非 exact 记录，核对名称、球队和位置；抽样结果作为规则回归基线。',
    '',
    '| 赛季 | Understat | FPL | Understat 球队 | FPL 球队 | FPL type |',
    '| --- | --- | --- | --- | --- | ---: |',
  );
  for (const season of SEASONS) {
    const samples = highNonExact.filter((decision) => decision.season === season).slice(0, 2);
    for (const decision of samples) {
      lines.push(
        `| ${season} | ${decision.understatName} (${decision.understatPlayerId}) | ${decision.fpl ? `${fplNameForOutput(decision.fpl)} (${decision.fpl.playerCode})` : '-'} | ${decision.understatTeam} | ${decision.fpl?.teamName ?? '-'} | ${decision.fpl?.elementType ?? '-'} |`,
      );
    }
  }
  lines.push(
    '',
    '## Manual 已确认日志',
    '',
    '以下记录由人工逐条确认，写入 `manual_verified`，并作为后续赛季倒序继承依据。',
    '',
    '| 赛季 | Understat id | Understat 名称 | FPL code | FPL 名称 | 类型 | 原因 |',
    '| --- | ---: | --- | ---: | --- | --- | --- |',
  );
  for (const decision of manualVerified) {
    lines.push(
      `| ${decision.season} | ${decision.understatPlayerId} | ${decision.understatName} | ${decision.fpl?.playerCode ?? '-'} | ${decision.fpl ? fplNameForOutput(decision.fpl) : '-'} | ${decision.kind} | ${decision.reason} |`,
    );
  }
  lines.push(
    '',
    '## Low 逐条人工审核队列',
    '',
    '以下项目在人工确认前不写入 `auto_verified`。候选顺序只代表当前规则排序，不代表已确认。',
    '',
    '| # | 赛季 | Understat id | Understat 名称 | Understat 球队 | 当前候选 FPL | code | 原因 | 分数 | 其他候选 |',
    '| ---: | --- | ---: | --- | --- | --- | ---: | --- | ---: | --- |',
  );
  lowConfidence.forEach((decision, index) => {
    const alternatives = decision.candidates
      .slice(1)
      .map((candidate) => `${candidate.name} (${candidate.playerCode})`)
      .join('; ');
    lines.push(
      `| ${index + 1} | ${decision.season} | ${decision.understatPlayerId} | ${decision.understatName} | ${decision.understatTeam} | ${decision.fpl ? fplNameForOutput(decision.fpl) : '-'} | ${decision.fpl?.playerCode ?? '-'} | ${decision.reason} | ${decision.score ?? '-'} | ${alternatives || '-'} |`,
    );
  });
  lines.push(
    '',
    '## 数据范围说明',
    '',
    '- Understat 1415、1516 各有完整 Understat player-season 数据，但当前 repo 的 FPL history archive 没有这两个赛季；因此不是“未匹配”，而是 `fpl-history-unavailable`，不能凭空创建关联。',
    '- 该日志只记录身份映射，不改变 Understat canonical tables，也不把映射写入 FPL current tables。',
  );
  return `${lines.join('\n')}\n`;
}

function quarantineGlobalFplConflicts(
  acceptedPairs: Map<string, AcceptedPair>,
): Array<{ playerCode: number; understatPlayerIds: number[] }> {
  const byFplCode = new Map<number, AcceptedPair[]>();
  for (const pair of acceptedPairs.values()) {
    const current = byFplCode.get(pair.playerCode) ?? [];
    current.push(pair);
    byFplCode.set(pair.playerCode, current);
  }
  const conflicts = [...byFplCode]
    .filter(([, pairs]) => new Set(pairs.map((pair) => pair.understatPlayerId)).size > 1)
    .map(([playerCode, pairs]) => ({
      playerCode,
      pairs,
    }));
  for (const conflict of conflicts) {
    for (const pair of conflict.pairs) {
      acceptedPairs.delete(`${pair.understatPlayerId}:${pair.playerCode}`);
      for (const decision of pair.decisions) {
        decision.kind = 'ambiguous';
        decision.confidence = 'low';
        decision.reason = `global-fpl-code-conflict:${conflict.playerCode}`;
      }
    }
  }
  return conflicts.map(({ playerCode, pairs }) => ({
    playerCode,
    understatPlayerIds: pairs
      .map((pair) => pair.understatPlayerId)
      .sort((left, right) => left - right),
  }));
}

function refreshReports(
  reports: Array<Record<string, unknown>>,
  decisions: readonly Decision[],
): void {
  for (const report of reports) {
    const season = report.season;
    const seasonDecisions = decisions.filter((decision) => decision.season === season);
    if (seasonDecisions.length === 0) continue;
    const summary = summarize(seasonDecisions);
    Object.assign(report, summary);
  }
}

async function writeAccepted(acceptedPairs: ReadonlyMap<string, AcceptedPair>): Promise<void> {
  const client = await getDbClient();
  await client.begin(async (transaction) => {
    const payload = [...acceptedPairs.values()].flatMap((pair) => {
      const decisions = pair.decisions;
      const firstDecision = decisions[0];
      const fpl = firstDecision?.fpl;
      if (!firstDecision || !fpl) return [];
      const confirmedSeasons = [...pair.seasons].sort(
        (left, right) => seasonNumber(left) - seasonNumber(right),
      );
      const manuallyVerified = decisions.some((decision) => decision.verification === 'manual');
      const evidence = {
        fplName: fplNameForOutput(fpl),
        fplPlayerId: fpl.playerId,
        understatName: firstDecision.understatName,
        confirmedSeasons,
        decisionKinds: [...new Set(decisions.map((decision) => decision.kind))],
        observedNames: [...new Set(decisions.map((decision) => decision.understatName))],
        manualConfirmedSeasons: [
          ...new Set(
            decisions
              .filter((decision) => decision.verification === 'manual')
              .map((decision) => decision.season),
          ),
        ].sort((left, right) => seasonNumber(left) - seasonNumber(right)),
        ruleVersion: RULE_VERSION,
      };
      return [
        {
          id: crypto.randomUUID(),
          left_entity_id: String(pair.understatPlayerId),
          right_entity_id: String(pair.playerCode),
          status: manuallyVerified ? 'manual_verified' : 'auto_verified',
          method: manuallyVerified
            ? 'season-name-reconciliation-manual'
            : 'season-name-reconciliation',
          rule_version: RULE_VERSION,
          evidence,
          first_seen_season: confirmedSeasons[0],
          last_seen_season: confirmedSeasons.at(-1),
          reviewed_by: manuallyVerified ? 'user-confirmed' : null,
          reviewed_at: manuallyVerified ? new Date().toISOString() : null,
        },
      ];
    });
    if (payload.length === 0) return;
    await transaction`
      INSERT INTO public.provider_entity_links (
        id,
        entity_type,
        left_provider,
        left_entity_id,
        right_provider,
        right_entity_id,
        status,
        method,
        rule_version,
        evidence,
        first_seen_season,
        last_seen_season,
        reviewed_by,
        reviewed_at,
        created_at,
        updated_at
      )
      SELECT
        input.id::uuid,
        'player',
        'understat',
        input.left_entity_id,
        'fpl',
        input.right_entity_id,
        input.status::provider_link_status,
        input.method,
        input.rule_version,
        input.evidence,
        input.first_seen_season,
        input.last_seen_season,
        input.reviewed_by,
        input.reviewed_at::timestamptz,
        now(),
        now()
      FROM jsonb_to_recordset(${JSON.stringify(payload)}::jsonb) AS input(
        id text,
        left_entity_id text,
        right_entity_id text,
        status text,
        method text,
        rule_version text,
        evidence jsonb,
        first_seen_season text,
        last_seen_season text,
        reviewed_by text,
        reviewed_at text
      )
      ON CONFLICT (entity_type, left_provider, left_entity_id, right_provider, right_entity_id)
      DO UPDATE SET
        status = CASE
          WHEN EXCLUDED.status = 'manual_verified' THEN 'manual_verified'::provider_link_status
          ELSE 'auto_verified'::provider_link_status
        END,
        method = EXCLUDED.method,
        rule_version = EXCLUDED.rule_version,
        evidence = EXCLUDED.evidence,
        first_seen_season = LEAST(provider_entity_links.first_seen_season, EXCLUDED.first_seen_season),
        last_seen_season = GREATEST(provider_entity_links.last_seen_season, EXCLUDED.last_seen_season),
        reviewed_by = CASE
          WHEN EXCLUDED.status = 'manual_verified' THEN EXCLUDED.reviewed_by
          ELSE NULL
        END,
        reviewed_at = CASE
          WHEN EXCLUDED.status = 'manual_verified' THEN EXCLUDED.reviewed_at
          ELSE NULL
        END,
        updated_at = now()
    `;
  });
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const applyHigh = process.argv.includes('--apply-high');
  const { fpl, understat } = await loadRows();
  const manualApprovals = mergeManualApprovals(
    await loadPersistedManualApprovals(),
    parseManualApprovals(),
  );
  const fplBySeason = new Map<Season, FplPlayerRow[]>();
  const understatBySeason = new Map<Season, UnderstatPlayerRow[]>();
  for (const season of SEASONS) {
    fplBySeason.set(
      season,
      fpl.filter((row) => row.season === season),
    );
    understatBySeason.set(
      season,
      understat.filter((row) => row.season === season),
    );
  }

  const priorPairs = new Map<number, AcceptedPair>();
  const allAccepted = new Map<string, AcceptedPair>();
  const allDecisions: Decision[] = [];
  const reports: Array<Record<string, unknown>> = [];

  for (const season of SEASONS) {
    const fplRows = fplBySeason.get(season) ?? [];
    const understatRows = understatBySeason.get(season) ?? [];
    if (fplRows.length === 0) {
      reports.push({
        season,
        fplPlayers: 0,
        understatPlayers: understatRows.length,
        status: 'fpl-history-unavailable',
      });
      continue;
    }

    const result = buildSeasonDecisions(season, fplRows, understatRows, priorPairs);
    applyManualApprovals(result, season, fplRows, manualApprovals);
    allDecisions.push(...result.decisions);
    for (const accepted of result.accepted) {
      const existingPrior = priorPairs.get(accepted.understatPlayerId);
      if (existingPrior && existingPrior.playerCode !== accepted.playerCode) {
        throw new Error(
          `Cross-season identity conflict for Understat ${accepted.understatPlayerId}: ` +
            `${existingPrior.playerCode} vs ${accepted.playerCode} in ${season}; ` +
            `prior=${existingPrior.decisions.map((decision) => `${decision.season}:${decision.fpl?.playerCode ?? 'none'}:${decision.kind}`).join(',')}; ` +
            `current=${accepted.decisions.map((decision) => `${decision.season}:${decision.fpl?.playerCode ?? 'none'}:${decision.kind}`).join(',')}`,
        );
      }
      const prior =
        existingPrior ??
        ({
          understatPlayerId: accepted.understatPlayerId,
          playerCode: accepted.playerCode,
          seasons: new Set<Season>(),
          decisions: [],
        } satisfies AcceptedPair);
      prior.seasons.add(season);
      prior.decisions.push(...accepted.decisions);
      priorPairs.set(accepted.understatPlayerId, prior);
      const pairKey = `${accepted.understatPlayerId}:${accepted.playerCode}`;
      allAccepted.set(pairKey, prior);
    }
    reports.push({ season, fplPlayers: fplRows.length, ...summarize(result.decisions) });
  }

  const globalFplConflicts = quarantineGlobalFplConflicts(allAccepted);
  refreshReports(reports, allDecisions);
  const lowConfidence = allDecisions.filter((decision) => decision.confidence === 'low');
  const highNonExact = allDecisions.filter((decision) => decision.kind === 'name-variant');
  const lowConfidenceOutput = process.argv.includes('--all')
    ? lowConfidence
    : lowConfidence.slice(0, 20);
  if (apply || applyHigh) {
    if (lowConfidence.length > 0) {
      if (apply) {
        throw new Error(`Refusing --apply with ${lowConfidence.length} low-confidence decisions`);
      }
    }
    await writeAccepted(allAccepted);
  }

  if (process.argv.includes('--write-audit')) {
    await writeFile(
      'docs/understat-fpl-player-mapping-audit.md',
      renderAudit(reports, allDecisions, lowConfidence),
      'utf8',
    );
  }

  console.log(
    JSON.stringify(
      {
        mode: apply ? 'apply' : applyHigh ? 'apply-high' : 'dry-run',
        ruleVersion: RULE_VERSION,
        reports,
        acceptedPairs: allAccepted.size,
        manualApprovalCount: manualApprovals.length,
        manualVerifiedCount: allDecisions.filter((decision) => decision.verification === 'manual')
          .length,
        globalFplConflicts,
        lowConfidenceCount: lowConfidence.length,
        highNonExactCount: highNonExact.length,
        lowConfidenceShown: lowConfidenceOutput.length,
        lowConfidenceTruncated: lowConfidenceOutput.length < lowConfidence.length,
        lowConfidence: lowConfidenceOutput.map((decision) => ({
          season: decision.season,
          understatPlayerId: decision.understatPlayerId,
          understatName: decision.understatName,
          understatTeam: decision.understatTeam,
          fplName: decision.fpl ? fplNameForOutput(decision.fpl) : null,
          fplCode: decision.fpl?.playerCode ?? null,
          reason: decision.reason,
          score: decision.score,
          candidates: decision.candidates,
        })),
        highNonExactSample: highNonExact.slice(0, 40).map((decision) => ({
          season: decision.season,
          understatPlayerId: decision.understatPlayerId,
          understatName: decision.understatName,
          fplName: decision.fpl ? fplNameForOutput(decision.fpl) : null,
          fplCode: decision.fpl?.playerCode ?? null,
          reason: decision.reason,
          score: decision.score,
        })),
      },
      null,
      2,
    ),
  );
}

try {
  await main();
} finally {
  await databaseSingleton.disconnect();
}
