import type {
  UnderstatLeagueResponse,
  UnderstatMatchDate,
  UnderstatMatchResponse,
  UnderstatPlayerSummary,
  UnderstatRosterEntry,
  UnderstatTeamHistory,
  UnderstatTeamResponse,
} from '../clients/understat';
import type {
  UnderstatMatch,
  UnderstatPlayer,
  UnderstatPlayerDiscovery,
  UnderstatPlayerMatchStat,
  UnderstatPlayerSeason,
  UnderstatPlayerStats,
  UnderstatPlayerTeamSeason,
  UnderstatSeason,
  UnderstatTeam,
  UnderstatTeamDiscovery,
  UnderstatTeamMatchStat,
  UnderstatTeamSeason,
  UnderstatTeamStatSplit,
  UnderstatSplitDimension,
} from '../domain/understat';
import { UNDERSTAT_SPLIT_DIMENSIONS } from '../domain/understat';
import { contentHash } from '../utils/content-hash';

function parseUnderstatUtc(value: string): Date {
  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(normalized);
  const date = new Date(hasTimezone ? normalized : `${normalized}Z`);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`Invalid Understat datetime: ${value}`);
  }
  return date;
}

function hashWithoutSource<T extends object>(value: T): string {
  return contentHash(value);
}

function transformMatch(season: string, raw: UnderstatMatchDate, seenAt: Date): UnderstatMatch {
  const source = {
    id: raw.id,
    season,
    homeTeamId: raw.h.id,
    awayTeamId: raw.a.id,
    kickoffAt: parseUnderstatUtc(raw.datetime),
    isResult: raw.isResult,
    homeGoals: raw.goals.h,
    awayGoals: raw.goals.a,
    homeXg: raw.xG.h,
    awayXg: raw.xG.a,
    forecastHomeWin: raw.forecast.w,
    forecastDraw: raw.forecast.d,
    forecastAwayWin: raw.forecast.l,
  };
  return {
    ...source,
    sourceHash: hashWithoutSource(source),
    sourceCheckedAt: seenAt,
    lastSeenAt: seenAt,
  };
}

function shortTitlesByTeamId(dates: UnderstatMatchDate[]): Map<number, string> {
  const result = new Map<number, string>();
  for (const date of dates) {
    if (date.h.short_title) result.set(date.h.id, date.h.short_title);
    if (date.a.short_title) result.set(date.a.id, date.a.short_title);
  }
  return result;
}

function transformTeams(season: string, response: UnderstatLeagueResponse): UnderstatTeam[] {
  const shortTitles = shortTitlesByTeamId(response.dates);
  return Object.values(response.teams)
    .map((raw) => {
      const base = {
        id: raw.id,
        title: raw.title,
        shortTitle: shortTitles.get(raw.id) ?? null,
        firstSeenSeason: season,
        lastSeenSeason: season,
      };
      return { ...base, sourceHash: hashWithoutSource(base) };
    })
    .sort((left, right) => left.id - right.id);
}

function matchingHistoryMatch(
  teamId: number,
  history: UnderstatTeamHistory,
  matches: UnderstatMatch[],
): UnderstatMatch {
  const expectedKickoff = parseUnderstatUtc(history.date).getTime();
  const candidates = matches.filter((match) => {
    const isHome = match.homeTeamId === teamId;
    const isAway = match.awayTeamId === teamId;
    if ((history.h_a === 'h' && !isHome) || (history.h_a === 'a' && !isAway)) return false;
    if (match.kickoffAt.getTime() !== expectedKickoff) return false;
    const scored = isHome ? match.homeGoals : match.awayGoals;
    const missed = isHome ? match.awayGoals : match.homeGoals;
    return scored === history.scored && missed === history.missed;
  });

  if (candidates.length !== 1) {
    throw new Error(
      `Understat team history did not map uniquely: team=${teamId} date=${history.date} side=${history.h_a} candidates=${candidates.length}`,
    );
  }
  return candidates[0];
}

