import { z } from 'zod';

import { ValidationError } from '../utils/errors';

export const MAX_RANK = 2147483647;

const FPL_HOSTNAME = 'fantasy.premierleague.com';

const gameweekSchema = z.string().regex(/^GW(?:[1-9]|[12]\d|3[0-8])$/i);
const optionalPositiveIntegerStringSchema = z.union([
  z.literal(''),
  z.string().regex(/^[1-9]\d*$/),
]);

export const tournamentCreateInputSchema = z
  .object({
    tournamentName: z.string().trim().min(3).max(80),
    adminId: z.string().regex(/^\d+$/),
    creator: z.string().trim().min(1).max(80),
    // Service-attested account role. The public browser never writes this
    // field directly; authenticated Web commands default to false.
    platformAdmin: z.boolean().optional(),
    participantSource: z.enum(['official', 'custom']),
    tournamentType: z.literal('standard').optional(),
    leagueUrl: z
      .string()
      .max(512)
      .url()
      .refine((value) => {
        const url = new URL(value);
        return url.protocol === 'https:' && url.hostname === FPL_HOSTNAME;
      }, 'Only secure Fantasy Premier League URLs are allowed.'),
    groupFormat: z.enum(['none', 'points']),
    startGameweek: gameweekSchema,
    endGameweek: gameweekSchema,
    groupNum: optionalPositiveIntegerStringSchema.optional(),
    qualifiersPerGroup: optionalPositiveIntegerStringSchema.optional(),
    knockoutFormat: z.enum(['none', 'single', 'double']),
    selectedParticipantIds: z
      .array(z.string().regex(/^[1-9]\d*$/))
      .max(5000)
      .optional(),
    // Additive field used by the Web preview flow. Older clients may omit it
    // during the rolling deployment window and keep the legacy synchronous
    // roster fetch path.
    previewToken: z.string().min(32).max(128).optional(),
  })
  .superRefine((values, context) => {
    const startGameweek = parseGameweek(values.startGameweek);
    const endGameweek = parseGameweek(values.endGameweek);
    if (!startGameweek || !endGameweek || endGameweek < startGameweek) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endGameweek'],
        message: 'End gameweek must be on or after the start gameweek.',
      });
    }
    if (values.groupFormat === 'points' && !values.groupNum) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['groupNum'],
        message: 'Group number is required for a points race.',
      });
    }
    if (
      values.groupFormat === 'points' &&
      values.knockoutFormat !== 'none' &&
      !values.qualifiersPerGroup
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['qualifiersPerGroup'],
        message: 'Qualifiers per group are required for a knockout phase.',
      });
    }
  });

export type TournamentCreateInput = z.infer<typeof tournamentCreateInputSchema>;
export type TournamentSetupStatus = 'pending' | 'processing' | 'ready' | 'failed';
export type TournamentSetupPhase =
  | 'queued'
  | 'syncing_entries'
  | 'building_structure'
  | 'calculating_standings'
  | 'enriching_history'
  | 'finalizing'
  | 'ready'
  | 'failed';
export type TournamentRosterMode = 'snapshot' | 'official_sync';
export type LeagueType = 'classic' | 'h2h';

export function validateTournamentCreateInput(data: unknown): TournamentCreateInput {
  return tournamentCreateInputSchema.parse(data);
}

export function safeValidateTournamentCreateInput(data: unknown): TournamentCreateInput | null {
  const result = tournamentCreateInputSchema.safeParse(data);
  return result.success ? result.data : null;
}

export type GroupMode = 'no_group' | 'points_races' | 'battle_races';
export type KnockoutMode =
  | 'no_knockout'
  | 'single_elimination'
  | 'double_elimination'
  | 'head_to_head';

export type TournamentParticipant = {
  id: string;
  team: string;
  manager: string;
  overallRank: number;
  totalPoints: number;
};

export type RawStandingsResult = {
  entry?: number | null;
  entry_name?: string;
  player_name?: string;
  player_first_name?: string;
  player_last_name?: string;
  rank?: number | string | null;
  rank_sort?: number | string | null;
  total?: number | string | null;
};

