import type { RawFPLLeagueH2HMatch, RawFPLLeagueStandingsResult } from '../clients/fpl';
import { fplClient } from '../clients/fpl';
import type {
  DbTournamentBattleGroupResultInsert,
  DbTournamentGroup,
  DbTournamentGroupInsert,
  DbTournamentKnockoutInsert,
  DbTournamentKnockoutResultInsert,
} from '../db/schemas/index.schema';
import type { FplSeasonRef } from '../domain/fpl-season';
import type { TournamentSyncContext } from '../domain/tournament';
import { isOfficialH2HTournament } from '../domain/tournament';
import { tournamentEntryRepository } from '../repositories/tournament-entries';
import { entryEventResultsRepository } from '../repositories/entry-event-results';
import { tournamentGroupRepository } from '../repositories/tournament-groups';
import { tournamentOfficialH2HRepository } from '../repositories/tournament-official-h2h';
import { tournamentOfficialH2HManifestRepository } from '../repositories/tournament-official-h2h-manifest';
import { contentHash } from '../utils/content-hash';
import {
  buildOfficialH2HPageManifest,
  validateOfficialH2HPageManifest,
  type OfficialH2HPageManifest,
} from '../domain/official-h2h-manifest';
import { ValidationError } from '../utils/errors';
import { getConfig } from '../utils/config';
import { logInfo, logWarn } from '../utils/logger';
import {
  eventLiveManagerScoreService,
  type EventLiveManagerScoreBatch,
} from './event-live-manager-scores.service';

const MAX_H2H_PAGES = 100;

type OfficialH2HClient = Pick<typeof fplClient, 'getLeagueH2HStandings' | 'getLeagueH2HMatches'>;

export type OfficialH2HFetchOptions = Readonly<{
  /** Locked page manifests let a minute refresh avoid fetching unrelated pages. */
  matchPages?: readonly number[];
  existingManifests?: readonly OfficialH2HPageManifest[];
}>;

export function resolveOfficialH2HPagesToFetch(
  manifests: readonly Pick<OfficialH2HPageManifest, 'pageNumber' | 'eventIds' | 'lockedAt'>[],
  eventId: number,
  incrementalEnabled: boolean,
): Readonly<{ mode: 'full' | 'incremental'; pageNumbers: readonly number[] }> {
  const locked = manifests.length > 0 && manifests.every((manifest) => manifest.lockedAt !== null);
  if (!incrementalEnabled || !locked) return { mode: 'full', pageNumbers: [] };
  const pageNumbers = manifests
    .filter((manifest) => manifest.eventIds.includes(eventId))
    .map((manifest) => manifest.pageNumber)
    .sort((a, b) => a - b);
  // A locked manifest is the authority for the incremental boundary. If the
  // current event is absent, silently publishing standings without refreshing
  // any match page would hide a pagination/eligibility drift. Force one full
  // reconciliation so the caller can either prove the locked hash is still
  // valid or raise an explicit governance case.
  if (pageNumbers.length === 0) return { mode: 'full', pageNumbers: [] };
  return { mode: 'incremental', pageNumbers };
}

export type OfficialH2HStanding = RawFPLLeagueStandingsResult & { entry: number };

export type OfficialH2HSourceSnapshot = {
  standings: OfficialH2HStanding[];
  matches: Array<RawFPLLeagueH2HMatch & { sourceOrder: number }>;
  /** Exact provider page boundaries, retained for locked-manifest validation. */
  pageMatches?: readonly {
    pageNumber: number;
    matches: Array<RawFPLLeagueH2HMatch & { sourceOrder: number }>;
  }[];
  pageManifests?: readonly OfficialH2HPageManifest[];
};

export type OfficialH2HSyncOptions = {
  /** Allow score fallback for matches at or before a finalized event. */
  finalizedThroughEventId?: number | null;
  /**
   * Allow score fallback for one non-final event after its complete, atomic
   * score batch has been validated against the tournament roster.
   */
  provisionalEventId?: number | null;
  /** Suppress every outcome shape for an incomplete provisional event. */
  suppressedEventId?: number | null;
  /** Bypass the minute-page selector for a guarded full reconciliation. */
  forceFull?: boolean;
};

type EntryEventTotalsCoverage = {
  eventCount?: number;
  firstEventId?: number;
  lastEventId?: number;
};

export function hasCompleteEntryEventTotalsCoverage(
  row: EntryEventTotalsCoverage | undefined,
  startEventId: number,
  endEventId: number,
): boolean {
  if (endEventId < startEventId) return true;
  return Boolean(
    row &&
      row.eventCount === endEventId - startEventId + 1 &&
      row.firstEventId === startEventId &&
      row.lastEventId === endEventId,
  );
}

export function isOfficialH2HGroupEvent(
  tournament: Pick<TournamentSyncContext, 'groupStartedEventId' | 'groupEndedEventId'>,
  eventId: number,
): boolean {
  const groupStartEventId = tournament.groupStartedEventId ?? 1;
  const groupEndEventId = tournament.groupEndedEventId;
  return groupEndEventId !== null && eventId >= groupStartEventId && eventId <= groupEndEventId;
}

export function resolveFinalizedThroughEventId(
  latestFinalizedEventId: number | null | undefined,
  requestedEventId: number,
  requestedEventIsFinalized: boolean,
): number | null {
  const finalizedThroughEventId = Math.max(
    latestFinalizedEventId ?? 0,
    requestedEventIsFinalized ? requestedEventId : 0,
  );
  return finalizedThroughEventId > 0 ? finalizedThroughEventId : null;
}

export function resolveOfficialH2HSyncOptionsFromEventState(
  eventId: number,
  event: { finished: boolean; dataChecked: boolean; isCurrent: boolean } | null,
  currentEvent: { id: number } | null,
  latestFinalizedEvent: { id: number } | null,
): OfficialH2HSyncOptions {
  const eventIsFinalized = event?.finished === true && event.dataChecked === true;
  const finalizedThroughEventId = resolveFinalizedThroughEventId(
    latestFinalizedEvent?.id,
    eventId,
    eventIsFinalized,
  );
  return {
    // These rows are read concurrently. Either finalized signal must prevent
    // the same event from being treated as provisional.
    finalizedThroughEventId,
    provisionalEventId:
      event &&
      !eventIsFinalized &&
      (finalizedThroughEventId ?? 0) < eventId &&
      (event.isCurrent || currentEvent?.id === eventId)
        ? eventId
        : null,
  };
}