function transformTeamHistory(
  teamId: number,
  history: UnderstatTeamHistory,
  matches: UnderstatMatch[],
): UnderstatTeamMatchStat {
  const match = matchingHistoryMatch(teamId, history, matches);
  const base = {
    matchId: match.id,
    teamId,
    side: history.h_a,
    xg: history.xG,
    xga: history.xGA,
    npxg: history.npxG,
    npxga: history.npxGA,
    npxgd: history.npxGD,
    ppdaAtt: history.ppda.att,
    ppdaDef: history.ppda.def,
    ppdaAllowedAtt: history.ppda_allowed.att,
    ppdaAllowedDef: history.ppda_allowed.def,
    deep: history.deep,
    deepAllowed: history.deep_allowed,
    scored: history.scored,
    missed: history.missed,
    xpoints: history.xpts,
    result: history.result,
    points: history.pts,
    wins: history.wins,
    draws: history.draws,
    losses: history.loses,
  };
  return { ...base, sourceHash: hashWithoutSource(base) };
}

export function aggregateUnderstatTeamSeason(
  season: string,
  team: Pick<UnderstatTeam, 'id' | 'title' | 'shortTitle'>,
  rows: UnderstatTeamMatchStat[],
  syncedAt: Date,
): UnderstatTeamSeason {
  const base = rows.reduce(
    (summary, row) => ({
      ...summary,
      games: summary.games + 1,
      wins: summary.wins + row.wins,
      draws: summary.draws + row.draws,
      losses: summary.losses + row.losses,
      goalsFor: summary.goalsFor + row.scored,
      goalsAgainst: summary.goalsAgainst + row.missed,
      points: summary.points + row.points,
      xg: summary.xg + row.xg,
      xga: summary.xga + row.xga,
      npxg: summary.npxg + row.npxg,
      npxga: summary.npxga + row.npxga,
      npxgd: summary.npxgd + row.npxgd,
      xpoints: summary.xpoints + row.xpoints,
      deep: summary.deep + row.deep,
      deepAllowed: summary.deepAllowed + row.deepAllowed,
      ppdaAtt: summary.ppdaAtt + row.ppdaAtt,
      ppdaDef: summary.ppdaDef + row.ppdaDef,
      ppdaAllowedAtt: summary.ppdaAllowedAtt + row.ppdaAllowedAtt,
      ppdaAllowedDef: summary.ppdaAllowedDef + row.ppdaAllowedDef,
    }),
    {
      season,
      teamId: team.id,
      sourceTitle: team.title,
      sourceShortTitle: team.shortTitle,
      games: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      goalsFor: 0,
      goalsAgainst: 0,
      points: 0,
      xg: 0,
      xga: 0,
      npxg: 0,
      npxga: 0,
      npxgd: 0,
      xpoints: 0,
      deep: 0,
      deepAllowed: 0,
      ppdaAtt: 0,
      ppdaDef: 0,
      ppdaAllowedAtt: 0,
      ppdaAllowedDef: 0,
    },
  );
  return {
    ...base,
    sourceHash: hashWithoutSource(base),
    lastSyncedAt: syncedAt,
  };
}

function transformPlayerStats(raw: UnderstatPlayerSummary): UnderstatPlayerStats {
  return {
    games: raw.games,
    time: raw.time,
    goals: raw.goals,
    npg: raw.npg,
    assists: raw.assists,
    shots: raw.shots,
    keyPasses: raw.key_passes,
    yellowCards: raw.yellow_cards,
    redCards: raw.red_cards,
    xg: raw.xG,
    npxg: raw.npxG,
    xa: raw.xA,
    xgChain: raw.xGChain,
    xgBuildup: raw.xGBuildup,
    position: raw.position,
  };
}

function seasonRecord(
  season: string,
  sourceYear: number,
  league: string,
  now: Date,
): UnderstatSeason {
  return {
    season,
    sourceYear,
    league,
    state: 'active',
    firstSeenAt: now,
    lastSeenAt: now,
  };
}