export type TournamentConfig = {
  id: number;
  leagueId?: number;
  leagueType?: LeagueType;
  rosterMode?: TournamentRosterMode;
  totalTeamNum: number;
  groupMode: GroupMode;
  groupNum: number | null;
  groupStartedEventId: number | null;
  groupEndedEventId: number | null;
  groupQualifyNum: number | null;
  knockoutMode: KnockoutMode;
  knockoutTeamNum: number | null;
  knockoutEventNum: number | null;
  knockoutStartedEventId: number | null;
  knockoutEndedEventId: number | null;
  knockoutPlayAgainstNum: number | null;
};

/**
 * Minimal shape required by per-event sync services (points race, knockout).
 * Both `TournamentConfig` and `TournamentInfoSummary` satisfy this — they
 * agree on all of these fields but diverge elsewhere, so the sync services
 * only promise to read this subset.
 */
export type TournamentSyncContext = {
  id: number;
  leagueId?: number;
  leagueType?: LeagueType;
  rosterMode?: TournamentRosterMode;
  totalTeamNum: number;
  groupMode: GroupMode;
  groupStartedEventId: number | null;
  groupEndedEventId: number | null;
  groupQualifyNum: number | null;
  knockoutMode: KnockoutMode;
  knockoutTeamNum?: number | null;
  knockoutEventNum?: number | null;
  knockoutStartedEventId: number | null;
  knockoutEndedEventId: number | null;
  knockoutPlayAgainstNum?: number | null;
};

/** Exact standings publication selected by one event-results cascade. */
export type TournamentFinalizationTarget = {
  tournamentId: number;
  standingsReadyAt: string;
  /** Result evidence must be at least this fresh before terminal publication. */
  resultsFreshAfter?: string;
};

export type EntrySeed = {
  entryId: number;
  overallRank: number | null;
};

export type QualifiedEntry = {
  entryId: number;
  groupId: number;
  groupRank: number | null;
  overallRank: number | null;
};

export type KnockoutMatchRow = {
  tournament_id: number;
  round: number;
  started_event_id: number;
  ended_event_id: number;
  match_id: number;
  next_match_id: number | null;
  home_entry_id: number | null;
  away_entry_id: number | null;
};

export type KnockoutResultRow = {
  tournament_id: number;
  event_id: number;
  match_id: number;
  play_against_id: number;
  home_entry_id: number | null;
  away_entry_id: number | null;
};

export type TournamentBackfillWindow = {
  startEventId: number;
  endEventId: number;
};

export type TournamentSetupRequestEstimate = {
  unoptimizedColdStart: number;
  optimizedColdStartUpperBound: number;
  optimizedTransferHistoryRequests: number;
  coreStandingsBaseline: number;
};

export const estimateTournamentSetupRequests = (
  entryCount: number,
  eventCount: number,
): TournamentSetupRequestEstimate => {
  const entries = Math.max(0, Math.trunc(entryCount));
  const events = Math.max(0, Math.trunc(eventCount));
  return {
    unoptimizedColdStart: 2 * entries + events + 2 * entries * events,
    optimizedColdStartUpperBound: 3 * entries + events + entries * events,
    optimizedTransferHistoryRequests: entries,
    coreStandingsBaseline: 2 * entries,
  };
};

export function diffTournamentRoster(
  existingEntryIds: readonly number[],
  authoritativeEntryIds: readonly number[],
): { addedEntryIds: number[]; removedEntryIds: number[] } {
  const existing = [...new Set(existingEntryIds.filter((entryId) => entryId > 0))].sort(
    (left, right) => left - right,
  );
  const authoritative = [...new Set(authoritativeEntryIds.filter((entryId) => entryId > 0))].sort(
    (left, right) => left - right,
  );
  const existingSet = new Set(existing);
  const authoritativeSet = new Set(authoritative);
  return {
    addedEntryIds: authoritative.filter((entryId) => !existingSet.has(entryId)),
    removedEntryIds: existing.filter((entryId) => !authoritativeSet.has(entryId)),
  };
}

type OfficialH2HRosterRecoveryRecord = Pick<
  TournamentSyncContext,
  'leagueType' | 'rosterMode' | 'groupMode'
> & {
  state: 'active' | 'inactive' | 'finished';
  rosterSyncStatus: 'pending' | 'processing' | 'ready' | 'failed' | null;
  officialScheduleLockedAt: string | null;
};

/**
 * A live-gameweek roster repair is safe only for an official H2H mirror that
 * never locked or published its schedule. The caller must still prove that
 * the authoritative roster is additive before publishing it.
 */