function isRealOfficialH2HStanding(
  standing: RawFPLLeagueStandingsResult,
): standing is OfficialH2HStanding {
  return Number.isInteger(standing.entry) && Number(standing.entry) > 0;
}

function nonNegativeInteger(value: number | null | undefined): number {
  return Number.isInteger(value) && (value ?? -1) >= 0 ? Number(value) : 0;
}

function integerOrZero(value: number | null | undefined): number {
  return Number.isInteger(value) ? Number(value) : 0;
}

function matchPointsFromScore(match: RawFPLLeagueH2HMatch): {
  home: number | null;
  away: number | null;
} {
  if (typeof match.entry_1_points !== 'number' || typeof match.entry_2_points !== 'number') {
    return { home: null, away: null };
  }
  if (match.entry_1_points > match.entry_2_points) return { home: 3, away: 0 };
  if (match.entry_1_points < match.entry_2_points) return { home: 0, away: 3 };
  return { home: 1, away: 1 };
}

function matchPoints(
  match: RawFPLLeagueH2HMatch,
  options: OfficialH2HSyncOptions = {},
): { home: number | null; away: number | null } {
  if (match.is_bye === true || options.suppressedEventId === match.event) {
    return { home: null, away: null };
  }
  if (options.provisionalEventId === match.event) {
    // The complete score batch is the newest live evidence. FPL's explicit
    // outcome fields can still describe the preceding score snapshot.
    return matchPointsFromScore(match);
  }
  const hasFinalizedScoreEvidence =
    options.finalizedThroughEventId !== null &&
    options.finalizedThroughEventId !== undefined &&
    match.event <= options.finalizedThroughEventId;
  if (
    hasFinalizedScoreEvidence &&
    typeof match.entry_1_points === 'number' &&
    typeof match.entry_2_points === 'number'
  ) {
    // Keep the validated score authoritative while FPL's outcome fields catch
    // up with a just-finalized round.
    return matchPointsFromScore(match);
  }
  if (
    typeof match.entry_1_total === 'number' &&
    typeof match.entry_2_total === 'number' &&
    [2, 3].includes(match.entry_1_total + match.entry_2_total)
  ) {
    return { home: match.entry_1_total, away: match.entry_2_total };
  }
  if (
    (match.entry_1_win ?? 0) +
      (match.entry_1_draw ?? 0) +
      (match.entry_1_loss ?? 0) +
      (match.entry_2_win ?? 0) +
      (match.entry_2_draw ?? 0) +
      (match.entry_2_loss ?? 0) >
    0
  ) {
    return {
      home: match.entry_1_win ? 3 : match.entry_1_draw ? 1 : 0,
      away: match.entry_2_win ? 3 : match.entry_2_draw ? 1 : 0,
    };
  }
  if (match.winner !== null && match.winner !== undefined) {
    return {
      home: match.winner === match.entry_1_entry ? 3 : 0,
      away: match.winner === match.entry_2_entry ? 3 : 0,
    };
  }
  // FPL currently returns the outcome fields as an all-zero placeholder while
  // the points fields are already populated. Treat that shape as scoreable for
  // finalized events, or for one live event whose complete batch has already
  // been validated against the roster by syncOfficialH2HTournament.
  const allowScoreFallback =
    hasFinalizedScoreEvidence || options.provisionalEventId === match.event;
  if (!allowScoreFallback) return { home: null, away: null };
  return matchPointsFromScore(match);
}

/**
 * FPL publishes the current H2H round as one snapshot. Do not activate live
 * score fallback unless every real roster entry appears exactly once, every
 * non-bye matchup has both scores, and the batch has moved beyond the all-zero
 * pre-match placeholder.
 */
export function hasCompleteOfficialH2HScoreBatch(
  entryIds: ReadonlySet<number>,
  matches: readonly RawFPLLeagueH2HMatch[],
  eventId: number,
): boolean {
  if (entryIds.size === 0) return false;
  const eventMatches = matches.filter(
    (match) => match.event === eventId && !isOfficialKnockoutMatch(match),
  );
  if (eventMatches.length === 0) return false;

  const seenEntries = new Set<number>();
  let hasNonZeroScore = false;
  for (const match of eventMatches) {
    const realSides = [match.entry_1_entry, match.entry_2_entry].filter(
      (entryId): entryId is number => entryId !== null,
    );
    if (new Set(realSides).size !== realSides.length) return false;
    for (const entryId of realSides) {
      if (!entryIds.has(entryId) || seenEntries.has(entryId)) return false;
      seenEntries.add(entryId);
    }

    if (match.is_bye === true) {
      if (realSides.length !== 1) return false;
      continue;
    }
    // A regular matchup is either two real entries, or one real entry against
    // FPL's synthetic Average Team (the nullable side).
    if (realSides.length < 1 || typeof match.entry_1_points !== 'number') return false;
    if (typeof match.entry_2_points !== 'number') return false;
    if (match.entry_1_points !== 0 || match.entry_2_points !== 0) hasNonZeroScore = true;
  }

  return seenEntries.size === entryIds.size && hasNonZeroScore;
}

export function validatedOfficialH2HSyncOptions(
  entryIds: ReadonlySet<number>,
  matches: readonly RawFPLLeagueH2HMatch[],
  options: OfficialH2HSyncOptions,
): OfficialH2HSyncOptions {
  const provisionalEventId = options.provisionalEventId;
  const completeProvisionalBatch =
    provisionalEventId !== null &&
    provisionalEventId !== undefined &&
    hasCompleteOfficialH2HScoreBatch(entryIds, matches, provisionalEventId);
  return {
    finalizedThroughEventId: options.finalizedThroughEventId ?? null,
    provisionalEventId: completeProvisionalBatch ? provisionalEventId : null,
    suppressedEventId:
      provisionalEventId !== null && provisionalEventId !== undefined && !completeProvisionalBatch
        ? provisionalEventId
        : null,
  };
}

/**
 * Remove the separately refreshed official H2H points for one active event.
 * The feed remains the schedule authority, but cannot be a live-score fallback.
 */
export function suppressOfficialH2HActiveScores(
  snapshot: OfficialH2HSourceSnapshot,
  eventId: number,
): OfficialH2HSourceSnapshot {
  return {
    ...snapshot,
    matches: snapshot.matches.map((match) =>
      match.event !== eventId
        ? match
        : {
            ...match,
            entry_1_points: match.entry_1_entry === null ? match.entry_1_points : null,
            entry_2_points: match.entry_2_entry === null ? match.entry_2_points : null,
            winner: null,
          },
    ),
  };
}