export function transformUnderstatTeamDiscovery(
  season: string,
  sourceYear: number,
  league: string,
  response: UnderstatLeagueResponse,
  now = new Date(),
): UnderstatTeamDiscovery {
  const matches = response.dates
    .map((date) => transformMatch(season, date, now))
    .sort((left, right) => left.id - right.id);
  const teams = transformTeams(season, response);
  const teamMatchStats = Object.values(response.teams)
    .flatMap((team) =>
      team.history.map((history) => transformTeamHistory(team.id, history, matches)),
    )
    .sort((left, right) => left.matchId - right.matchId || left.teamId - right.teamId);
  for (const match of matches.filter((candidate) => candidate.isResult)) {
    const rows = teamMatchStats.filter((row) => row.matchId === match.id);
    const identities = new Set(rows.map((row) => `${row.teamId}:${row.side}`));
    if (
      rows.length !== 2 ||
      identities.size !== 2 ||
      !identities.has(`${match.homeTeamId}:h`) ||
      !identities.has(`${match.awayTeamId}:a`)
    ) {
      throw new Error(
        `Understat completed match ${match.id} does not contain exactly two team history rows`,
      );
    }
  }
  const teamSeasons = teams.map((team) =>
    aggregateUnderstatTeamSeason(
      season,
      team,
      teamMatchStats.filter((row) => row.teamId === team.id),
      now,
    ),
  );

  return {
    season: seasonRecord(season, sourceYear, league, now),
    teams,
    matches,
    teamMatchStats,
    teamSeasons,
  };
}

export function transformUnderstatPlayerDiscovery(
  season: string,
  sourceYear: number,
  league: string,
  response: UnderstatLeagueResponse,
  now = new Date(),
): UnderstatPlayerDiscovery {
  const players = response.players
    .map((raw) => {
      const base = {
        id: raw.id,
        name: raw.player_name,
        favoritePosition: null,
        firstSeenSeason: season,
        lastSeenSeason: season,
      };
      return { ...base, sourceHash: hashWithoutSource(base) };
    })
    .sort((left, right) => left.id - right.id);
  const playerSeasons = response.players
    .map((raw): UnderstatPlayerSeason => {
      const base = {
        season,
        playerId: raw.id,
        sourceName: raw.player_name,
        sourceTeamTitle: raw.team_title,
        ...transformPlayerStats(raw),
      };
      return { ...base, sourceHash: hashWithoutSource(base) };
    })
    .sort((left, right) => left.playerId - right.playerId);

  return {
    season: seasonRecord(season, sourceYear, league, now),
    teams: transformTeams(season, response),
    matches: response.dates
      .map((date) => transformMatch(season, date, now))
      .sort((left, right) => left.id - right.id),
    players,
    playerSeasons,
  };
}

function validateTeamPageIdentity(
  response: UnderstatTeamResponse,
  expectedTeamId: number,
  knownMatchIds?: ReadonlySet<number>,
): void {
  for (const date of response.dates) {
    if (!date.side) {
      throw new Error(`Understat team date ${date.id} is missing side`);
    }
    const selectedTeamId = date.side === 'h' ? date.h.id : date.a.id;
    if (selectedTeamId !== expectedTeamId) {
      throw new Error(
        `Understat team page identity mismatch: expected=${expectedTeamId} actual=${selectedTeamId}`,
      );
    }
    if (knownMatchIds && !knownMatchIds.has(date.id)) {
      throw new Error(`Understat team page returned unknown match ${date.id}`);
    }
  }
}

export function validateUnderstatTeamDates(
  response: UnderstatTeamResponse,
  expectedTeamId: number,
  leagueMatches: readonly UnderstatMatch[],
): void {
  const matchesById = new Map(leagueMatches.map((match) => [match.id, match]));
  validateTeamPageIdentity(response, expectedTeamId, new Set(matchesById.keys()));
  const responseMatchIds = new Set(response.dates.map((date) => date.id));
  if (responseMatchIds.size !== response.dates.length) {
    throw new Error(`Understat team page ${expectedTeamId} contains duplicate match IDs`);
  }
  const missingMatchIds = leagueMatches
    .filter((match) => match.homeTeamId === expectedTeamId || match.awayTeamId === expectedTeamId)
    .map((match) => match.id)
    .filter((matchId) => !responseMatchIds.has(matchId));
  if (missingMatchIds.length > 0) {
    throw new Error(
      `Understat team page ${expectedTeamId} is missing league matches: ${missingMatchIds.join(', ')}`,
    );
  }

  for (const date of response.dates) {
    const match = matchesById.get(date.id);
    if (!match) {
      throw new Error(`Understat team page returned unknown match ${date.id}`);
    }
    const kickoff = parseUnderstatUtc(date.datetime);
    const differs =
      date.h.id !== match.homeTeamId ||
      date.a.id !== match.awayTeamId ||
      kickoff.getTime() !== match.kickoffAt.getTime() ||
      date.isResult !== match.isResult ||
      date.goals.h !== match.homeGoals ||
      date.goals.a !== match.awayGoals ||
      date.xG.h !== match.homeXg ||
      date.xG.a !== match.awayXg;
    if (differs) {
      throw new Error(
        `Understat team page match differs from league snapshot: team=${expectedTeamId} match=${date.id}`,
      );
    }
  }
}