export function isUnlockedOfficialH2HRosterRecoveryState(
  tournament: OfficialH2HRosterRecoveryRecord,
  expectedStatus: 'failed' | 'processing',
  hasResultRows: boolean,
): boolean {
  return (
    isOfficialH2HTournament(tournament) &&
    tournament.state === 'active' &&
    tournament.rosterSyncStatus === expectedStatus &&
    tournament.officialScheduleLockedAt === null &&
    !hasResultRows
  );
}

export function isAdditiveTournamentRosterRecovery(
  existingEntryIds: readonly number[],
  authoritativeEntryIds: readonly number[],
): boolean {
  return diffTournamentRoster(existingEntryIds, authoritativeEntryIds).removedEntryIds.length === 0;
}

export type SeedPair = { homeEntryId: number | null; awayEntryId: number | null };

export type TournamentStructurePlan = {
  leagueId: number;
  leagueType: LeagueType;
  sourceLeagueName?: string | null;
  rosterMode?: TournamentRosterMode;
  tournamentName: string;
  creator: string;
  adminEntryId: number;
  /** Canonical FPL snapshot used only to satisfy the administrator FK when
   * the platform administrator is not part of the tournament roster. */
  administratorEntry?: TournamentParticipant;
  selectedParticipants: TournamentParticipant[];
  groupMode: GroupMode;
  groupTeamNum: number;
  groupNum: number;
  groupAutoAverages: boolean;
  groupStartedEventId: number;
  groupEndedEventId: number;
  groupRounds: number;
  groupQualifyNum: number | null;
  knockoutMode: KnockoutMode;
  knockoutTeamNum: number | null;
  knockoutEventNum: number | null;
  knockoutRounds: number | null;
  knockoutStartedEventId: number | null;
  knockoutEndedEventId: number | null;
  knockoutPlayAgainstNum: number | null;
  previewPayloadFingerprint?: string | null;
};

const groupModeMap = {
  none: 'no_group',
  points: 'points_races',
} as const satisfies Record<'none' | 'points', GroupMode>;

const knockoutModeMap = {
  none: 'no_knockout',
  single: 'single_elimination',
  double: 'double_elimination',
} as const satisfies Record<'none' | 'single' | 'double', KnockoutMode>;

export const normalizeTournamentName = (value: string): string => value.trim();

export const uniqueParticipantIds = (ids: string[] | undefined): string[] =>
  Array.from(new Set((ids ?? []).filter((value) => value.trim().length > 0)));

export const toNonNegativeNumber = (value: string | number | null | undefined): number | null => {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value;
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  return null;
};

export const toOptionalPositiveInteger = (value?: string): number | null => {
  if (!value || value.trim().length === 0) {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }

  return parsed;
};

export const nextPowerOfTwo = (value: number): number => {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return 2 ** Math.ceil(Math.log2(value));
};

const buildBracketSeedOrder = (bracketSize: number): number[] => {
  let seedOrder = [1, 2];
  for (let size = 2; size < bracketSize; size *= 2) {
    const nextSize = size * 2;
    seedOrder = seedOrder.flatMap((seed) => [seed, nextSize + 1 - seed]);
  }
  return seedOrder;
};

const inferLeagueType = (segments: string[]): LeagueType => {
  const typeSurfaceIndex = segments.findIndex(
    (segment) => segment === 'standings' || segment === 'new-entries',
  );
  const suffix = typeSurfaceIndex >= 0 ? segments[typeSurfaceIndex + 1] : null;
  return suffix === 'h' || suffix === 'h2h' ? 'h2h' : 'classic';
};