/**
 * Overlay real manager sides with net scores from one coherent event-live
 * batch. Synthetic Average Team scores have no event/live manager authority,
 * so a round containing one remains unavailable instead of mixing revisions.
 */
export function projectOfficialH2HEventLiveScores(
  snapshot: OfficialH2HSourceSnapshot,
  eventId: number,
  entryIds: ReadonlySet<number>,
  batch: EventLiveManagerScoreBatch | null,
): OfficialH2HSourceSnapshot | null {
  if (
    !batch ||
    batch.eventId !== eventId ||
    batch.state === 'scheduled' ||
    entryIds.size === 0 ||
    [...entryIds].some((entryId) => !batch.scores.has(entryId)) ||
    ![...entryIds].some((entryId) => {
      const score = batch.scores.get(entryId);
      return (
        score !== undefined &&
        (score.eventPoints !== 0 || score.transferCost !== 0 || score.netEventPoints !== 0)
      );
    }) ||
    snapshot.matches.some(
      (match) =>
        match.event === eventId &&
        match.is_bye !== true &&
        (match.entry_1_entry === null || match.entry_2_entry === null),
    )
  ) {
    return null;
  }

  return {
    ...snapshot,
    matches: snapshot.matches.map((match) => {
      if (match.event !== eventId) return match;
      const homePoints =
        match.entry_1_entry === null
          ? match.entry_1_points
          : (batch.scores.get(match.entry_1_entry)?.netEventPoints ?? null);
      const awayPoints =
        match.entry_2_entry === null
          ? match.entry_2_points
          : (batch.scores.get(match.entry_2_entry)?.netEventPoints ?? null);
      const winner =
        match.is_bye === true || homePoints === null || awayPoints === null
          ? null
          : homePoints === awayPoints
            ? isOfficialKnockoutMatch(match) &&
              match.tiebreak !== null &&
              match.tiebreak !== undefined &&
              (match.winner === match.entry_1_entry || match.winner === match.entry_2_entry)
              ? match.winner
              : null
            : homePoints > awayPoints
              ? match.entry_1_entry
              : match.entry_2_entry;
      return {
        ...match,
        entry_1_points: homePoints,
        entry_2_points: awayPoints,
        winner,
      };
    }),
  };
}