export function transformUnderstatTeamSplits(
  season: string,
  teamId: number,
  response: UnderstatTeamResponse,
  knownMatchIds?: ReadonlySet<number>,
): UnderstatTeamStatSplit[] {
  validateTeamPageIdentity(response, teamId, knownMatchIds);
  const rows: UnderstatTeamStatSplit[] = [];
  for (const dimension of UNDERSTAT_SPLIT_DIMENSIONS) {
    const values = response.statistics[dimension];
    for (const [splitKey, raw] of Object.entries(values)) {
      const base = {
        season,
        teamId,
        dimension: dimension as UnderstatSplitDimension,
        splitKey,
        label: raw.stat ?? null,
        timeMinutes: raw.time ?? null,
        shotsFor: raw.shots,
        goalsFor: raw.goals,
        xgFor: raw.xG,
        shotsAgainst: raw.against.shots,
        goalsAgainst: raw.against.goals,
        xgAgainst: raw.against.xG,
      };
      rows.push({ ...base, sourceHash: hashWithoutSource(base) });
    }
  }
  return rows.sort(
    (left, right) =>
      left.dimension.localeCompare(right.dimension) || left.splitKey.localeCompare(right.splitKey),
  );
}

export function transformUnderstatTeamParticipants(
  season: string,
  teamId: number,
  response: UnderstatTeamResponse,
  knownMatchIds?: ReadonlySet<number>,
): { players: UnderstatPlayer[]; playerTeamSeasons: UnderstatPlayerTeamSeason[] } {
  validateTeamPageIdentity(response, teamId, knownMatchIds);
  const players = response.players.map((raw) => {
    const base = {
      id: raw.id,
      name: raw.player_name,
      favoritePosition: null,
      firstSeenSeason: season,
      lastSeenSeason: season,
    };
    return { ...base, sourceHash: hashWithoutSource(base) };
  });
  const playerTeamSeasons = response.players.map((raw): UnderstatPlayerTeamSeason => {
    const base = {
      season,
      playerId: raw.id,
      teamId,
      ...transformPlayerStats(raw),
    };
    return { ...base, sourceHash: hashWithoutSource(base) };
  });
  return {
    players: players.sort((left, right) => left.id - right.id),
    playerTeamSeasons: playerTeamSeasons.sort((left, right) => left.playerId - right.playerId),
  };
}

function nullableRosterLink(value: number): number | null {
  return value === 0 ? null : value;
}

function transformRosterEntry(
  match: UnderstatMatch,
  raw: UnderstatRosterEntry,
): { player: UnderstatPlayer; stat: UnderstatPlayerMatchStat } {
  const expectedTeamId = raw.h_a === 'h' ? match.homeTeamId : match.awayTeamId;
  if (raw.team_id !== expectedTeamId) {
    throw new Error(
      `Understat roster team mismatch: match=${match.id} side=${raw.h_a} expected=${expectedTeamId} actual=${raw.team_id}`,
    );
  }
  const playerBase = {
    id: raw.player_id,
    name: raw.player,
    favoritePosition: null,
    firstSeenSeason: match.season,
    lastSeenSeason: match.season,
  };
  const statBase = {
    rosterId: raw.id,
    matchId: match.id,
    playerId: raw.player_id,
    teamId: raw.team_id,
    playerName: raw.player,
    side: raw.h_a,
    position: raw.position,
    positionOrder: raw.positionOrder,
    minutes: raw.time,
    started: raw.position !== 'Sub',
    goals: raw.goals,
    ownGoals: raw.own_goals,
    shots: raw.shots,
    keyPasses: raw.key_passes,
    assists: raw.assists,
    yellowCards: raw.yellow_card,
    redCards: raw.red_card,
    xg: raw.xG,
    xa: raw.xA,
    xgChain: raw.xGChain,
    xgBuildup: raw.xGBuildup,
    rosterInId: nullableRosterLink(raw.roster_in),
    rosterOutId: nullableRosterLink(raw.roster_out),
  };
  return {
    player: { ...playerBase, sourceHash: hashWithoutSource(playerBase) },
    stat: { ...statBase, sourceHash: hashWithoutSource(statBase) },
  };
}