export const parseLeagueUrl = (rawUrl: string): { leagueId: number; leagueType: LeagueType } => {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw new ValidationError(
      'Please enter a complete Fantasy Premier League URL.',
      'TOURNAMENT_LEAGUE_URL_INVALID',
    );
  }

  if (
    parsedUrl.protocol !== 'https:' ||
    parsedUrl.hostname !== FPL_HOSTNAME ||
    parsedUrl.port ||
    parsedUrl.username ||
    parsedUrl.password
  ) {
    throw new ValidationError(
      'Only URLs from fantasy.premierleague.com are allowed.',
      'TOURNAMENT_LEAGUE_URL_HOST_INVALID',
    );
  }

  const pathSegments = parsedUrl.pathname.split('/').filter(Boolean);
  const hasLocalePrefix = /^[a-z]{2}(?:-[a-z]{2})?$/i.test(pathSegments[0] ?? '');
  const leaguesIndex =
    pathSegments[0] === 'leagues' ? 0 : hasLocalePrefix && pathSegments[1] === 'leagues' ? 1 : -1;
  if (leaguesIndex < 0 || pathSegments.length < leaguesIndex + 3) {
    throw new ValidationError(
      'Unsupported league URL format.',
      'TOURNAMENT_LEAGUE_URL_FORMAT_INVALID',
    );
  }

  const surface = pathSegments[leaguesIndex + 2];
  if (!['standings', 'new-entries', 'admin', 'join'].includes(surface)) {
    throw new ValidationError(
      'Unsupported league URL format.',
      'TOURNAMENT_LEAGUE_URL_FORMAT_INVALID',
    );
  }
  const standingsSuffix =
    surface === 'standings' || surface === 'new-entries'
      ? pathSegments[leaguesIndex + 3]
      : undefined;
  if (standingsSuffix && !['c', 'classic', 'h', 'h2h'].includes(standingsSuffix.toLowerCase())) {
    throw new ValidationError(
      'Unsupported league standings type.',
      'TOURNAMENT_LEAGUE_URL_FORMAT_INVALID',
    );
  }

  const leagueId = Number(pathSegments[leaguesIndex + 1]);
  if (!Number.isSafeInteger(leagueId) || leagueId <= 0) {
    throw new ValidationError(
      'League ID could not be parsed from the URL.',
      'TOURNAMENT_LEAGUE_ID_INVALID',
    );
  }

  return {
    leagueId,
    leagueType: inferLeagueType(pathSegments.slice(leaguesIndex)),
  };
};

export const parseGameweek = (value?: string | null): number | null => {
  if (!value || value.trim().length === 0) {
    return null;
  }

  const match = value.match(/^GW(\d{1,2})$/i);
  if (!match) {
    return null;
  }

  const parsed = Number(match[1]);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 38 ? parsed : null;
};

export const mapStandingsResultToParticipant = (
  result: RawStandingsResult,
): TournamentParticipant | null => {
  const entryId = toNonNegativeNumber(result.entry);
  if (!entryId) {
    return null;
  }

  const team = result.entry_name?.trim();
  const manager =
    result.player_name?.trim() ||
    `${result.player_first_name ?? ''} ${result.player_last_name ?? ''}`.trim();

  return {
    id: String(entryId),
    team: team && team.length > 0 ? team : `Entry ${entryId}`,
    manager: manager.length > 0 ? manager : `Manager ${entryId}`,
    overallRank: toNonNegativeNumber(result.rank) ?? toNonNegativeNumber(result.rank_sort) ?? 0,
    totalPoints: toNonNegativeNumber(result.total) ?? 0,
  };
};

export const selectParticipants = (
  participantSource: 'official' | 'custom',
  participants: TournamentParticipant[],
  selectedIds: string[],
): TournamentParticipant[] => {
  if (participantSource === 'official') {
    return participants;
  }

  const selectedSet = new Set(selectedIds);
  return participants.filter((participant) => selectedSet.has(participant.id));
};

export const groupNameForIndex = (index: number): string => {
  if (index < 26) {
    return String.fromCharCode(65 + index);
  }
  return `Group ${index + 1}`;
};

export const sortEntrySeeds = (entries: readonly EntrySeed[]): EntrySeed[] =>
  [...entries].sort((left, right) => {
    const rankDiff = (left.overallRank ?? MAX_RANK) - (right.overallRank ?? MAX_RANK);
    if (rankDiff !== 0) {
      return rankDiff;
    }
    return left.entryId - right.entryId;
  });

export const sortQualifiedEntries = (entries: readonly QualifiedEntry[]): QualifiedEntry[] =>
  [...entries].sort((left, right) => {
    const rankDiff = (left.groupRank ?? MAX_RANK) - (right.groupRank ?? MAX_RANK);
    if (rankDiff !== 0) {
      return rankDiff;
    }
    if (left.groupId !== right.groupId) {
      return left.groupId - right.groupId;
    }
    const overallDiff = (left.overallRank ?? MAX_RANK) - (right.overallRank ?? MAX_RANK);
    if (overallDiff !== 0) {
      return overallDiff;
    }
    return left.entryId - right.entryId;
  });