function serializeTiebreak(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function officialKnockoutName(match: RawFPLLeagueH2HMatch): string | null {
  return match.knockout_name?.trim() || null;
}

function isOfficialKnockoutMatch(match: RawFPLLeagueH2HMatch): boolean {
  return officialKnockoutName(match) !== null || match.is_knockout === true;
}

export async function fetchOfficialH2HSourceSnapshot(
  leagueId: number,
  client: OfficialH2HClient = fplClient,
  options: OfficialH2HFetchOptions = {},
): Promise<OfficialH2HSourceSnapshot> {
  const startedAt = Date.now();
  const standings: OfficialH2HStanding[] = [];
  let standingsPage = 1;
  let previousStandingsSignature: string | null = null;
  while (true) {
    const response = await client.getLeagueH2HStandings(leagueId, standingsPage, 1);
    // FPL represents the synthetic Average Team as a standings row whose
    // entry is null. It can be a match side, but it is not part of the real
    // tournament roster and must not participate in coverage checks.
    standings.push(...response.standings.results.filter(isRealOfficialH2HStanding));
    const signature = response.standings.results.map((row) => row.entry).join(',');
    if (
      response.standings.has_next &&
      previousStandingsSignature !== null &&
      signature === previousStandingsSignature
    ) {
      throw new ValidationError(
        'Official H2H standings pagination stopped making progress.',
        'TOURNAMENT_OFFICIAL_H2H_STANDINGS_STALLED',
      );
    }
    previousStandingsSignature = signature;
    if (!response.standings.has_next) break;
    standingsPage += 1;
    if (standingsPage > MAX_H2H_PAGES) {
      throw new ValidationError(
        'Official H2H standings pagination exceeded the safety limit.',
        'TOURNAMENT_OFFICIAL_H2H_STANDINGS_LIMIT',
      );
    }
  }

  const matches: Array<RawFPLLeagueH2HMatch & { sourceOrder: number }> = [];
  const pageSlices: Array<{
    pageNumber: number;
    matches: Array<RawFPLLeagueH2HMatch & { sourceOrder: number }>;
  }> = [];
  const requestedPages = options.matchPages
    ? [...new Set(options.matchPages)]
        .filter((page) => Number.isSafeInteger(page) && page > 0)
        .sort((a, b) => a - b)
    : null;
  let matchPage = 1;
  let previousMatchSignature: string | null = null;
  const pageNumbers = requestedPages ?? null;
  while (pageNumbers ? pageNumbers.length > 0 : true) {
    if (pageNumbers && matchPage > pageNumbers.length) break;
    const pageNumber = pageNumbers ? pageNumbers[matchPage - 1] : matchPage;
    if (pageNumber === undefined) break;
    const response = await client.getLeagueH2HMatches(leagueId, pageNumber);
    const signature = response.results.map((match) => match.id).join(',');
    if (
      response.has_next &&
      previousMatchSignature !== null &&
      signature === previousMatchSignature
    ) {
      throw new ValidationError(
        'Official H2H match pagination stopped making progress.',
        'TOURNAMENT_OFFICIAL_H2H_MATCHES_STALLED',
      );
    }
    previousMatchSignature = signature;
    const pageOffset =
      options.existingManifests
        ?.filter((manifest) => manifest.pageNumber < pageNumber)
        .reduce((total, manifest) => total + manifest.matchIds.length, 0) ?? matches.length;
    const pageMatches = response.results.map((match, index) => ({
      ...match,
      sourceOrder: pageOffset + index,
    }));
    matches.push(...pageMatches);
    pageSlices.push({ pageNumber, matches: pageMatches });
    if (pageNumbers) {
      matchPage += 1;
      continue;
    }
    if (!response.has_next) break;
    matchPage += 1;
    if (matchPage > MAX_H2H_PAGES) {
      throw new ValidationError(
        'Official H2H match pagination exceeded the safety limit.',
        'TOURNAMENT_OFFICIAL_H2H_MATCHES_LIMIT',
      );
    }
  }

  const matchIds = new Set<number>();
  for (const match of matches) {
    if (matchIds.has(match.id)) {
      throw new ValidationError(
        `Official H2H response repeated match ${match.id}.`,
        'TOURNAMENT_OFFICIAL_H2H_MATCH_DUPLICATE',
      );
    }
    matchIds.add(match.id);
  }
  const standingEntryIds = new Set<number>();
  for (const standing of standings) {
    if (standingEntryIds.has(standing.entry)) {
      throw new ValidationError(
        `Official H2H standings repeated entry ${standing.entry}.`,
        'TOURNAMENT_OFFICIAL_H2H_STANDINGS_DUPLICATE',
      );
    }
    standingEntryIds.add(standing.entry);
  }
  const scheduleHash = contentHash(
    matches
      .filter((match) => !isOfficialKnockoutMatch(match))
      .map((match) => ({
        officialMatchId: match.id,
        eventId: match.event,
        sourceOrder: match.sourceOrder,
        homeEntryId: match.entry_1_entry,
        awayEntryId: match.entry_2_entry,
        isBye: match.is_bye ?? false,
      })),
  );
  const capturedAt = new Date();
  // An empty terminal page is a valid pagination response (and is common for
  // a newly-created tournament). It carries no durable schedule evidence and
  // must not manufacture an invalid empty manifest. A non-empty page is still
  // validated by the manifest builder and by the publication transaction.
  const pageManifests = pageSlices
    .filter((page) => page.matches.length > 0)
    .map((page) =>
      buildOfficialH2HPageManifest(page.pageNumber, page.matches, scheduleHash, capturedAt),
    );
  logInfo('Official H2H source pages captured', {
    leagueId,
    mode: options.matchPages ? 'incremental' : 'full',
    standingsPages: standingsPage,
    matchPages: pageSlices.length,
    requestCount: standingsPage + pageSlices.length,
    durationMs: Math.max(0, Date.now() - startedAt),
    scheduleHash,
  });
  return { standings, matches, pageMatches: pageSlices, pageManifests };
}

export function projectOfficialH2HStandings(
  currentGroups: readonly DbTournamentGroup[],
  standings: readonly OfficialH2HStanding[],
  totalsByEntry?: ReadonlyMap<number, { totalPoints: number; totalTransfersCost: number }>,
): DbTournamentGroupInsert[] {
  const standingsByEntry = new Map(standings.map((standing) => [standing.entry, standing]));
  return currentGroups.map((group) => {
    const standing = standingsByEntry.get(group.entryId);
    const { id: _id, seasonId: _seasonId, sourceGroupRowId: _sourceGroupRowId, ...stored } = group;
    if (!standing) return stored;
    const totals = totalsByEntry?.get(group.entryId);
    return {
      ...stored,
      groupPoints: nonNegativeInteger(standing.total ?? standing.points_total),
      groupRank: standing.rank ?? null,
      played: nonNegativeInteger(standing.matches_played),
      won: nonNegativeInteger(standing.matches_won),
      drawn: nonNegativeInteger(standing.matches_drawn),
      lost: nonNegativeInteger(standing.matches_lost),
      totalPoints: totalsByEntry === undefined ? stored.totalPoints : (totals?.totalPoints ?? 0),
      totalTransfersCost:
        totalsByEntry === undefined ? stored.totalTransfersCost : (totals?.totalTransfersCost ?? 0),
      totalNetPoints: integerOrZero(standing.points_for),
    };
  });
}

/**
 * Rebuild H2H standings from the official match feed when FPL's standings
 * endpoint is temporarily behind its match scores (as it can be just after
 * the first gameweek is published).
 */
export function projectOfficialH2HStandingsFromMatches(
  entryIds: ReadonlySet<number>,
  matches: readonly (RawFPLLeagueH2HMatch & { sourceOrder: number })[],
  options: OfficialH2HSyncOptions = {},
): OfficialH2HStanding[] {
  const totals = new Map<
    number,
    {
      entry: number;
      total: number;
      matches_played: number;
      matches_won: number;
      matches_drawn: number;
      matches_lost: number;
      points_for: number;
    }
  >();
  for (const entry of entryIds) {
    totals.set(entry, {
      entry,
      total: 0,
      matches_played: 0,
      matches_won: 0,
      matches_drawn: 0,
      matches_lost: 0,
      points_for: 0,
    });
  }

  for (const match of matches) {
    if (isOfficialKnockoutMatch(match)) continue;
    const outcome = matchPoints(match, options);
    if (outcome.home === null || outcome.away === null) continue;
    for (const side of [
      {
        entry: match.entry_1_entry,
        points: match.entry_1_points,
        matchPoints: outcome.home,
      },
      {
        entry: match.entry_2_entry,
        points: match.entry_2_points,
        matchPoints: outcome.away,
      },
    ]) {
      if (side.entry === null) continue;
      const total = totals.get(side.entry);
      if (!total) continue;
      total.matches_played += 1;
      total.total += side.matchPoints;
      total.points_for += typeof side.points === 'number' ? side.points : 0;
      if (side.matchPoints === 3) total.matches_won += 1;
      else if (side.matchPoints === 1) total.matches_drawn += 1;
      else total.matches_lost += 1;
    }
  }

  const ordered = [...totals.values()].sort(
    (left, right) =>
      right.total - left.total || right.points_for - left.points_for || left.entry - right.entry,
  );
  let previousKey: string | null = null;
  let rank = 0;
  return ordered.map((standing, index) => {
    const key = `${standing.total}:${standing.points_for}`;
    if (key !== previousKey) rank = index + 1;
    previousKey = key;
    return { ...standing, rank };
  });
}

function standingsPlayedCoverage(standings: readonly OfficialH2HStanding[]): number {
  return standings.reduce(
    (total, standing) => total + nonNegativeInteger(standing.matches_played),
    0,
  );
}

export function minimumOfficialPlayedCoverageForSuppressedEvent(
  matchDerivedStandings: readonly OfficialH2HStanding[],
  matches: readonly RawFPLLeagueH2HMatch[],
  suppressedEventId: number | null | undefined,
): ReadonlyMap<number, number> | undefined {
  if (suppressedEventId === null || suppressedEventId === undefined) return undefined;
  const minimumPlayedByEntry = new Map(
    matchDerivedStandings.map((standing) => [
      standing.entry,
      nonNegativeInteger(standing.matches_played),
    ]),
  );
  for (const match of matches) {
    if (
      match.event !== suppressedEventId ||
      isOfficialKnockoutMatch(match) ||
      match.is_bye === true
    ) {
      continue;
    }
    for (const entryId of [match.entry_1_entry, match.entry_2_entry]) {
      if (entryId === null || !minimumPlayedByEntry.has(entryId)) continue;
      minimumPlayedByEntry.set(entryId, (minimumPlayedByEntry.get(entryId) ?? 0) + 1);
    }
  }
  return minimumPlayedByEntry;
}

export function selectOfficialH2HStandings(
  officialStandings: readonly OfficialH2HStanding[],
  matchDerivedStandings: readonly OfficialH2HStanding[],
  minimumOfficialPlayedByEntry?: ReadonlyMap<number, number>,
  preferMatchDerivedAtEqualCoverage = false,
): {
  standings: readonly OfficialH2HStanding[];
  usedMatchDerivedStandings: boolean;
  officialPlayed: number;
  derivedPlayed: number;
} {
  const officialPlayed = standingsPlayedCoverage(officialStandings);
  const derivedPlayed = standingsPlayedCoverage(matchDerivedStandings);
  const officialPlayedByEntry = new Map(
    officialStandings.map((standing) => [
      standing.entry,
      nonNegativeInteger(standing.matches_played),
    ]),
  );
  // FPL can refresh only some rows first. Keep the atomic match-derived table
  // until every real entry reaches both its derived coverage and, while a
  // score-incomplete round is suppressed, that round's scheduled coverage.
  const officialCoverageLags = matchDerivedStandings.some((standing) => {
    const officialEntryPlayed = officialPlayedByEntry.get(standing.entry) ?? -1;
    const minimumPlayed = Math.max(
      nonNegativeInteger(standing.matches_played),
      minimumOfficialPlayedByEntry?.get(standing.entry) ?? 0,
    );
    return officialEntryPlayed < minimumPlayed;
  });
  const officialByEntry = new Map(
    officialStandings.map((standing) => [standing.entry, standing] as const),
  );
  const hasEqualPerEntryCoverage = matchDerivedStandings.every(
    (standing) =>
      (officialPlayedByEntry.get(standing.entry) ?? -1) ===
      nonNegativeInteger(standing.matches_played),
  );
  const aggregateDiffersAtEqualCoverage =
    preferMatchDerivedAtEqualCoverage &&
    hasEqualPerEntryCoverage &&
    matchDerivedStandings.some((derived) => {
      const official = officialByEntry.get(derived.entry);
      return (
        !official ||
        nonNegativeInteger(official.total) !== nonNegativeInteger(derived.total) ||
        nonNegativeInteger(official.matches_won) !== nonNegativeInteger(derived.matches_won) ||
        nonNegativeInteger(official.matches_drawn) !== nonNegativeInteger(derived.matches_drawn) ||
        nonNegativeInteger(official.matches_lost) !== nonNegativeInteger(derived.matches_lost) ||
        integerOrZero(official.points_for) !== integerOrZero(derived.points_for)
      );
    });
  const usedMatchDerivedStandings = officialCoverageLags || aggregateDiffersAtEqualCoverage;
  return {
    standings: usedMatchDerivedStandings ? matchDerivedStandings : officialStandings,
    usedMatchDerivedStandings,
    officialPlayed,
    derivedPlayed,
  };
}

function assertMatchSides(match: RawFPLLeagueH2HMatch, entryIds: ReadonlySet<number>): void {
  if (
    !isOfficialKnockoutMatch(match) &&
    match.entry_1_entry === null &&
    match.entry_2_entry === null
  ) {
    throw new ValidationError(
      `Official H2H regular match ${match.id} has no real side.`,
      'TOURNAMENT_OFFICIAL_H2H_MATCH_INVALID',
    );
  }
  if (
    match.entry_1_entry !== null &&
    match.entry_2_entry !== null &&
    match.entry_1_entry === match.entry_2_entry
  ) {
    throw new ValidationError(
      `Official H2H match ${match.id} repeats the same entry.`,
      'TOURNAMENT_OFFICIAL_H2H_MATCH_INVALID',
    );
  }
  for (const entryId of [match.entry_1_entry, match.entry_2_entry, match.winner]) {
    if (entryId !== null && !entryIds.has(entryId)) {
      throw new ValidationError(
        `Official H2H match ${match.id} references entry ${entryId} outside the roster.`,
        'TOURNAMENT_OFFICIAL_H2H_ROSTER_MISMATCH',
      );
    }
  }
  if (
    match.winner !== null &&
    match.winner !== match.entry_1_entry &&
    match.winner !== match.entry_2_entry
  ) {
    throw new ValidationError(
      `Official H2H match ${match.id} has a winner outside its sides.`,
      'TOURNAMENT_OFFICIAL_H2H_MATCH_INVALID',
    );
  }
}

export function validateOfficialH2HSchedule(
  tournament: TournamentSyncContext,
  entryIds: ReadonlySet<number>,
  snapshot: OfficialH2HSourceSnapshot,
): void {
  if (snapshot.matches.length === 0) return;

  for (const match of snapshot.matches) assertMatchSides(match, entryIds);
  const regularMatches = snapshot.matches.filter((match) => !isOfficialKnockoutMatch(match));
  const startEventId = tournament.groupStartedEventId;
  const endEventId = tournament.groupEndedEventId;
  if (startEventId === null || endEventId === null || regularMatches.length === 0) {
    throw new ValidationError(
      'Official H2H response does not contain a complete regular schedule.',
      'TOURNAMENT_OFFICIAL_H2H_SCHEDULE_INCOMPLETE',
    );
  }

  const byEvent = new Map<number, RawFPLLeagueH2HMatch[]>();
  for (const match of regularMatches) {
    if (match.event < startEventId || match.event > endEventId) {
      throw new ValidationError(
        `Official H2H regular match ${match.id} falls outside the group window.`,
        'TOURNAMENT_OFFICIAL_H2H_SCHEDULE_INVALID',
      );
    }
    const eventMatches = byEvent.get(match.event) ?? [];
    eventMatches.push(match);
    byEvent.set(match.event, eventMatches);
  }

  const expectedMatchesPerEvent = Math.ceil(entryIds.size / 2);
  const expectedAverageSides = entryIds.size % 2;
  for (let eventId = startEventId; eventId <= endEventId; eventId += 1) {
    const eventMatches = byEvent.get(eventId) ?? [];
    if (eventMatches.length !== expectedMatchesPerEvent) {
      throw new ValidationError(
        `Official H2H GW${eventId} has ${eventMatches.length} of ${expectedMatchesPerEvent} matches.`,
        'TOURNAMENT_OFFICIAL_H2H_SCHEDULE_INCOMPLETE',
      );
    }
    const seenEntries = new Set<number>();
    let averageSides = 0;
    for (const match of eventMatches) {
      for (const entryId of [match.entry_1_entry, match.entry_2_entry]) {
        if (entryId === null) {
          averageSides += 1;
          continue;
        }
        if (seenEntries.has(entryId)) {
          throw new ValidationError(
            `Official H2H GW${eventId} repeats entry ${entryId}.`,
            'TOURNAMENT_OFFICIAL_H2H_SCHEDULE_INVALID',
          );
        }
        seenEntries.add(entryId);
      }
    }
    if (seenEntries.size !== entryIds.size || averageSides !== expectedAverageSides) {
      throw new ValidationError(
        `Official H2H GW${eventId} does not cover the roster exactly once.`,
        'TOURNAMENT_OFFICIAL_H2H_SCHEDULE_INCOMPLETE',
      );
    }
  }
}

function resolveKnockoutRound(
  tournament: TournamentSyncContext,
  match: RawFPLLeagueH2HMatch,
): number {
  const rounds = tournament.knockoutEventNum ?? 0;
  const normalizedName = match.knockout_name?.trim().toLowerCase() ?? '';
  if (normalizedName.includes('quarter')) return Math.max(1, rounds - 2);
  if (normalizedName.includes('semi')) return Math.max(1, rounds - 1);
  if (normalizedName.includes('final')) return Math.max(1, rounds);
  const start = tournament.knockoutStartedEventId ?? match.event;
  return Math.min(Math.max(match.event - start + 1, 1), Math.max(rounds, 1));
}

export function buildOfficialH2HRows(
  tournament: TournamentSyncContext,
  entryIds: ReadonlySet<number>,
  snapshot: OfficialH2HSourceSnapshot,
  checkedAt: Date,
  options: OfficialH2HSyncOptions = {},
): {
  scheduleHash: string;
  battleRows: DbTournamentBattleGroupResultInsert[];
  knockoutRows: DbTournamentKnockoutResultInsert[];
  bracketRows: DbTournamentKnockoutInsert[];
} {
  const battleRows: DbTournamentBattleGroupResultInsert[] = [];
  const knockoutRows: DbTournamentKnockoutResultInsert[] = [];
  validateOfficialH2HSchedule(tournament, entryIds, snapshot);
  const knockoutMatches = snapshot.matches.filter(isOfficialKnockoutMatch);
  const roundMatchCounts = new Map<number, number>();
  const knockoutByLocalMatchId = new Map<number, RawFPLLeagueH2HMatch>();
  const configuredRounds = tournament.knockoutEventNum ?? 0;
  const configuredTeamCount = tournament.knockoutTeamNum ?? 0;

  for (const match of snapshot.matches) {
    const points = matchPoints(match, options);
    const knockoutName = officialKnockoutName(match);
    if (!isOfficialKnockoutMatch(match)) {
      battleRows.push({
        tournamentId: tournament.id,
        groupId: 1,
        eventId: match.event,
        homeIndex: match.sourceOrder * 2 + 1,
        homeEntryId: match.entry_1_entry,
        homeNetPoints: match.entry_1_points,
        homeRank: null,
        homeMatchPoints: points.home,
        awayIndex: match.sourceOrder * 2 + 2,
        awayEntryId: match.entry_2_entry,
        awayNetPoints: match.entry_2_points,
        awayRank: null,
        awayMatchPoints: points.away,
        officialMatchId: match.id,
        sourceOrder: match.sourceOrder,
        homeIsAverage: match.entry_1_entry === null,
        awayIsAverage: match.entry_2_entry === null,
        isBye: match.is_bye ?? false,
        sourceCheckedAt: checkedAt,
      });
      continue;
    }

    const round = resolveKnockoutRound(tournament, match);
    const roundIndex = roundMatchCounts.get(round) ?? 0;
    const expectedMatches = configuredTeamCount > 0 ? configuredTeamCount / 2 ** round : 0;
    if (configuredRounds < 1 || expectedMatches < 1 || roundIndex >= expectedMatches) {
      throw new ValidationError(
        `Official H2H knockout match ${match.id} does not fit the configured bracket.`,
        'TOURNAMENT_OFFICIAL_H2H_KNOCKOUT_INVALID',
      );
    }
    const roundStart = configuredTeamCount - configuredTeamCount / 2 ** (round - 1) + 1;
    const localMatchId = roundStart + roundIndex;
    roundMatchCounts.set(round, roundIndex + 1);
    knockoutByLocalMatchId.set(localMatchId, match);
    knockoutRows.push({
      tournamentId: tournament.id,
      eventId: match.event,
      matchId: localMatchId,
      playAgainstId: 1,
      homeEntryId: match.entry_1_entry,
      homeNetPoints: match.entry_1_points,
      awayEntryId: match.entry_2_entry,
      awayNetPoints: match.entry_2_points,
      matchWinner: match.winner,
      officialMatchId: match.id,
      sourceOrder: match.sourceOrder,
      knockoutName,
      tiebreak: serializeTiebreak(match.tiebreak),
      sourceCheckedAt: checkedAt,
    });
  }

  const bracketRows: DbTournamentKnockoutInsert[] = [];
  if (knockoutMatches.length > 0 && configuredRounds > 0 && configuredTeamCount > 1) {
    let matchId = 1;
    for (let round = 1; round <= configuredRounds; round += 1) {
      const matchesInRound = configuredTeamCount / 2 ** round;
      const nextRoundStart = round < configuredRounds ? matchId + matchesInRound : null;
      for (let index = 0; index < matchesInRound; index += 1) {
        const localMatchId = matchId + index;
        const source = knockoutByLocalMatchId.get(localMatchId);
        const homeWon = Boolean(
          source && source.winner !== null && source.winner === source.entry_1_entry,
        );
        const awayWon = Boolean(
          source && source.winner !== null && source.winner === source.entry_2_entry,
        );
        bracketRows.push({
          tournamentId: tournament.id,
          round,
          startedEventId: source?.event ?? (tournament.knockoutStartedEventId ?? 1) + round - 1,
          endedEventId: source?.event ?? (tournament.knockoutStartedEventId ?? 1) + round - 1,
          matchId: localMatchId,
          nextMatchId: nextRoundStart === null ? null : nextRoundStart + Math.floor(index / 2),
          homeEntryId: source?.entry_1_entry ?? null,
          homeNetPoints: source?.entry_1_points ?? null,
          homeWins: homeWon ? 1 : 0,
          awayEntryId: source?.entry_2_entry ?? null,
          awayNetPoints: source?.entry_2_points ?? null,
          awayWins: awayWon ? 1 : 0,
          roundWinner: source?.winner ?? null,
        });
      }
      matchId += matchesInRound;
    }
  }

  const scheduleHash = contentHash(
    snapshot.matches
      .filter((match) => !isOfficialKnockoutMatch(match))
      .map((match) => ({
        officialMatchId: match.id,
        eventId: match.event,
        sourceOrder: match.sourceOrder,
        homeEntryId: match.entry_1_entry,
        awayEntryId: match.entry_2_entry,
        isBye: match.is_bye ?? false,
      })),
  );
  return { scheduleHash, battleRows, knockoutRows, bracketRows };
}

export async function syncOfficialH2HTournament(
  season: FplSeasonRef,
  tournament: TournamentSyncContext,
  reconcileEventId?: number,
  options: OfficialH2HSyncOptions = {},
): Promise<{ updatedGroups: number; updatedResults: number; skipped: number }> {
  if (!isOfficialH2HTournament(tournament) || !tournament.leagueId) {
    throw new ValidationError(
      'Tournament is not an official H2H mirror.',
      'TOURNAMENT_OFFICIAL_H2H_REQUIRED',
    );
  }

  const entryIdsPromise = tournamentEntryRepository.findEntryIdsByTournamentId(
    season,
    tournament.id,
  );
  const manifests = getConfig().OFFICIAL_H2H_INCREMENTAL_ENABLED
    ? await tournamentOfficialH2HManifestRepository
        .findByTournament(season, tournament.id)
        .catch((error) => {
          logWarn('Official H2H manifest unavailable; falling back to full fetch', {
            tournamentId: tournament.id,
            error: error instanceof Error ? error.message : 'unknown',
          });
          return [];
        })
    : [];
  const pagePlan = resolveOfficialH2HPagesToFetch(
    manifests,
    reconcileEventId ?? 0,
    getConfig().OFFICIAL_H2H_INCREMENTAL_ENABLED &&
      reconcileEventId !== undefined &&
      options.forceFull !== true,
  );
  const fetched = await fetchOfficialH2HSourceSnapshot(tournament.leagueId, fplClient, {
    ...(pagePlan.mode === 'incremental'
      ? { matchPages: pagePlan.pageNumbers, existingManifests: manifests }
      : {}),
  });
  let snapshot = fetched;
  if (pagePlan.mode === 'incremental') {
    const persisted = await tournamentOfficialH2HRepository.findPersistedMatches(
      season,
      tournament.id,
    );
    const byId = new Map(persisted.map((match) => [match.id, match]));
    for (const match of fetched.matches) byId.set(match.id, match);
    const merged = [...byId.values()].sort((a, b) => a.sourceOrder - b.sourceOrder);
    // A locked manifest is immutable. Validate every fetched page before the
    // normal full projection; any drift aborts the transaction with zero rows.
    for (const manifest of manifests.filter((item) =>
      pagePlan.pageNumbers.includes(item.pageNumber),
    )) {
      // Validate against this run's provider evidence only. Falling back to
      // persisted rows here would let a missing/empty page appear healthy and
      // publish stale data after the locked schedule has drifted.
      const fetchedPage = fetched.pageMatches?.find(
        (page) => page.pageNumber === manifest.pageNumber,
      );
      // Validate the complete provider response, not a filtered projection of
      // the locked IDs. Filtering would hide a newly inserted match and let a
      // changed page publish stale persisted rows.
      if (!fetchedPage || !validateOfficialH2HPageManifest(manifest, fetchedPage.matches)) {
        throw new ValidationError(
          `Official H2H page ${manifest.pageNumber} changed after it was locked.`,
          'TOURNAMENT_OFFICIAL_H2H_PAGE_CHANGED',
        );
      }
    }
    snapshot = { standings: fetched.standings, matches: merged, pageManifests: manifests };
  }
  const entryIds = await entryIdsPromise;
  const entryIdSet = new Set(entryIds);
  if (snapshot.standings.length > 0 && snapshot.standings.length !== entryIdSet.size) {
    throw new ValidationError(
      'Official H2H standings do not cover the complete roster.',
      'TOURNAMENT_OFFICIAL_H2H_STANDINGS_INCOMPLETE',
    );
  }
  for (const standing of snapshot.standings) {
    if (!entryIdSet.has(standing.entry)) {
      throw new ValidationError(
        `Official H2H standings reference entry ${standing.entry} outside the roster.`,
        'TOURNAMENT_OFFICIAL_H2H_ROSTER_MISMATCH',
      );
    }
  }

  const currentGroups = await tournamentGroupRepository.findByTournamentAndEntries(
    season,
    tournament.id,
    entryIds,
  );
  if (
    currentGroups.length !== entryIdSet.size ||
    currentGroups.some((group) => !entryIdSet.has(group.entryId))
  ) {
    throw new ValidationError(
      'Official H2H tournament group does not match its roster.',
      'TOURNAMENT_OFFICIAL_H2H_GROUP_MISMATCH',
    );
  }
  const requestedProvisionalEventId = options.provisionalEventId ?? null;
  const eventLiveBatch =
    requestedProvisionalEventId === null
      ? null
      : await eventLiveManagerScoreService
          .load(season, requestedProvisionalEventId, entryIds)
          .catch((error) => {
            logWarn('Official H2H event-live score batch unavailable', {
              tournamentId: tournament.id,
              eventId: requestedProvisionalEventId,
              error: error instanceof Error ? error.message : 'unknown',
            });
            return null;
          });
  const eventLiveSnapshot =
    requestedProvisionalEventId === null
      ? null
      : projectOfficialH2HEventLiveScores(
          snapshot,
          requestedProvisionalEventId,
          entryIdSet,
          eventLiveBatch,
        );
  const scoringSnapshot =
    requestedProvisionalEventId === null
      ? snapshot
      : (eventLiveSnapshot ??
        suppressOfficialH2HActiveScores(snapshot, requestedProvisionalEventId));
  const effectiveOptions =
    requestedProvisionalEventId === null
      ? validatedOfficialH2HSyncOptions(entryIdSet, scoringSnapshot.matches, options)
      : eventLiveSnapshot
        ? {
            finalizedThroughEventId: options.finalizedThroughEventId ?? null,
            provisionalEventId: requestedProvisionalEventId,
            suppressedEventId: null,
          }
        : {
            finalizedThroughEventId: options.finalizedThroughEventId ?? null,
            provisionalEventId: null,
            suppressedEventId: requestedProvisionalEventId,
          };
  const provisionalEventId = effectiveOptions.provisionalEventId ?? null;
  const checkedAt =
    eventLiveSnapshot && eventLiveBatch ? new Date(eventLiveBatch.checkedAt) : new Date();

  if (reconcileEventId) {
    const localResults = await entryEventResultsRepository.findByEventAndEntryIds(
      season,
      reconcileEventId,
      entryIds,
    );
    const localByEntry = new Map(localResults.map((result) => [result.entryId, result]));
    for (const match of snapshot.matches.filter(
      (candidate) => candidate.event === reconcileEventId,
    )) {
      for (const [entryId, officialPoints] of [
        [match.entry_1_entry, match.entry_1_points],
        [match.entry_2_entry, match.entry_2_points],
      ] as const) {
        if (entryId === null) continue;
        const authoritativePoints =
          eventLiveBatch?.eventId === reconcileEventId
            ? (eventLiveBatch.scores.get(entryId)?.netEventPoints ?? null)
            : officialPoints;
        if (
          officialPoints !== null &&
          authoritativePoints !== null &&
          officialPoints !== authoritativePoints
        ) {
          logWarn('Official H2H score differs from event-live authority', {
            tournamentId: tournament.id,
            eventId: reconcileEventId,
            officialMatchId: match.id,
            entryId,
            officialPoints,
            eventLivePoints: authoritativePoints,
            eventLiveRevision: eventLiveBatch?.revision ?? null,
          });
        }
        if (authoritativePoints === null) continue;
        const local = localByEntry.get(entryId);
        if (local && local.eventNetPoints !== authoritativePoints) {
          logWarn('Authoritative H2H score differs from local entry event result', {
            tournamentId: tournament.id,
            eventId: reconcileEventId,
            officialMatchId: match.id,
            entryId,
            authoritativePoints,
            localPoints: local.eventNetPoints,
          });
        }
      }
    }
  }
  const officialRows = buildOfficialH2HRows(
    tournament,
    entryIdSet,
    scoringSnapshot,
    checkedAt,
    effectiveOptions,
  );
  const groupStartEventId = tournament.groupStartedEventId ?? 1;
  const groupEndEventId = tournament.groupEndedEventId ?? reconcileEventId ?? 38;
  const provisionalEventBelongsToGroup =
    provisionalEventId !== null && isOfficialH2HGroupEvent(tournament, provisionalEventId);
  const aggregateTotals =
    eventLiveSnapshot && eventLiveBatch && provisionalEventBelongsToGroup
      ? await (async () => {
          const previousTotals =
            provisionalEventId <= groupStartEventId
              ? []
              : await entryEventResultsRepository.aggregateTotalsByEntry(
                  season,
                  entryIds,
                  groupStartEventId,
                  provisionalEventId - 1,
                );
          const previousByEntry = new Map(previousTotals.map((row) => [row.entryId, row] as const));
          const previousEndEventId = provisionalEventId - 1;
          const incompleteEntryIds = entryIds.filter(
            (entryId) =>
              !hasCompleteEntryEventTotalsCoverage(
                previousByEntry.get(entryId),
                groupStartEventId,
                previousEndEventId,
              ),
          );
          if (incompleteEntryIds.length > 0) {
            throw new ValidationError(
              `Official H2H cumulative totals are incomplete for ${incompleteEntryIds.length} entries through GW${previousEndEventId}.`,
              'TOURNAMENT_OFFICIAL_H2H_TOTALS_INCOMPLETE',
            );
          }
          return entryIds.map((entryId) => {
            const previous = previousByEntry.get(entryId);
            const score = eventLiveBatch.scores.get(entryId)!;
            return {
              entryId,
              totalPoints: (previous?.totalPoints ?? 0) + score.eventPoints,
              totalTransfersCost: (previous?.totalTransfersCost ?? 0) + score.transferCost,
              totalNetPoints: (previous?.totalNetPoints ?? 0) + score.netEventPoints,
            };
          });
        })()
      : await entryEventResultsRepository.aggregateTotalsByEntry(
          season,
          entryIds,
          groupStartEventId,
          groupEndEventId,
        );
  const totalsByEntry = new Map(aggregateTotals.map((row) => [row.entryId, row] as const));
  const matchDerivedStandings = projectOfficialH2HStandingsFromMatches(
    entryIdSet,
    scoringSnapshot.matches,
    effectiveOptions,
  );
  const minimumOfficialPlayedByEntry = minimumOfficialPlayedCoverageForSuppressedEvent(
    matchDerivedStandings,
    scoringSnapshot.matches,
    effectiveOptions.suppressedEventId,
  );
  const standingsSelection = selectOfficialH2HStandings(
    snapshot.standings,
    matchDerivedStandings,
    minimumOfficialPlayedByEntry,
    effectiveOptions.provisionalEventId !== null ||
      effectiveOptions.finalizedThroughEventId !== null,
  );
  if (standingsSelection.usedMatchDerivedStandings) {
    logWarn('FPL H2H standings lagged match scores; projecting standings from official matches', {
      tournamentId: tournament.id,
      leagueId: tournament.leagueId,
      provisionalEventId,
      officialPlayed: standingsSelection.officialPlayed,
      derivedPlayed: standingsSelection.derivedPlayed,
    });
  }
  const groupRows = projectOfficialH2HStandings(
    currentGroups,
    standingsSelection.standings,
    totalsByEntry,
  );
  const published = await tournamentOfficialH2HRepository.publish(season, tournament.id, {
    ...officialRows,
    checkedAt,
    lockSchedule: scoringSnapshot.matches.some((match) => !isOfficialKnockoutMatch(match)),
    groupRows,
    pageManifests: snapshot.pageManifests,
    fullReconcile: options.forceFull === true,
  });

  logInfo('Official H2H strategy completed', {
    tournamentId: tournament.id,
    leagueId: tournament.leagueId,
    standings: snapshot.standings.length,
    matches: snapshot.matches.length,
    scoreSource: eventLiveSnapshot ? 'FPL_EVENT_LIVE' : 'FPL_H2H_FINAL_OR_UNAVAILABLE',
    scoreRevision: eventLiveBatch?.revision ?? null,
  });
  return {
    updatedGroups: published.groupRows,
    updatedResults: published.battleRows + published.knockoutRows,
    skipped: 0,
  };
}

export const OfficialH2HStrategy = {
  sync: syncOfficialH2HTournament,
};