export function transformUnderstatMatchRoster(
  match: UnderstatMatch,
  response: UnderstatMatchResponse,
): { players: UnderstatPlayer[]; stats: UnderstatPlayerMatchStat[] } {
  const entries: UnderstatRosterEntry[] = [];
  for (const side of ['h', 'a'] as const) {
    for (const [rosterKey, entry] of Object.entries(response.rosters[side])) {
      if (entry.h_a !== side) {
        throw new Error(`Understat match ${match.id} rosters.${side} contains side=${entry.h_a}`);
      }
      if (Number(rosterKey) !== entry.id) {
        throw new Error(
          `Understat match ${match.id} roster key ${rosterKey} differs from ID ${entry.id}`,
        );
      }
      entries.push(entry);
    }
  }
  const transformed = entries.map((entry) => transformRosterEntry(match, entry));
  const rosterIds = new Set(transformed.map(({ stat }) => stat.rosterId));
  if (rosterIds.size !== transformed.length) {
    throw new Error(`Understat match ${match.id} contains duplicate roster IDs`);
  }
  for (const side of ['h', 'a'] as const) {
    const sideRows = transformed.filter(({ stat }) => stat.side === side);
    if (sideRows.length === 0) throw new Error(`Understat match ${match.id} has no ${side} roster`);
    const playerIds = new Set(sideRows.map(({ stat }) => stat.playerId));
    if (playerIds.size !== sideRows.length) {
      throw new Error(`Understat match ${match.id} contains duplicate ${side} player IDs`);
    }
    const starters = sideRows.filter(({ stat }) => stat.started);
    if (starters.length !== 11) {
      throw new Error(
        `Understat match ${match.id} ${side} roster has ${starters.length} starters instead of 11`,
      );
    }
  }
  const playersById = new Map<number, UnderstatPlayer>();
  for (const { player } of transformed) playersById.set(player.id, player);
  return {
    players: [...playersById.values()].sort((left, right) => left.id - right.id),
    stats: transformed
      .map(({ stat }) => stat)
      .sort((left, right) => left.rosterId - right.rosterId),
  };
}

export function findUnderstatRosterAggregateDifferences(
  match: UnderstatMatch,
  stats: readonly UnderstatPlayerMatchStat[],
): string[] {
  const differences: string[] = [];
  for (const side of ['h', 'a'] as const) {
    const opponent = side === 'h' ? 'a' : 'h';
    const expectedGoals = side === 'h' ? match.homeGoals : match.awayGoals;
    const expectedXg = side === 'h' ? match.homeXg : match.awayXg;
    const sideRows = stats.filter((row) => row.side === side);
    const opponentRows = stats.filter((row) => row.side === opponent);
    const rosterGoals =
      sideRows.reduce((sum, row) => sum + row.goals, 0) +
      opponentRows.reduce((sum, row) => sum + row.ownGoals, 0);
    const rosterXg = sideRows.reduce((sum, row) => sum + row.xg, 0);
    if (expectedGoals !== null && rosterGoals !== expectedGoals) {
      differences.push(`${side}:goals expected=${expectedGoals} roster=${rosterGoals}`);
    }
    if (expectedXg !== null && Math.abs(rosterXg - expectedXg) > 0.000001) {
      differences.push(`${side}:xg expected=${expectedXg} roster=${rosterXg}`);
    }
  }
  return differences;
}