export const seedBracketEntries = (entries: readonly number[], teamCount: number): SeedPair[] => {
  if (teamCount < 2) {
    return [];
  }

  const bracketSize = nextPowerOfTwo(teamCount);
  const normalized = entries.slice(0, teamCount);
  const seedOrder = buildBracketSeedOrder(bracketSize);
  const pairs: SeedPair[] = [];

  for (let index = 0; index < bracketSize / 2; index += 1) {
    const homeSeed = seedOrder[index * 2];
    const awaySeed = seedOrder[index * 2 + 1];
    pairs.push({
      homeEntryId: homeSeed <= teamCount ? (normalized[homeSeed - 1] ?? null) : null,
      awayEntryId: awaySeed <= teamCount ? (normalized[awaySeed - 1] ?? null) : null,
    });
  }

  return pairs;
};

export function buildGroupRows(
  tournament: TournamentConfig,
  entries: readonly EntrySeed[],
): Array<Record<string, number | string | null>> {
  const groupCount = Math.max(tournament.groupNum ?? 1, 1);
  const groupedEntries = Array.from({ length: groupCount }, () => [] as EntrySeed[]);
  const orderedEntries = sortEntrySeeds(entries);

  orderedEntries.forEach((entry, index) => {
    const cycle = Math.floor(index / groupCount);
    const offset = index % groupCount;
    const groupIndex = cycle % 2 === 0 ? offset : groupCount - offset - 1;
    groupedEntries[groupIndex].push(entry);
  });

  const rows: Array<Record<string, number | string | null>> = [];
  groupedEntries.forEach((groupEntries, groupIndex) => {
    groupEntries.forEach((entry, slotIndex) => {
      rows.push({
        tournament_id: tournament.id,
        group_id: groupIndex + 1,
        group_name: groupNameForIndex(groupIndex),
        group_index: slotIndex + 1,
        entry_id: entry.entryId,
        started_event_id: tournament.groupStartedEventId,
        ended_event_id: tournament.groupEndedEventId,
        group_points: 0,
        group_rank: null,
        played: 0,
        won: 0,
        drawn: 0,
        lost: 0,
        total_points: 0,
        total_transfers_cost: 0,
        total_net_points: 0,
        qualified: 0,
        overall_rank: entry.overallRank,
      });
    });
  });

  return rows;
}

export function buildKnockoutRows(
  tournament: TournamentConfig,
  seededRoundOne: readonly SeedPair[] | null,
): { matches: KnockoutMatchRow[]; results: KnockoutResultRow[] } {
  const teamCount = tournament.knockoutTeamNum ?? 0;
  const eventNum = tournament.knockoutEventNum ?? 0;
  const playAgainstNum = tournament.knockoutPlayAgainstNum ?? 1;
  const knockoutStart = tournament.knockoutStartedEventId ?? 0;

  if (teamCount < 2 || eventNum < 1 || knockoutStart < 1) {
    return { matches: [], results: [] };
  }

  const bracketSize = nextPowerOfTwo(teamCount);
  const roundStartIds: number[] = [];
  let nextMatchId = 1;

  for (let round = 1; round <= eventNum; round += 1) {
    roundStartIds.push(nextMatchId);
    nextMatchId += bracketSize / 2 ** round;
  }

  const matches: KnockoutMatchRow[] = [];
  const results: KnockoutResultRow[] = [];

  for (let round = 1; round <= eventNum; round += 1) {
    const matchesInRound = bracketSize / 2 ** round;
    const roundStart = roundStartIds[round - 1];
    const nextRoundStart = round < eventNum ? roundStartIds[round] : null;
    const startedEventId = knockoutStart + (round - 1) * playAgainstNum;
    const endedEventId = startedEventId + playAgainstNum - 1;

    for (let index = 0; index < matchesInRound; index += 1) {
      const matchId = roundStart + index;
      const seeded = round === 1 ? (seededRoundOne?.[index] ?? null) : null;

      matches.push({
        tournament_id: tournament.id,
        round,
        started_event_id: startedEventId,
        ended_event_id: endedEventId,
        match_id: matchId,
        next_match_id: nextRoundStart === null ? null : nextRoundStart + Math.floor(index / 2),
        home_entry_id: seeded?.homeEntryId ?? null,
        away_entry_id: seeded?.awayEntryId ?? null,
      });

      for (let leg = 0; leg < playAgainstNum; leg += 1) {
        const swap = leg % 2 === 1;
        results.push({
          tournament_id: tournament.id,
          event_id: startedEventId + leg,
          match_id: matchId,
          play_against_id: leg + 1,
          home_entry_id: seeded ? (swap ? seeded.awayEntryId : seeded.homeEntryId) : null,
          away_entry_id: seeded ? (swap ? seeded.homeEntryId : seeded.awayEntryId) : null,
        });
      }
    }
  }

  return { matches, results };
}

export function getTournamentBackfillWindow(
  tournament: TournamentConfig,
  currentEventId: number | null,
): TournamentBackfillWindow | null {
  const startEventId =
    tournament.groupMode !== 'no_group'
      ? tournament.groupStartedEventId
      : (tournament.knockoutStartedEventId ?? tournament.groupStartedEventId);
  const configuredEndEventId =
    tournament.knockoutMode !== 'no_knockout'
      ? tournament.knockoutEndedEventId
      : tournament.groupEndedEventId;

  if (!startEventId || !configuredEndEventId || currentEventId === null) {
    return null;
  }

  const endEventId = Math.min(configuredEndEventId, currentEventId);
  if (endEventId < startEventId) {
    return null;
  }

  return { startEventId, endEventId };
}

export function planTournamentStructure(
  payload: TournamentCreateInput,
  selectedParticipants: TournamentParticipant[],
  leagueId: number,
  leagueType: LeagueType,
  sourceLeagueName: string | null = null,
  sourceConfig?: { startEventId?: number; knockoutRounds?: number },
): TournamentStructurePlan {
  if (selectedParticipants.length < 2) {
    throw new ValidationError(
      'Tournament requires at least 2 selected participants.',
      'TOURNAMENT_PARTICIPANTS_TOO_FEW',
    );
  }

  const adminEntryId = Number(payload.adminId);
  if (
    payload.platformAdmin !== true &&
    !selectedParticipants.some((participant) => Number(participant.id) === adminEntryId)
  ) {
    throw new ValidationError(
      'Admin ID must be included in the tournament participant set.',
      'TOURNAMENT_ADMIN_NOT_PARTICIPANT',
    );
  }

  const groupStartedEventId = parseGameweek(payload.startGameweek);
  const groupEndedEventId = parseGameweek(payload.endGameweek);
  if (!groupStartedEventId || !groupEndedEventId || groupStartedEventId > groupEndedEventId) {
    throw new ValidationError(
      'Group stage gameweeks are invalid.',
      'TOURNAMENT_GROUP_GAMEWEEKS_INVALID',
    );
  }

  const isOfficialH2H = payload.participantSource === 'official' && leagueType === 'h2h';
  if (isOfficialH2H) {
    const officialStartEventId = sourceConfig?.startEventId ?? groupStartedEventId;
    const officialKnockoutRounds = Math.max(0, Math.trunc(sourceConfig?.knockoutRounds ?? 0));
    const officialGroupEndedEventId = 38 - officialKnockoutRounds;
    if (officialStartEventId > officialGroupEndedEventId) {
      throw new ValidationError(
        'Official H2H league schedule window is invalid.',
        'TOURNAMENT_H2H_WINDOW_INVALID',
      );
    }

    const hasKnockout = officialKnockoutRounds > 0;
    return {
      leagueId,
      leagueType,
      sourceLeagueName,
      rosterMode: 'official_sync',
      tournamentName: normalizeTournamentName(payload.tournamentName),
      creator: payload.creator.trim(),
      adminEntryId,
      selectedParticipants,
      groupMode: 'battle_races',
      groupTeamNum: selectedParticipants.length,
      groupNum: 1,
      groupAutoAverages: selectedParticipants.length % 2 === 1,
      groupStartedEventId: officialStartEventId,
      groupEndedEventId: officialGroupEndedEventId,
      groupRounds: officialGroupEndedEventId - officialStartEventId + 1,
      groupQualifyNum: null,
      knockoutMode: hasKnockout ? 'head_to_head' : 'no_knockout',
      knockoutTeamNum: hasKnockout ? 2 ** officialKnockoutRounds : null,
      knockoutEventNum: hasKnockout ? officialKnockoutRounds : null,
      knockoutRounds: hasKnockout ? officialKnockoutRounds : null,
      knockoutStartedEventId: hasKnockout ? officialGroupEndedEventId + 1 : null,
      knockoutEndedEventId: hasKnockout ? 38 : null,
      knockoutPlayAgainstNum: hasKnockout ? 1 : null,
    };
  }

  const groupNum = toOptionalPositiveInteger(payload.groupNum) ?? 1;
  const qualifiersPerGroup = toOptionalPositiveInteger(payload.qualifiersPerGroup);
  const groupRounds = Math.max(groupEndedEventId - groupStartedEventId + 1, 0);
  const groupTeamNum =
    payload.groupFormat === 'points'
      ? Math.ceil(selectedParticipants.length / groupNum)
      : selectedParticipants.length;
  const knockoutPlayAgainstNum =
    payload.knockoutFormat === 'single' ? 1 : payload.knockoutFormat === 'double' ? 2 : null;
  const knockoutTeamNum =
    payload.knockoutFormat === 'none'
      ? null
      : payload.groupFormat === 'points'
        ? groupNum * (qualifiersPerGroup ?? 0)
        : selectedParticipants.length;
  const knockoutEventNum =
    knockoutTeamNum && knockoutTeamNum >= 2 ? Math.ceil(Math.log2(knockoutTeamNum)) : null;
  const knockoutRounds =
    payload.knockoutFormat === 'none'
      ? null
      : payload.knockoutFormat === 'double'
        ? (knockoutEventNum ?? 0) * 2
        : knockoutEventNum;
  const knockoutStartedEventId =
    payload.knockoutFormat === 'none'
      ? null
      : payload.groupFormat === 'none'
        ? groupStartedEventId
        : groupEndedEventId + 1;
  const knockoutEndedEventId =
    payload.knockoutFormat === 'none' || !knockoutStartedEventId || !knockoutRounds
      ? null
      : knockoutStartedEventId + Math.max(knockoutRounds - 1, 0);

  if (payload.groupFormat !== 'none' && payload.knockoutFormat !== 'none' && !qualifiersPerGroup) {
    throw new ValidationError(
      'Group number and qualifiers per group are required for a group phase.',
      'TOURNAMENT_QUALIFIERS_REQUIRED',
    );
  }

  if (
    payload.groupFormat === 'points' &&
    payload.knockoutFormat !== 'none' &&
    groupNum * (qualifiersPerGroup ?? 0) > selectedParticipants.length
  ) {
    throw new ValidationError(
      'Group qualify total cannot exceed the total selected entries.',
      'TOURNAMENT_QUALIFY_TOTAL_EXCEEDS',
    );
  }

  if (
    payload.knockoutFormat !== 'none' &&
    (!knockoutTeamNum || knockoutTeamNum < 2 || !knockoutEventNum)
  ) {
    throw new ValidationError(
      'Knockout stage settings are incomplete or invalid.',
      'TOURNAMENT_KNOCKOUT_INVALID',
    );
  }

  if (payload.knockoutFormat !== 'none' && (!knockoutEndedEventId || knockoutEndedEventId > 38)) {
    throw new ValidationError('Knockout phase exceeds GW38.', 'TOURNAMENT_KNOCKOUT_EXCEEDS_GW38');
  }

  return {
    leagueId,
    leagueType,
    sourceLeagueName,
    rosterMode:
      payload.participantSource === 'official' &&
      leagueType === 'classic' &&
      payload.groupFormat === 'points' &&
      groupNum === 1 &&
      payload.knockoutFormat === 'none'
        ? 'official_sync'
        : 'snapshot',
    tournamentName: normalizeTournamentName(payload.tournamentName),
    creator: payload.creator.trim(),
    adminEntryId,
    selectedParticipants,
    groupMode: groupModeMap[payload.groupFormat],
    groupTeamNum,
    groupNum: payload.groupFormat === 'none' ? 1 : groupNum,
    groupAutoAverages: false,
    groupStartedEventId,
    groupEndedEventId,
    groupRounds,
    groupQualifyNum: payload.groupFormat === 'none' ? null : qualifiersPerGroup,
    knockoutMode: knockoutModeMap[payload.knockoutFormat],
    knockoutTeamNum,
    knockoutEventNum,
    knockoutRounds,
    knockoutStartedEventId,
    knockoutEndedEventId,
    knockoutPlayAgainstNum,
  };
}

export function isOfficialH2HTournament(
  tournament: Pick<TournamentSyncContext, 'leagueType' | 'rosterMode' | 'groupMode'>,
): boolean {
  return (
    tournament.leagueType === 'h2h' &&
    tournament.rosterMode === 'official_sync' &&
    tournament.groupMode === 'battle_races'
  );
}
