import {
  readEntryLiveInputsV2,
  readLivePublicationV2,
  type EntryLivePublicationRead,
} from '../cache/live-publication-v2';
import {
  leagueEntryInputRevision,
  LIVE_LEAGUE_MAX_ENTRIES,
  readLiveLeaguePublicationV2PointersV2,
  readLiveLeaguePublicationV2Pointer,
  liveLeagueV2Key,
  publishLiveLeaguePublicationV2,
  retireLiveLeaguePublicationV2,
  setLiveLeagueCheckpointDesiredV2,
  type H2HMatchIndexRow,
  type H2HMatchPayload,
  type H2HMatchSide,
  type H2HStandingsIndexRow,
  type H2HStandingsPayload,
  type LeagueLiveIndex,
  type LeagueLiveIndexRow,
  type LeagueLiveManifest,
  type LeagueLivePointerReadV2,
  type LeagueLiveRead,
  type LeagueLiveRevisionVector,
} from '../cache/live-league-publication-v2';
import { redisSingleton } from '../cache/singleton';
import { getDbClient } from '../db/singleton';
import type { FplSeasonRef } from '../domain/fpl-season';
import {
  liveLeagueCheckpointIsDue,
  readLiveLeagueCheckpointGenerationV2,
  reconcileLiveLeagueCheckpointV2,
} from './live-league-checkpoint-v2.service';
import { rebuildFinalEntryLiveInputsV2 } from './entries.service';
import { enqueueEntryInfoSyncJob } from '../jobs/entry-sync-enqueue';
import { contentHash } from '../utils/content-hash';
import { logError, logInfo, logWarn } from '../utils/logger';
import { mapWithConcurrency } from '../utils/async';

const LIVE_LEAGUE_ALGORITHM_VERSION = 'live-league-v2:classic:1';
const LIVE_ACTIVE_CADENCE_MS = 30_000;
const LIVE_LEAGUE_CHECKPOINT_INTERVAL_MS = 10 * 60_000;
const MAX_RETIREMENT_KEYS = 10_000;

type ClassicRosterRow = {
  tournamentId: number;
  expectedEntryCount: number;
  entryId: number;
  entryName: string | null;
  playerName: string | null;
  region: string | null;
  startedEvent: number | null;
  overallPoints: number | null;
  overallRank: number | null;
  bank: number | null;
  teamValue: number | null;
  totalTransfers: number | null;
  lastEventId: number | null;
  lastOverallPoints: number | null;
  lastOverallRank: number | null;
  lastTeamValue: number | null;
  lastBank: number | null;
  profileSourceCheckedAt: Date | string | null;
  finalizationAt: Date | string | null;
};

type ClassicRosterQueryRow = Omit<ClassicRosterRow, 'entryId'> & {
  entryId: number | null;
};

type CompleteClassicRosterRow = ClassicRosterRow & {
  entryName: string;
  playerName: string;
};

type ClassicRoster = {
  readonly tournamentId: number;
  readonly expectedEntryCount: number;
  readonly rows: readonly ClassicRosterRow[];
};

function hasCompleteClassicIdentity(row: ClassicRosterRow): row is CompleteClassicRosterRow {
  return (
    typeof row.entryName === 'string' &&
    row.entryName.trim().length > 0 &&
    typeof row.playerName === 'string' &&
    row.playerName.trim().length > 0
  );
}

export type LiveLeaguePublicationSyncResult = {
  readonly globalPublicationId: string;
  readonly globalGeneration: number;
  readonly tournaments: number;
  readonly published: number;
  readonly unchanged: number;
  readonly pending: number;
  readonly skipped: number;
  readonly finalReady: boolean;
};

function checkpointNotBefore(
  previous: LeagueLiveManifest | null | undefined,
  force: boolean,
): string | null {
  if (force || !previous?.times.checkpointedAt) return null;
  const checkpointedAt = Date.parse(previous.times.checkpointedAt);
  if (!Number.isFinite(checkpointedAt)) return null;
  return new Date(checkpointedAt + LIVE_LEAGUE_CHECKPOINT_INTERVAL_MS).toISOString();
}

async function scheduleLeagueCheckpoint(
  publication: LeagueLiveManifest,
  previous: LeagueLiveManifest | null | undefined,
  scope: Parameters<typeof liveLeagueV2Key>[0],
  redis: Awaited<ReturnType<typeof redisSingleton.getClient>>,
): Promise<void> {
  const force = publication.state === 'FINALIZED';
  await setLiveLeagueCheckpointDesiredV2(publication, new Date(), {
    force,
    notBefore: checkpointNotBefore(previous, force),
    redis,
  });
  await reconcileLiveLeagueCheckpointV2(scope);
}

function maxIso(values: readonly string[]): string {
  const valid = values
    .map((value) => ({ value, time: Date.parse(value) }))
    .filter((item) => Number.isFinite(item.time));
  if (valid.length === 0) return new Date().toISOString();
  return valid.reduce((latest, item) => (item.time > latest.time ? item : latest)).value;
}

function expectedNextCheckAt(sourceCheckedAt: string, provided?: Date | string | null): string {
  if (provided !== undefined && provided !== null) {
    const date = provided instanceof Date ? provided : new Date(provided);
    if (Number.isFinite(date.getTime())) return date.toISOString();
  }
  const source = new Date(sourceCheckedAt);
  return new Date(source.getTime() + LIVE_ACTIVE_CADENCE_MS).toISOString();
}

export function isTimestampAtOrAfter(
  value: Date | string | null,
  boundary: Date | string | null,
): boolean {
  if (value === null || boundary === null) return false;
  const valueTime = value instanceof Date ? value.getTime() : Date.parse(value);
  const boundaryTime = boundary instanceof Date ? boundary.getTime() : Date.parse(boundary);
  return Number.isFinite(valueTime) && Number.isFinite(boundaryTime) && valueTime >= boundaryTime;
}

async function enqueueFinalizationProfileRefresh(
  season: FplSeasonRef,
  eventId: number,
  tournamentId: number,
  entryIds: readonly number[],
): Promise<void> {
  const uniqueEntryIds = [...new Set(entryIds)].sort((left, right) => left - right);
  if (uniqueEntryIds.length === 0) return;
  const entrySetRevision = contentHash(uniqueEntryIds);
  try {
    await enqueueEntryInfoSyncJob(season, 'reconcile', {
      entryIds: uniqueEntryIds,
      eventId,
      queueKey: `live-final-profile-${season.seasonCode}-${eventId}`,
      deduplicationId: `live-final-profile-${season.seasonCode}-${eventId}-${entrySetRevision}`,
      deduplicationCadenceMs: 60_000,
    });
  } catch (error) {
    // A queue failure must never replace the last complete board with a
    // falsely finalized identity. The next reconciler pass can enqueue it.
    logError('Failed to enqueue finalization profile refresh', error, {
      season: season.seasonCode,
      eventId,
      tournamentId,
      entries: uniqueEntryIds.length,
    });
  }
}

async function findClassicRosters(season: FplSeasonRef, eventId: number): Promise<ClassicRoster[]> {
  const client = await getDbClient();
  const rows = await client<ClassicRosterQueryRow[]>`
    SELECT
      tournament.tournament_id AS "tournamentId",
      tournament.total_team_num AS "expectedEntryCount",
      roster.entry_id AS "entryId",
      entry.entry_name AS "entryName",
      entry.player_name AS "playerName",
      entry.region,
      entry.started_event AS "startedEvent",
      entry.overall_points AS "overallPoints",
      entry.overall_rank AS "overallRank",
      entry.bank,
      entry.team_value AS "teamValue",
      entry.total_transfers AS "totalTransfers",
      entry.last_event_id AS "lastEventId",
      entry.last_overall_points AS "lastOverallPoints",
      -- The repository uses zero as the "no previous rank" sentinel. The V2
      -- publication contract exposes absence as null, never as a fake rank.
      NULLIF(entry.last_overall_rank, 0) AS "lastOverallRank",
      entry.last_team_value AS "lastTeamValue",
      entry.last_bank AS "lastBank",
      entry.profile_source_checked_at AS "profileSourceCheckedAt",
      event.data_checked_at AS "finalizationAt"
    FROM competition.tournaments AS tournament
    INNER JOIN fpl.events AS event
      ON event.season_id = tournament.season_id
     AND event.event_id = ${eventId}
    LEFT JOIN competition.tournament_entries AS roster
      ON roster.season_id = tournament.season_id
     AND roster.tournament_id = tournament.tournament_id
    LEFT JOIN competition.entries AS entry
      ON entry.season_id = roster.season_id
     AND entry.entry_id = roster.entry_id
    WHERE tournament.season_id = ${season.seasonId}
      AND tournament.league_type = 'classic'
      AND tournament.state = 'active'
      AND tournament.setup_status = 'ready'
    ORDER BY tournament.tournament_id, roster.entry_id
  `;
  const byTournament = new Map<number, ClassicRosterRow[]>();
  for (const row of rows) {
    const tournamentId = Number(row.tournamentId);
    const expectedEntryCount = Number(row.expectedEntryCount);
    if (!Number.isSafeInteger(tournamentId) || tournamentId <= 0) continue;
    if (!Number.isSafeInteger(expectedEntryCount) || expectedEntryCount <= 0) continue;
    const bucket = byTournament.get(tournamentId) ?? [];
    byTournament.set(tournamentId, bucket);
    if (row.entryId === null) continue;
    const entryId = Number(row.entryId);
    if (!Number.isSafeInteger(entryId) || entryId <= 0) continue;
    bucket.push({ ...row, tournamentId, entryId, expectedEntryCount });
  }
  return [...byTournament.entries()].map(([tournamentId, rows]) => ({
    tournamentId,
    expectedEntryCount: rows[0]?.expectedEntryCount ?? 0,
    rows,
  }));
}

function buildRevisions(
  roster: ClassicRoster,
  global: Awaited<ReturnType<typeof readLivePublicationV2>>,
  index: readonly LeagueLiveIndexRow[],
  payload: Record<string, unknown>,
): LeagueLiveRevisionVector {
  if (!global) throw new Error('Cannot build a league publication without global publication');
  const identity = index.map((row) => ({
    entryId: row.entryId,
    entryName: row.entryName,
    playerName: row.playerName,
    region: row.region,
    startedEvent: row.startedEvent,
    overallPoints: row.overallPoints,
    overallRank: row.overallRank,
    bank: row.bank,
    teamValue: row.teamValue,
    totalTransfers: row.totalTransfers,
    lastEventId: row.lastEventId,
    lastOverallPoints: row.lastOverallPoints,
    lastOverallRank: row.lastOverallRank,
    lastTeamValue: row.lastTeamValue,
    lastBank: row.lastBank,
  }));
  const entryInputSet = index
    .map((row) => ({
      entryId: row.entryId,
      inputRevision: row.inputRevision,
      availability: row.availability,
    }))
    .sort((left, right) => left.entryId - right.entryId);
  const algorithm = contentHash(LIVE_LEAGUE_ALGORITHM_VERSION);
  return {
    roster: contentHash(
      roster.rows.map(
        ({
          tournamentId: _tournamentId,
          profileSourceCheckedAt: _profileSourceCheckedAt,
          finalizationAt: _finalizationAt,
          ...row
        }) => row,
      ),
    ),
    scoreCore: global.publication.revisions.scoreCore.revision,
    fixtureIdentity: global.publication.revisions.fixtureIdentity.revision,
    entryInputSet: contentHash(entryInputSet),
    identity: contentHash(identity),
    officialRank: contentHash(index.map((row) => [row.entryId, row.overallRank])),
    rules: global.publication.revisions.rules.revision,
    algorithm,
    schedule: null,
    averageSide: null,
    content: contentHash({
      index,
      payload,
      scoreCore: global.publication.revisions.scoreCore.revision,
      fixtureIdentity: global.publication.revisions.fixtureIdentity.revision,
      rules: global.publication.revisions.rules.revision,
      algorithm,
    }),
  };
}

async function publishClassicRoster(
  season: FplSeasonRef,
  eventId: number,
  global: NonNullable<Awaited<ReturnType<typeof readLivePublicationV2>>>,
  roster: ClassicRoster,
  expectedNextCheckAtValue?: Date | string | null,
): Promise<'published' | 'unchanged' | 'pending' | 'skipped'> {
  if (roster.expectedEntryCount > 5_000) return 'skipped';
  if (roster.rows.length === 0) return 'pending';
  const entryIds = new Set(roster.rows.map((row) => row.entryId));
  if (
    roster.expectedEntryCount <= 0 ||
    roster.rows.length !== roster.expectedEntryCount ||
    entryIds.size !== roster.rows.length
  ) {
    return 'pending';
  }
  const completeRows = roster.rows.filter(hasCompleteClassicIdentity);
  if (completeRows.length !== roster.rows.length) return 'pending';
  const eligibleRows = completeRows.filter(
    (row) => row.startedEvent === null || row.startedEvent <= eventId,
  );
  const redis = await redisSingleton.getClient();
  let inputs = await readEntryLiveInputsV2(
    eligibleRows.map((row) => ({ season: season.seasonCode, eventId, entryId: row.entryId })),
    redis,
  );
  const entriesNeedingFinalRecovery = eligibleRows.filter((row) => {
    const read = inputs.get(row.entryId);
    return !read || read.input.finalResult === null;
  });
  if (global.publication.state === 'FINALIZED' && entriesNeedingFinalRecovery.length > 0) {
    const finalizationAt = completeRows.find((row) => row.finalizationAt !== null)?.finalizationAt;
    if (finalizationAt !== undefined && finalizationAt !== null) {
      await rebuildFinalEntryLiveInputsV2(
        season,
        eventId,
        entriesNeedingFinalRecovery.map((row) => row.entryId),
        finalizationAt,
        redis,
      );
      inputs = await readEntryLiveInputsV2(
        eligibleRows.map((row) => ({ season: season.seasonCode, eventId, entryId: row.entryId })),
        redis,
      );
    }
  }
  const finalizationAt =
    completeRows.find((row) => row.finalizationAt !== null)?.finalizationAt ?? null;
  const entriesNeedingProfileRefresh =
    global.publication.state === 'FINALIZED'
      ? eligibleRows
          .filter((row) => !isTimestampAtOrAfter(row.profileSourceCheckedAt, finalizationAt))
          .map((row) => row.entryId)
      : [];
  if (entriesNeedingProfileRefresh.length > 0 && finalizationAt !== null) {
    await enqueueFinalizationProfileRefresh(
      season,
      eventId,
      roster.tournamentId,
      entriesNeedingProfileRefresh,
    );
  }
  const allFinal =
    global.publication.state !== 'FINALIZED' ||
    eligibleRows.every((row) => {
      const read = inputs.get(row.entryId);
      return (
        read?.input.finalResult !== null &&
        read?.input.finalResult !== undefined &&
        isTimestampAtOrAfter(row.profileSourceCheckedAt, finalizationAt)
      );
    });
  if (inputs.size !== eligibleRows.length || !allFinal) {
    return 'pending';
  }

  const index: LeagueLiveIndexRow[] = completeRows.map((row) => {
    if (row.startedEvent !== null && row.startedEvent > eventId) {
      return {
        entryId: row.entryId,
        availability: 'NO_PICKS',
        entryName: row.entryName,
        playerName: row.playerName,
        region: row.region,
        startedEvent: row.startedEvent,
        overallPoints: row.overallPoints,
        overallRank: row.overallRank,
        bank: row.bank,
        teamValue: row.teamValue,
        totalTransfers: row.totalTransfers,
        lastEventId: row.lastEventId,
        lastOverallPoints: row.lastOverallPoints,
        lastOverallRank: row.lastOverallRank,
        lastTeamValue: row.lastTeamValue,
        lastBank: row.lastBank,
        inputPublicationId: null,
        inputGeneration: null,
        inputRevision: null,
        inputContentUpdatedAt: null,
      } satisfies LeagueLiveIndexRow;
    }
    const read = inputs.get(row.entryId);
    if (!read) throw new Error(`Missing complete live input for entry ${row.entryId}`);
    const finalResult = read.input.finalResult;
    return {
      entryId: row.entryId,
      availability: 'READY',
      entryName: row.entryName,
      playerName: row.playerName,
      region: row.region,
      startedEvent: row.startedEvent,
      overallPoints:
        global.publication.state === 'FINALIZED'
          ? (finalResult?.score.totalPoints ?? null)
          : row.overallPoints,
      overallRank: row.overallRank,
      bank: row.bank,
      teamValue: row.teamValue,
      totalTransfers: row.totalTransfers,
      lastEventId: row.lastEventId,
      lastOverallPoints: row.lastOverallPoints,
      lastOverallRank: row.lastOverallRank,
      lastTeamValue: row.lastTeamValue,
      lastBank: row.lastBank,
      inputPublicationId: read.publication.publicationId,
      inputGeneration: read.publication.generation,
      inputRevision: leagueEntryInputRevision(read.input),
      inputContentUpdatedAt: read.input.picksBase.contentUpdatedAt,
    };
  });
  const payload = Object.fromEntries(
    index.map((row) => [
      String(row.entryId),
      row.availability === 'NO_PICKS' ? null : inputs.get(row.entryId)!.input,
    ]),
  );
  const revisions = buildRevisions(roster, global, index, payload);
  const scope = {
    season: season.seasonCode,
    eventId,
    tournamentId: roster.tournamentId,
    scope: 'CLASSIC' as const,
  };
  const result = await publishLiveLeaguePublicationV2({
    scope,
    state: global.publication.state,
    sourceCheckedAt: global.publication.sourceCheckedAt,
    contentUpdatedAt: maxIso([
      global.publication.revisions.scoreCore.contentUpdatedAt,
      ...index.map((row) => row.inputContentUpdatedAt!).filter(Boolean),
    ]),
    expectedNextCheckAt: expectedNextCheckAt(
      global.publication.sourceCheckedAt,
      expectedNextCheckAtValue,
    ),
    globalRef: {
      publicationId: global.publication.publicationId,
      generation: global.publication.generation,
    },
    revisions,
    counts: {
      expected: index.length,
      published: index.length,
      ready: index.filter((row) => row.availability === 'READY').length,
      noPicks: index.filter((row) => row.availability === 'NO_PICKS').length,
    },
    index,
    payload,
    generationFloorLoader: () => readLiveLeagueCheckpointGenerationV2(scope),
    redis,
  });
  const candidateRead = {
    publication: result.publication,
    index,
    payload,
    servedFrom: 'REDIS_CURRENT' as const,
  };
  if (
    (result.publication.revisions.content === revisions.content && result.published) ||
    result.publication.times.checkpointedAt === null ||
    liveLeagueCheckpointIsDue(candidateRead, result.publication.state === 'FINALIZED')
  ) {
    await scheduleLeagueCheckpoint(result.publication, result.previous, scope, redis);
  }
  return result.published ? 'published' : 'unchanged';
}

/**
 * Publishes complete Classic tournament boards after the global observer has
 * published.  It is intentionally a best-effort sibling: a broken roster or
 * entry input leaves the last complete board in Redis and never invalidates
 * the global live publication.
 */
export async function syncLiveClassicLeaguePublicationsV2(
  season: FplSeasonRef,
  eventId: number,
  expectedNextCheckAtValue?: Date | string | null,
): Promise<LiveLeaguePublicationSyncResult | null> {
  const redis = await redisSingleton.getClient();
  const global = await readLivePublicationV2({ season: season.seasonCode, eventId }, redis);
  if (!global) return null;
  const rosters = await findClassicRosters(season, eventId);
  await retireInactiveClassicPublications(
    season,
    eventId,
    new Set(rosters.map(({ tournamentId }) => tournamentId)),
    redis,
  );
  const counts = {
    published: 0,
    unchanged: 0,
    pending: 0,
    skipped: 0,
  };
  for (const roster of rosters) {
    try {
      const status = await publishClassicRoster(
        season,
        eventId,
        global,
        roster,
        expectedNextCheckAtValue,
      );
      counts[status] += 1;
    } catch (error) {
      counts.skipped += 1;
      logError('Live Classic league publication failed; retaining previous board', error, {
        season: season.seasonCode,
        eventId,
        tournamentId: roster.tournamentId,
      });
    }
  }
  const finalReady =
    global.publication.state !== 'FINALIZED' ||
    (
      await Promise.all(
        rosters.map(async (roster) => {
          const read = await readLiveLeaguePublicationV2Pointer(
            {
              season: season.seasonCode,
              eventId,
              tournamentId: roster.tournamentId,
              scope: 'CLASSIC',
            },
            'active',
            redis,
          );
          return (
            read?.publication.state === 'FINALIZED' &&
            read.publication.times.checkpointedAt !== null
          );
        }),
      )
    ).every(Boolean);
  logInfo('Live Classic league publications synchronized', {
    season: season.seasonCode,
    eventId,
    globalPublicationId: global.publication.publicationId,
    globalGeneration: global.publication.generation,
    tournaments: rosters.length,
    ...counts,
    finalReady,
  });
  return {
    globalPublicationId: global.publication.publicationId,
    globalGeneration: global.publication.generation,
    tournaments: rosters.length,
    ...counts,
    finalReady,
  };
}

export function liveLeagueClassicPointerKey(
  season: string,
  eventId: number,
  tournamentId: number,
): string {
  return liveLeagueV2Key({ season, eventId, tournamentId, scope: 'CLASSIC' }, 'active');
}

type H2HTournamentRow = {
  tournamentId: number;
  groupStartedEventId: number | null;
  groupEndedEventId: number | null;
  knockoutStartedEventId: number | null;
  knockoutEndedEventId: number | null;
};

type H2HMatchRow = {
  tournamentId: number;
  officialMatchId: number;
  eventId: number;
  groupId: number;
  sourceOrder: number;
  phase: 'REGULAR' | 'KNOCKOUT';
  knockoutName: string | null;
  tiebreak: string | null;
  isBye: boolean;
  homeEntryId: number | null;
  homeEntryName: string | null;
  homePlayerName: string | null;
  homeProfileSourceCheckedAt: Date | string | null;
  homeNetPoints: number | null;
  homeIsAverage: boolean;
  awayEntryId: number | null;
  awayEntryName: string | null;
  awayPlayerName: string | null;
  awayProfileSourceCheckedAt: Date | string | null;
  awayNetPoints: number | null;
  awayIsAverage: boolean;
  sourceCheckedAt: Date | string | null;
  finalizationAt: Date | string | null;
};

type H2HStandingRow = {
  entryId: number;
  entryName: string | null;
  playerName: string | null;
  rank: number | null;
  matchPoints: number | null;
  played: number | null;
  won: number | null;
  drawn: number | null;
  lost: number | null;
  pointsFor: number | null;
  sourceCheckedAt: Date | string | null;
  finalizationAt: Date | string | null;
  throughEventId: number;
  expectedMatchCount: number;
  completeMatchCount: number;
  completeMissingSourceCount: number;
  oldestCompleteSourceCheckedAt: Date | string | null;
};

type H2HStandingsRead = {
  readonly rows: readonly H2HStandingRow[];
  readonly sourceCheckedAt: Date | string | null;
  readonly finalizationAt: Date | string | null;
  readonly throughEventId: number;
  readonly expectedMatchCount: number;
  readonly completeMatchCount: number;
  readonly completeMissingSourceCount: number;
  readonly oldestCompleteSourceCheckedAt: Date | string | null;
};

type H2HPreparedMatch = {
  readonly index: H2HMatchIndexRow;
  readonly payload: H2HMatchPayload;
  readonly finalReady: boolean;
};

type OfficialH2HTournament = {
  readonly tournamentId: number;
  readonly groupStartedEventId: number | null;
  readonly groupEndedEventId: number | null;
  readonly knockoutStartedEventId: number | null;
  readonly knockoutEndedEventId: number | null;
};

export function isH2HTournamentPhaseActive(
  tournament: Pick<
    OfficialH2HTournament,
    'groupStartedEventId' | 'groupEndedEventId' | 'knockoutStartedEventId' | 'knockoutEndedEventId'
  >,
  eventId: number,
): boolean {
  const phases = [
    [tournament.groupStartedEventId, tournament.groupEndedEventId],
    [tournament.knockoutStartedEventId, tournament.knockoutEndedEventId],
  ] as const;
  const hasConfiguredPhase = phases.some(([start, end]) => start !== null || end !== null);
  if (!hasConfiguredPhase) return true;
  return phases.some(
    ([start, end]) =>
      (start !== null && eventId >= start && (end === null || eventId <= end)) ||
      (start === null && end !== null && eventId <= end),
  );
}

/**
 * A source response may add a newly scheduled match, but it must never make
 * an already published canonical match disappear. This is the completeness
 * fence used before rebuilding a tournament head.
 */
export function hasExpectedH2HMatchSet(
  expectedMatchIds: readonly number[],
  observedMatchIds: readonly number[],
): boolean {
  const observed = new Set(observedMatchIds);
  return (
    observed.size === observedMatchIds.length &&
    expectedMatchIds.every((matchId) => observed.has(matchId))
  );
}

async function findOfficialH2HTournaments(
  season: FplSeasonRef,
): Promise<readonly OfficialH2HTournament[]> {
  const client = await getDbClient();
  const rows = await client<H2HTournamentRow[]>`
    SELECT
      tournament_id AS "tournamentId",
      group_started_event_id AS "groupStartedEventId",
      group_ended_event_id AS "groupEndedEventId",
      knockout_started_event_id AS "knockoutStartedEventId",
      knockout_ended_event_id AS "knockoutEndedEventId"
    FROM competition.tournaments
    WHERE season_id = ${season.seasonId}
      AND league_type = 'h2h'
      AND roster_mode = 'official_sync'
      AND group_mode = 'battle_races'
      AND state = 'active'
      AND setup_status = 'ready'
    ORDER BY tournament_id
  `;
  return rows
    .map((row) => ({
      tournamentId: Number(row.tournamentId),
      groupStartedEventId:
        row.groupStartedEventId === null ? null : Number(row.groupStartedEventId),
      groupEndedEventId: row.groupEndedEventId === null ? null : Number(row.groupEndedEventId),
      knockoutStartedEventId:
        row.knockoutStartedEventId === null ? null : Number(row.knockoutStartedEventId),
      knockoutEndedEventId:
        row.knockoutEndedEventId === null ? null : Number(row.knockoutEndedEventId),
    }))
    .filter(
      (value) =>
        Number.isSafeInteger(value.tournamentId) &&
        value.tournamentId > 0 &&
        [
          value.groupStartedEventId,
          value.groupEndedEventId,
          value.knockoutStartedEventId,
          value.knockoutEndedEventId,
        ].every((event) => event === null || (Number.isSafeInteger(event) && event > 0)),
    );
}

function h2hScopeKeyPrefix(season: string, eventId: number): string {
  return `llm:data:v2:fpl:league-live:${season}:${eventId}`;
}

function h2hHeadTournamentIdFromKey(key: string, season: string, eventId: number): number | null {
  const prefix = `${h2hScopeKeyPrefix(season, eventId)}:`;
  const suffix = ':h2h-head:active';
  if (!key.startsWith(prefix) || !key.endsWith(suffix)) return null;
  const tournamentId = key.slice(prefix.length, -suffix.length);
  return /^\d+$/.test(tournamentId) && Number(tournamentId) > 0 ? Number(tournamentId) : null;
}

function h2hMatchScopeFromKey(
  key: string,
  season: string,
  eventId: number,
): { tournamentId: number; matchId: number } | null {
  const prefix = `${h2hScopeKeyPrefix(season, eventId)}:`;
  const match = key.slice(prefix.length).match(/^(\d+):h2h-match-(\d+):active$/);
  if (!match) return null;
  const tournamentId = Number(match[1]);
  const matchId = Number(match[2]);
  return Number.isSafeInteger(tournamentId) &&
    tournamentId > 0 &&
    Number.isSafeInteger(matchId) &&
    matchId > 0
    ? { tournamentId, matchId }
    : null;
}

async function scanH2HPublicationKeys(
  redis: Awaited<ReturnType<typeof redisSingleton.getClient>>,
  season: string,
  eventId: number,
  kind: 'classic' | 'head' | 'match',
): Promise<string[]> {
  const pattern =
    kind === 'classic'
      ? `${h2hScopeKeyPrefix(season, eventId)}:*:classic:active`
      : kind === 'head'
        ? `${h2hScopeKeyPrefix(season, eventId)}:*:h2h-head:active`
        : `${h2hScopeKeyPrefix(season, eventId)}:*:h2h-match-*:active`;
  const keys: string[] = [];
  let cursor = '0';
  do {
    const result = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', '200');
    cursor = result[0];
    keys.push(...result[1]);
    if (keys.length > MAX_RETIREMENT_KEYS) {
      throw new Error('Live league retirement scan exceeded its safety bound');
    }
  } while (cursor !== '0');
  return keys;
}

function classicTournamentIdFromKey(key: string, season: string, eventId: number): number | null {
  const prefix = `${h2hScopeKeyPrefix(season, eventId)}:`;
  const suffix = ':classic:active';
  if (!key.startsWith(prefix) || !key.endsWith(suffix)) return null;
  const tournamentId = key.slice(prefix.length, -suffix.length);
  return /^\d+$/.test(tournamentId) && Number(tournamentId) > 0 ? Number(tournamentId) : null;
}

async function retireInactiveClassicPublications(
  season: FplSeasonRef,
  eventId: number,
  activeTournamentIds: ReadonlySet<number>,
  redis: Awaited<ReturnType<typeof redisSingleton.getClient>>,
): Promise<void> {
  try {
    const keys = await scanH2HPublicationKeys(redis, season.seasonCode, eventId, 'classic');
    const orphanTournamentIds = keys
      .map((key) => classicTournamentIdFromKey(key, season.seasonCode, eventId))
      .filter((id): id is number => id !== null && !activeTournamentIds.has(id));
    if (orphanTournamentIds.length === 0) return;
    const uniqueOrphans = [...new Set(orphanTournamentIds)];
    const retired = await mapWithConcurrency(uniqueOrphans, 8, (tournamentId) =>
      retireLiveLeaguePublicationV2(
        { season: season.seasonCode, eventId, tournamentId, scope: 'CLASSIC' },
        redis,
      ),
    );
    logInfo('Inactive Classic league publications retired', {
      season: season.seasonCode,
      eventId,
      tournaments: uniqueOrphans.length,
      scopes: retired.filter(Boolean).length,
    });
  } catch (error) {
    // Retirement is hygiene only. A bounded scan or exact pointer CAS failure
    // must never block a live publication for an active tournament.
    logWarn('Failed to retire inactive Classic league publications', {
      season: season.seasonCode,
      eventId,
      error: error instanceof Error ? error.message : 'unknown',
    });
  }
}

async function retireInactiveH2HPublications(
  season: FplSeasonRef,
  eventId: number,
  activeTournamentIds: ReadonlySet<number>,
  redis: Awaited<ReturnType<typeof redisSingleton.getClient>>,
): Promise<void> {
  try {
    const [headKeys, matchKeys] = await Promise.all([
      scanH2HPublicationKeys(redis, season.seasonCode, eventId, 'head'),
      scanH2HPublicationKeys(redis, season.seasonCode, eventId, 'match'),
    ]);
    const orphanTournamentIds = new Set(
      headKeys
        .map((key) => h2hHeadTournamentIdFromKey(key, season.seasonCode, eventId))
        .filter((id): id is number => id !== null && !activeTournamentIds.has(id)),
    );
    const orphanMatches = matchKeys
      .map((key) => h2hMatchScopeFromKey(key, season.seasonCode, eventId))
      .filter(
        (scope): scope is { tournamentId: number; matchId: number } =>
          scope !== null && !activeTournamentIds.has(scope.tournamentId),
      );
    for (const match of orphanMatches) orphanTournamentIds.add(match.tournamentId);
    if (orphanTournamentIds.size === 0) return;

    const scopes = [...orphanTournamentIds].flatMap((tournamentId) => [
      {
        season: season.seasonCode,
        eventId,
        tournamentId,
        scope: 'H2H_HEAD' as const,
      },
      {
        season: season.seasonCode,
        eventId,
        tournamentId,
        scope: 'H2H_STANDINGS' as const,
      },
      ...orphanMatches
        .filter((match) => match.tournamentId === tournamentId)
        .map((match) => ({
          season: season.seasonCode,
          eventId,
          tournamentId,
          scope: 'H2H_MATCH' as const,
          matchId: match.matchId,
        })),
    ]);
    const retired = await mapWithConcurrency(scopes, 8, async (scope) =>
      retireLiveLeaguePublicationV2(scope, redis),
    );
    logInfo('Inactive H2H league publications retired', {
      season: season.seasonCode,
      eventId,
      tournaments: orphanTournamentIds.size,
      scopes: retired.filter(Boolean).length,
    });
  } catch (error) {
    // Retirement is a background hygiene pass. A Redis scan or an exact
    // pointer CAS failure must never block active tournament publication.
    logWarn('Failed to retire inactive H2H league publications', {
      season: season.seasonCode,
      eventId,
      error: error instanceof Error ? error.message : 'unknown',
    });
  }
}

async function findOfficialH2HMatches(
  season: FplSeasonRef,
  tournamentId: number,
  eventId: number,
): Promise<H2HMatchRow[]> {
  const client = await getDbClient();
  const rows = await client<H2HMatchRow[]>`
    SELECT
      battle.tournament_id AS "tournamentId",
      battle.official_match_id AS "officialMatchId",
      battle.event_id AS "eventId",
      battle.group_id AS "groupId",
      battle.source_order AS "sourceOrder",
      'REGULAR'::text AS "phase",
      NULL::text AS "knockoutName",
      NULL::text AS "tiebreak",
      battle.is_bye AS "isBye",
      battle.home_entry_id AS "homeEntryId",
      home_entry.entry_name AS "homeEntryName",
      home_entry.player_name AS "homePlayerName",
      home_entry.profile_source_checked_at AS "homeProfileSourceCheckedAt",
      battle.home_net_points AS "homeNetPoints",
      battle.home_is_average AS "homeIsAverage",
      battle.away_entry_id AS "awayEntryId",
      away_entry.entry_name AS "awayEntryName",
      away_entry.player_name AS "awayPlayerName",
      away_entry.profile_source_checked_at AS "awayProfileSourceCheckedAt",
      battle.away_net_points AS "awayNetPoints",
      battle.away_is_average AS "awayIsAverage",
      battle.source_checked_at AS "sourceCheckedAt",
      event.data_checked_at AS "finalizationAt"
    FROM competition.tournament_battle_group_results AS battle
    INNER JOIN fpl.events AS event
      ON event.season_id = battle.season_id
     AND event.event_id = battle.event_id
    LEFT JOIN competition.entries AS home_entry
      ON home_entry.season_id = battle.season_id
     AND home_entry.entry_id = battle.home_entry_id
    LEFT JOIN competition.entries AS away_entry
      ON away_entry.season_id = battle.season_id
     AND away_entry.entry_id = battle.away_entry_id
    WHERE battle.season_id = ${season.seasonId}
      AND battle.tournament_id = ${tournamentId}
      AND battle.event_id = ${eventId}
      AND battle.official_match_id IS NOT NULL
    UNION ALL
    SELECT
      knockout.tournament_id AS "tournamentId",
      knockout.official_match_id AS "officialMatchId",
      knockout.event_id AS "eventId",
      0 AS "groupId",
      knockout.source_order AS "sourceOrder",
      'KNOCKOUT'::text AS "phase",
      knockout.knockout_name AS "knockoutName",
      knockout.tiebreak AS "tiebreak",
      (knockout.home_entry_id IS NULL OR knockout.away_entry_id IS NULL) AS "isBye",
      knockout.home_entry_id AS "homeEntryId",
      home_entry.entry_name AS "homeEntryName",
      home_entry.player_name AS "homePlayerName",
      home_entry.profile_source_checked_at AS "homeProfileSourceCheckedAt",
      knockout.home_net_points AS "homeNetPoints",
      false AS "homeIsAverage",
      knockout.away_entry_id AS "awayEntryId",
      away_entry.entry_name AS "awayEntryName",
      away_entry.player_name AS "awayPlayerName",
      away_entry.profile_source_checked_at AS "awayProfileSourceCheckedAt",
      knockout.away_net_points AS "awayNetPoints",
      false AS "awayIsAverage",
      knockout.source_checked_at AS "sourceCheckedAt",
      event.data_checked_at AS "finalizationAt"
    FROM competition.tournament_knockout_results AS knockout
    INNER JOIN fpl.events AS event
      ON event.season_id = knockout.season_id
     AND event.event_id = knockout.event_id
    LEFT JOIN competition.entries AS home_entry
      ON home_entry.season_id = knockout.season_id
     AND home_entry.entry_id = knockout.home_entry_id
    LEFT JOIN competition.entries AS away_entry
      ON away_entry.season_id = knockout.season_id
     AND away_entry.entry_id = knockout.away_entry_id
    WHERE knockout.season_id = ${season.seasonId}
      AND knockout.tournament_id = ${tournamentId}
      AND knockout.event_id = ${eventId}
      AND knockout.official_match_id IS NOT NULL
    ORDER BY "sourceOrder", "officialMatchId"
  `;
  return rows.map((row) => ({
    ...row,
    tournamentId: Number(row.tournamentId),
    officialMatchId: Number(row.officialMatchId),
    eventId: Number(row.eventId),
    groupId: Number(row.groupId),
    sourceOrder: Number(row.sourceOrder),
    homeEntryId: row.homeEntryId === null ? null : Number(row.homeEntryId),
    awayEntryId: row.awayEntryId === null ? null : Number(row.awayEntryId),
    homeNetPoints: row.homeNetPoints === null ? null : Number(row.homeNetPoints),
    awayNetPoints: row.awayNetPoints === null ? null : Number(row.awayNetPoints),
  }));
}

async function findOfficialH2HStandings(
  season: FplSeasonRef,
  eventId: number,
  tournamentId: number,
): Promise<H2HStandingsRead> {
  const client = await getDbClient();
  const rows = await client<H2HStandingRow[]>`
    WITH roster AS (
      SELECT
        groups.entry_id,
        entry.entry_name,
        entry.player_name,
        MAX(groups.official_source_checked_at) AS source_checked_at
      FROM competition.tournament_groups AS groups
      LEFT JOIN competition.entries AS entry
        ON entry.season_id = groups.season_id
       AND entry.entry_id = groups.entry_id
      WHERE groups.season_id = ${season.seasonId}
        AND groups.tournament_id = ${tournamentId}
        AND groups.entry_id IS NOT NULL
      GROUP BY groups.entry_id, entry.entry_name, entry.player_name
    ), match_rows AS (
      SELECT
        battle.event_id,
        battle.source_checked_at,
        battle.home_entry_id,
        battle.home_match_points,
        battle.home_net_points,
        battle.away_entry_id,
        battle.away_match_points,
        battle.away_net_points,
        (
          result_event.finished = true
          AND result_event.data_checked = true
          AND result_event.data_checked_at IS NOT NULL
          AND (
            (battle.is_bye = true AND battle.home_entry_id IS NULL)
            OR (battle.home_match_points IS NOT NULL AND battle.home_net_points IS NOT NULL)
          )
          AND (
            (battle.is_bye = true AND battle.away_entry_id IS NULL)
            OR (battle.away_match_points IS NOT NULL AND battle.away_net_points IS NOT NULL)
          )
        ) AS is_complete
      FROM competition.tournament_battle_group_results AS battle
      LEFT JOIN fpl.events AS result_event
        ON result_event.season_id = battle.season_id
       AND result_event.event_id = battle.event_id
      WHERE battle.season_id = ${season.seasonId}
        AND battle.tournament_id = ${tournamentId}
        AND battle.event_id <= ${eventId}
        AND battle.official_match_id IS NOT NULL
    ), complete_matches AS (
      SELECT
        match_rows.event_id,
        match_rows.source_checked_at,
        match_rows.home_entry_id,
        match_rows.home_match_points,
        match_rows.home_net_points,
        match_rows.away_entry_id,
        match_rows.away_match_points,
        match_rows.away_net_points
      FROM match_rows
      WHERE match_rows.is_complete
    ), match_coverage AS (
      SELECT
        COUNT(*)::integer AS "expectedMatchCount",
        COUNT(*) FILTER (WHERE match_rows.is_complete)::integer AS "completeMatchCount",
        COUNT(*) FILTER (WHERE match_rows.is_complete AND match_rows.source_checked_at IS NULL)::integer AS "completeMissingSourceCount",
        MIN(match_rows.source_checked_at) FILTER (WHERE match_rows.is_complete) AS "oldestCompleteSourceCheckedAt"
      FROM match_rows
    ), official_sides AS (
      SELECT
        battle.event_id,
        battle.source_checked_at,
        battle.home_entry_id AS entry_id,
        battle.home_match_points AS match_points,
        battle.home_net_points AS points_for
      FROM complete_matches AS battle
      WHERE battle.home_entry_id IS NOT NULL
      UNION ALL
      SELECT
        battle.event_id,
        battle.source_checked_at,
        battle.away_entry_id AS entry_id,
        battle.away_match_points AS match_points,
        battle.away_net_points AS points_for
      FROM complete_matches AS battle
      WHERE battle.away_entry_id IS NOT NULL
    ), aggregates AS (
      SELECT
        roster.entry_id AS "entryId",
        roster.entry_name AS "entryName",
        roster.player_name AS "playerName",
        COALESCE(SUM(official_sides.match_points), 0)::integer AS "matchPoints",
        COUNT(official_sides.match_points)::integer AS played,
        COUNT(*) FILTER (WHERE official_sides.match_points = 3)::integer AS won,
        COUNT(*) FILTER (WHERE official_sides.match_points = 1)::integer AS drawn,
        COUNT(*) FILTER (WHERE official_sides.match_points = 0)::integer AS lost,
        COALESCE(SUM(official_sides.points_for), 0)::integer AS "pointsFor",
        CASE
          WHEN roster.source_checked_at IS NULL THEN MAX(official_sides.source_checked_at)
          WHEN MAX(official_sides.source_checked_at) IS NULL THEN roster.source_checked_at
          WHEN roster.source_checked_at >= MAX(official_sides.source_checked_at)
            THEN roster.source_checked_at
          ELSE MAX(official_sides.source_checked_at)
        END AS "sourceCheckedAt"
      FROM roster
      LEFT JOIN official_sides ON official_sides.entry_id = roster.entry_id
      GROUP BY
        roster.entry_id,
        roster.entry_name,
        roster.player_name,
        roster.source_checked_at
    ), ranked AS (
      SELECT
        aggregates.*,
        RANK() OVER (ORDER BY aggregates."matchPoints" DESC, aggregates."pointsFor" DESC) AS rank
      FROM aggregates
    ), coverage AS (
      SELECT
        COALESCE(MAX(official_sides.event_id), 0)::integer AS "throughEventId",
        match_coverage."expectedMatchCount",
        match_coverage."completeMatchCount",
        match_coverage."completeMissingSourceCount",
        match_coverage."oldestCompleteSourceCheckedAt"
      FROM match_coverage
      LEFT JOIN official_sides ON true
      GROUP BY
        match_coverage."expectedMatchCount",
        match_coverage."completeMatchCount",
        match_coverage."completeMissingSourceCount",
        match_coverage."oldestCompleteSourceCheckedAt"
    )
    SELECT
      ranked."entryId",
      ranked."entryName",
      ranked."playerName",
      ranked.rank,
      ranked."matchPoints",
      ranked.played,
      ranked.won,
      ranked.drawn,
      ranked.lost,
      ranked."pointsFor",
      ranked."sourceCheckedAt",
      coverage."throughEventId",
      coverage."expectedMatchCount",
      coverage."completeMatchCount",
      coverage."completeMissingSourceCount",
      coverage."oldestCompleteSourceCheckedAt",
      event.data_checked_at AS "finalizationAt"
    FROM ranked
    CROSS JOIN coverage
    INNER JOIN fpl.events AS event
      ON event.season_id = ${season.seasonId}
     AND event.event_id = ${eventId}
    ORDER BY ranked.rank, ranked."entryId"
  `;
  const normalizedRows = rows.map((row) => ({
    ...row,
    entryId: Number(row.entryId),
    rank: row.rank === null ? null : Number(row.rank),
    matchPoints: row.matchPoints === null ? null : Number(row.matchPoints),
    played: row.played === null ? null : Number(row.played),
    won: row.won === null ? null : Number(row.won),
    drawn: row.drawn === null ? null : Number(row.drawn),
    lost: row.lost === null ? null : Number(row.lost),
    pointsFor: row.pointsFor === null ? null : Number(row.pointsFor),
    throughEventId: Number(row.throughEventId),
    expectedMatchCount: Number(row.expectedMatchCount),
    completeMatchCount: Number(row.completeMatchCount),
    completeMissingSourceCount: Number(row.completeMissingSourceCount),
  }));
  const latestSourceCheckedAt = normalizedRows.reduce<Date | string | null>((latest, row) => {
    if (row.sourceCheckedAt === null) return latest;
    if (latest === null) return row.sourceCheckedAt;
    const latestTime = latest instanceof Date ? latest.getTime() : Date.parse(latest);
    const rowTime =
      row.sourceCheckedAt instanceof Date
        ? row.sourceCheckedAt.getTime()
        : Date.parse(row.sourceCheckedAt);
    return Number.isFinite(rowTime) && (!Number.isFinite(latestTime) || rowTime > latestTime)
      ? row.sourceCheckedAt
      : latest;
  }, null);
  return {
    rows: normalizedRows,
    sourceCheckedAt: latestSourceCheckedAt,
    finalizationAt: normalizedRows[0]?.finalizationAt ?? null,
    throughEventId: normalizedRows[0]?.throughEventId ?? 0,
    expectedMatchCount: normalizedRows[0]?.expectedMatchCount ?? 0,
    completeMatchCount: normalizedRows[0]?.completeMatchCount ?? 0,
    completeMissingSourceCount: normalizedRows[0]?.completeMissingSourceCount ?? 0,
    oldestCompleteSourceCheckedAt: normalizedRows[0]?.oldestCompleteSourceCheckedAt ?? null,
  };
}

function isoOrFallback(value: Date | string | null, fallback: string): string {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value === 'string' && Number.isFinite(Date.parse(value)))
    return new Date(value).toISOString();
  return fallback;
}

function h2hSide(
  entryId: number | null,
  entryName: string | null,
  playerName: string | null,
  isAverage: boolean,
  isBye: boolean,
  officialNetPoints: number | null,
  inputRead: EntryLivePublicationRead | undefined,
): H2HMatchSide {
  // FPL encodes a regular bye with a nullable side and the same nullable-side
  // marker used by its synthetic Average side. The persisted is_bye bit is the
  // only reliable discriminator; keep the publication contract explicit.
  const normalizedIsAverage = isBye && entryId === null ? false : isAverage;
  const input = entryId === null || normalizedIsAverage ? null : (inputRead?.input ?? null);
  return {
    entryId,
    entryName: normalizedIsAverage
      ? 'Average'
      : entryId === null
        ? 'Bye'
        : entryName?.trim() || `Entry ${entryId}`,
    playerName: entryId === null || normalizedIsAverage ? null : playerName,
    isAverage: normalizedIsAverage,
    officialNetPoints: normalizedIsAverage
      ? officialNetPoints
      : entryId === null
        ? null
        : officialNetPoints,
    inputPublicationId: inputRead?.publication.publicationId ?? null,
    inputGeneration: inputRead?.publication.generation ?? null,
    inputRevision: input ? leagueEntryInputRevision(input) : null,
    inputContentUpdatedAt: inputRead?.input.picksBase.contentUpdatedAt ?? null,
    input,
  };
}

function isH2HMatchPayload(value: unknown): value is H2HMatchPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    'state' in value &&
    ((value as { readonly state?: unknown }).state === 'READY' ||
      (value as { readonly state?: unknown }).state === 'PENDING' ||
      (value as { readonly state?: unknown }).state === 'ERROR')
  );
}

function h2hRevisions(
  global: NonNullable<Awaited<ReturnType<typeof readLivePublicationV2>>>,
  matches: readonly H2HPreparedMatch[],
  standings: readonly H2HStandingRow[],
): LeagueLiveRevisionVector {
  const algorithm = contentHash('live-league-v2:h2h:1');
  const roster = contentHash(
    matches
      .flatMap(({ payload }) => [payload.home.entryId, payload.away.entryId])
      .filter((entryId): entryId is number => entryId !== null)
      .sort((left, right) => left - right),
  );
  const identity = contentHash(
    matches.map(({ payload }) => [
      payload.officialMatchId,
      payload.home.entryId,
      payload.home.entryName,
      payload.away.entryId,
      payload.away.entryName,
    ]),
  );
  const entryInputSet = contentHash(
    matches
      .flatMap(({ payload }) =>
        [payload.home, payload.away]
          .filter(
            (side): side is H2HMatchPayload['home'] & { readonly entryId: number } =>
              side.entryId !== null,
          )
          .map((side) => ({
            entryId: side.entryId,
            inputRevision: side.inputRevision,
            // This vector describes the entry-input set, not the official
            // score state of the match. A final-score/average update must not
            // invalidate a picks projection when the embedded input is the
            // same. Missing input remains a stable pending input until it is
            // actually published.
            availability: side.input === null ? 'PENDING' : 'READY',
          })),
      )
      .sort((left, right) => left.entryId - right.entryId),
  );
  const schedule = contentHash(
    matches.map(({ payload }) => ({
      officialMatchId: payload.officialMatchId,
      eventId: payload.eventId,
      groupId: payload.groupId,
      sourceOrder: payload.sourceOrder,
      phase: payload.phase,
      knockoutName: payload.knockoutName,
      tiebreak: payload.tiebreak,
      homeEntryId: payload.home.entryId,
      awayEntryId: payload.away.entryId,
      isBye: payload.isBye,
    })),
  );
  const officialRank = standings.length
    ? contentHash(standings.map((row) => [row.entryId, row.rank]))
    : null;
  const averageSide = contentHash(
    matches
      .flatMap(({ payload }) => [payload.home, payload.away])
      .filter((side) => side.isAverage)
      .map((side) => ({
        entryName: side.entryName,
        officialNetPoints: side.officialNetPoints,
      }))
      .sort((left, right) => left.entryName.localeCompare(right.entryName)),
  );
  const contentMatches = matches.map(({ index, payload }) => ({
    index,
    payload: {
      ...payload,
      // sourceCheckedAt is an observation heartbeat. It must not create a
      // new league generation when the official match content is unchanged.
      sourceCheckedAt: undefined,
      home: { ...payload.home, inputContentUpdatedAt: undefined },
      away: { ...payload.away, inputContentUpdatedAt: undefined },
    },
  }));
  const content = contentHash({
    matches: contentMatches,
    standings: standings.map(
      ({ sourceCheckedAt: _sourceCheckedAt, finalizationAt: _finalizationAt, ...row }) => row,
    ),
    global: global.publication.revisions.scoreCore.revision,
    algorithm,
  });
  return {
    roster,
    scoreCore: global.publication.revisions.scoreCore.revision,
    fixtureIdentity: global.publication.revisions.fixtureIdentity.revision,
    entryInputSet,
    identity,
    officialRank,
    rules: global.publication.revisions.rules.revision,
    algorithm,
    schedule,
    averageSide,
    content,
  };
}

function h2hMatchScope(season: string, eventId: number, row: H2HMatchRow) {
  return {
    season,
    eventId,
    tournamentId: row.tournamentId,
    scope: 'H2H_MATCH' as const,
    matchId: row.officialMatchId,
  };
}

function h2hMatchIndexFromPayload(payload: H2HMatchPayload): H2HMatchIndexRow {
  return {
    matchId: payload.officialMatchId,
    eventId: payload.eventId,
    groupId: payload.groupId,
    sourceOrder: payload.sourceOrder,
    phase: payload.phase,
    availability: payload.state,
    homeEntryId: payload.home.entryId,
    awayEntryId: payload.away.entryId,
  };
}

function readH2HMatchPayload(
  read: LeagueLiveRead | null | undefined,
  matchId: number,
): H2HMatchPayload | null {
  const value = read?.payload[String(matchId)];
  return isH2HMatchPayload(value) ? value : null;
}

export function selectRetainedH2HMatchPayload(
  active: H2HMatchPayload | null | undefined,
  previous: H2HMatchPayload | null | undefined,
  fallback: H2HMatchPayload,
): H2HMatchPayload {
  return (
    (active?.state === 'READY' ? active : null) ??
    (previous?.state === 'READY' ? previous : null) ??
    active ??
    previous ??
    fallback
  );
}

function finalInputAvailable(
  entryId: number | null,
  isAverage: boolean,
  inputRead: EntryLivePublicationRead | undefined,
  profileSourceCheckedAt: Date | string | null,
  finalizationAt: Date | string | null,
): boolean {
  return (
    entryId === null ||
    isAverage ||
    (inputRead?.input.finalResult !== null &&
      isTimestampAtOrAfter(profileSourceCheckedAt, finalizationAt))
  );
}

export function hasCompleteH2HOfficialScores(
  homeEntryId: number | null,
  homeNetPoints: number | null,
  awayEntryId: number | null,
  awayNetPoints: number | null,
  isBye = false,
  homeIsAverage = false,
  awayIsAverage = false,
): boolean {
  const scoreAvailable = (entryId: number | null, netPoints: number | null, isAverage: boolean) =>
    isAverage
      ? netPoints !== null && Number.isFinite(netPoints)
      : isBye || entryId === null
        ? true
        : netPoints !== null && Number.isFinite(netPoints);
  return (
    scoreAvailable(homeEntryId, homeNetPoints, homeIsAverage) &&
    scoreAvailable(awayEntryId, awayNetPoints, awayIsAverage)
  );
}

async function publishH2HMatch(
  season: FplSeasonRef,
  eventId: number,
  global: NonNullable<Awaited<ReturnType<typeof readLivePublicationV2>>>,
  row: H2HMatchRow,
  inputs: ReadonlyMap<number, EntryLivePublicationRead>,
  activePointer: LeagueLivePointerReadV2 | undefined,
  previousPointer: LeagueLivePointerReadV2 | undefined,
  redis: Awaited<ReturnType<typeof redisSingleton.getClient>>,
  expectedNextCheckAtValue?: Date | string | null,
): Promise<H2HPreparedMatch> {
  const active = activePointer?.read;
  const previous = previousPointer?.read;
  const fallbackSource = global.publication.sourceCheckedAt;
  const homeRead = row.homeEntryId === null ? undefined : inputs.get(row.homeEntryId);
  const awayRead = row.awayEntryId === null ? undefined : inputs.get(row.awayEntryId);
  const home = h2hSide(
    row.homeEntryId,
    row.homeEntryName,
    row.homePlayerName,
    row.homeIsAverage,
    row.isBye,
    row.homeNetPoints,
    homeRead,
  );
  const away = h2hSide(
    row.awayEntryId,
    row.awayEntryName,
    row.awayPlayerName,
    row.awayIsAverage,
    row.isBye,
    row.awayNetPoints,
    awayRead,
  );
  const sideReady = (side: H2HMatchSide): boolean =>
    side.entryId === null
      ? side.isAverage
        ? side.officialNetPoints !== null
        : true
      : side.input !== null;
  const inputReady = sideReady(home) && sideReady(away);
  const finalReadyInput =
    inputReady &&
    (global.publication.state !== 'FINALIZED' ||
      (isTimestampAtOrAfter(row.sourceCheckedAt, row.finalizationAt) &&
        finalInputAvailable(
          row.homeEntryId,
          row.homeIsAverage,
          homeRead,
          row.homeProfileSourceCheckedAt,
          row.finalizationAt,
        ) &&
        finalInputAvailable(
          row.awayEntryId,
          row.awayIsAverage,
          awayRead,
          row.awayProfileSourceCheckedAt,
          row.finalizationAt,
        ) &&
        hasCompleteH2HOfficialScores(
          row.homeEntryId,
          row.homeNetPoints,
          row.awayEntryId,
          row.awayNetPoints,
          row.isBye,
          row.isBye && row.homeEntryId === null ? false : row.homeIsAverage,
          row.isBye && row.awayEntryId === null ? false : row.awayIsAverage,
        )));
  const candidate: H2HMatchPayload = {
    contractVersion: 'live-points-v2',
    season: season.seasonCode,
    eventId,
    tournamentId: row.tournamentId,
    officialMatchId: row.officialMatchId,
    groupId: row.phase === 'KNOCKOUT' ? row.groupId : row.groupId > 0 ? row.groupId : 1,
    sourceOrder: row.sourceOrder,
    phase: row.phase,
    knockoutName: row.knockoutName,
    tiebreak: row.tiebreak,
    isBye: row.isBye,
    state: finalReadyInput ? 'READY' : 'PENDING',
    sourceCheckedAt: isoOrFallback(row.sourceCheckedAt, fallbackSource),
    globalRef: {
      publicationId: global.publication.publicationId,
      generation: global.publication.generation,
    },
    home,
    away,
  };
  const scope = h2hMatchScope(season.seasonCode, eventId, row);
  const canPublish =
    global.publication.state !== 'FINALIZED'
      ? inputReady || (!active && !previous)
      : finalReadyInput;
  const activePayload = readH2HMatchPayload(active, row.officialMatchId);
  const previousPayload = readH2HMatchPayload(previous, row.officialMatchId);
  let selected = canPublish
    ? candidate
    : selectRetainedH2HMatchPayload(activePayload, previousPayload, candidate);

  if (canPublish) {
    const preparedCandidate: H2HPreparedMatch = {
      index: h2hMatchIndexFromPayload(candidate),
      payload: candidate,
      finalReady: finalReadyInput,
    };
    const revisions = h2hRevisions(global, [preparedCandidate], []);
    try {
      const result = await publishLiveLeaguePublicationV2({
        scope,
        state: global.publication.state,
        sourceCheckedAt: global.publication.sourceCheckedAt,
        contentUpdatedAt: candidate.sourceCheckedAt,
        expectedNextCheckAt: expectedNextCheckAt(
          global.publication.sourceCheckedAt,
          expectedNextCheckAtValue,
        ),
        globalRef: candidate.globalRef,
        revisions,
        counts: {
          expected: 1,
          published: 1,
          ready: candidate.state === 'READY' ? 1 : 0,
          noPicks: 0,
        },
        index: [h2hMatchIndexFromPayload(candidate)],
        payload: { [String(row.officialMatchId)]: candidate },
        currentRead: active ?? null,
        previousRead: previous ?? null,
        currentPointerRaw: activePointer?.raw,
        previousPointerRaw: previousPointer?.raw,
        generationFloor: Math.max(
          active?.publication.generation ?? 0,
          previous?.publication.generation ?? 0,
        ),
        redis,
      });
      selected = result.published
        ? candidate
        : selectRetainedH2HMatchPayload(activePayload, previousPayload, {
            ...candidate,
            state: 'ERROR',
          });
    } catch (error) {
      logError('Live H2H match publication failed; retaining exact match LKG', error, {
        season: season.seasonCode,
        eventId,
        tournamentId: row.tournamentId,
        officialMatchId: row.officialMatchId,
      });
      selected = selectRetainedH2HMatchPayload(activePayload, previousPayload, {
        ...candidate,
        state: 'ERROR',
      });
    }
  }

  const selectedFinalReady =
    finalReadyInput &&
    selected.state === 'READY' &&
    selected.globalRef.publicationId === global.publication.publicationId &&
    selected.globalRef.generation === global.publication.generation;
  return {
    // A retained payload is an immutable match snapshot. Build its index from
    // that same payload rather than the latest relational row: an official
    // roster/order mutation can otherwise make the head index disagree with
    // the retained payload and invalidate the whole H2H head.
    index: h2hMatchIndexFromPayload(selected),
    payload: selected,
    finalReady: selectedFinalReady,
  };
}

function standingsPayload(
  season: FplSeasonRef,
  eventId: number,
  tournamentId: number,
  throughEventId: number,
  sourceCheckedAt: string,
  rows: readonly H2HStandingRow[],
  state: H2HStandingsPayload['state'] = rows.length > 0 ? 'READY' : 'UNAVAILABLE',
): H2HStandingsPayload {
  return {
    contractVersion: 'live-points-v2',
    season: season.seasonCode,
    eventId,
    tournamentId,
    throughEventId,
    state,
    sourceCheckedAt,
    rows: rows.map((row) => ({
      entryId: row.entryId,
      entryName: row.entryName?.trim() || `Entry ${row.entryId}`,
      playerName: row.playerName,
      rank: row.rank,
      matchPoints: row.matchPoints,
      played: row.played,
      won: row.won,
      drawn: row.drawn,
      lost: row.lost,
      pointsFor: row.pointsFor,
    })),
  };
}

export type LiveH2HLeaguePublicationSyncResult = {
  readonly globalPublicationId: string;
  readonly globalGeneration: number;
  readonly tournaments: number;
  readonly matches: number;
  readonly published: number;
  readonly retained: number;
  readonly pending: number;
  readonly skipped: number;
  readonly finalReady: boolean;
};

/**
 * Publishes H2H match snapshots independently, then publishes one
 * self-contained head and one official-standings overlay.  A missing input
 * can retain one match without preventing unrelated matches from becoming
 * visible.
 */
export async function syncLiveH2HLeaguePublicationsV2(
  season: FplSeasonRef,
  eventId: number,
  expectedNextCheckAtValue?: Date | string | null,
): Promise<LiveH2HLeaguePublicationSyncResult | null> {
  const redis = await redisSingleton.getClient();
  const global = await readLivePublicationV2({ season: season.seasonCode, eventId }, redis);
  if (!global) return null;
  const tournaments = await findOfficialH2HTournaments(season);
  await retireInactiveH2HPublications(
    season,
    eventId,
    new Set(tournaments.map(({ tournamentId }) => tournamentId)),
    redis,
  );
  const totals = { matches: 0, published: 0, retained: 0, pending: 0, skipped: 0 };
  let finalReady = true;
  for (const tournament of tournaments) {
    const tournamentId = tournament.tournamentId;
    const phaseActive = isH2HTournamentPhaseActive(tournament, eventId);
    const headScope = {
      season: season.seasonCode,
      eventId,
      tournamentId,
      scope: 'H2H_HEAD' as const,
    };
    try {
      const sourceMatches = await findOfficialH2HMatches(season, tournamentId, eventId);
      if (sourceMatches.length === 0 || sourceMatches.length > LIVE_LEAGUE_MAX_ENTRIES) {
        totals.skipped += 1;
        if (global.publication.state === 'FINALIZED' && phaseActive) {
          finalReady = false;
        }
        continue;
      }
      const sourceMatchIds = sourceMatches.map((row) => row.officialMatchId);
      if (new Set(sourceMatchIds).size !== sourceMatchIds.length) {
        totals.skipped += 1;
        if (global.publication.state === 'FINALIZED' && phaseActive) {
          finalReady = false;
        }
        continue;
      }
      const entryIds = [
        ...new Set(
          sourceMatches
            .flatMap((row) => [row.homeEntryId, row.awayEntryId])
            .filter((id): id is number => id !== null),
        ),
      ];
      let inputs = await readEntryLiveInputsV2(
        entryIds.map((entryId) => ({ season: season.seasonCode, eventId, entryId })),
        redis,
      );
      const entryIdsNeedingFinalRecovery = entryIds.filter((entryId) => {
        const read = inputs.get(entryId);
        return !read || read.input.finalResult === null;
      });
      if (global.publication.state === 'FINALIZED' && entryIdsNeedingFinalRecovery.length > 0) {
        const finalizationAt = sourceMatches.find(
          (row) => row.finalizationAt !== null,
        )?.finalizationAt;
        if (finalizationAt !== undefined && finalizationAt !== null) {
          await rebuildFinalEntryLiveInputsV2(
            season,
            eventId,
            entryIdsNeedingFinalRecovery,
            finalizationAt,
            redis,
          );
          inputs = await readEntryLiveInputsV2(
            entryIds.map((entryId) => ({ season: season.seasonCode, eventId, entryId })),
            redis,
          );
        }
      }
      if (global.publication.state === 'FINALIZED') {
        const finalizationAt =
          sourceMatches.find((row) => row.finalizationAt !== null)?.finalizationAt ?? null;
        const entriesNeedingProfileRefresh = sourceMatches.flatMap((row) => {
          const staleHome =
            row.homeEntryId !== null &&
            !isTimestampAtOrAfter(row.homeProfileSourceCheckedAt, finalizationAt);
          const staleAway =
            row.awayEntryId !== null &&
            !isTimestampAtOrAfter(row.awayProfileSourceCheckedAt, finalizationAt);
          return [
            ...(staleHome && row.homeEntryId !== null ? [row.homeEntryId] : []),
            ...(staleAway && row.awayEntryId !== null ? [row.awayEntryId] : []),
          ];
        });
        if (finalizationAt !== null) {
          await enqueueFinalizationProfileRefresh(
            season,
            eventId,
            tournamentId,
            entriesNeedingProfileRefresh,
          );
        }
      }
      const [existingHead, previousHead] = await Promise.all([
        readLiveLeaguePublicationV2Pointer(headScope, 'active', redis),
        readLiveLeaguePublicationV2Pointer(headScope, 'previous', redis),
      ]);
      const retainedHead = existingHead ?? previousHead;
      const expectedMatchIds = (retainedHead?.index ?? [])
        .filter((row): row is H2HMatchIndexRow => 'matchId' in row)
        .map((row) => row.matchId);
      const matchSetComplete = hasExpectedH2HMatchSet(expectedMatchIds, sourceMatchIds);
      const matchScopes = sourceMatches.map((row) =>
        h2hMatchScope(season.seasonCode, eventId, row),
      );
      const [activeMatches, previousMatches] = await Promise.all([
        readLiveLeaguePublicationV2PointersV2(matchScopes, 'active', redis),
        readLiveLeaguePublicationV2PointersV2(matchScopes, 'previous', redis),
      ]);
      const prepared = await mapWithConcurrency(sourceMatches, 8, async (row) => {
        const scope = h2hMatchScope(season.seasonCode, eventId, row);
        return publishH2HMatch(
          season,
          eventId,
          global,
          row,
          inputs,
          activeMatches.get(liveLeagueV2Key(scope, 'active')),
          previousMatches.get(liveLeagueV2Key(scope, 'previous')),
          redis,
          expectedNextCheckAtValue,
        );
      });
      totals.matches += prepared.length;
      for (const match of prepared) {
        if (match.payload.state === 'READY') totals.published += 1;
        else if (match.payload.state === 'PENDING') totals.pending += 1;
        else totals.retained += 1;
      }

      const standingsRead = await findOfficialH2HStandings(season, eventId, tournamentId);
      const standings = standingsRead.rows;
      const revisions = h2hRevisions(global, prepared, standings);
      const standingsScope = {
        season: season.seasonCode,
        eventId,
        tournamentId,
        scope: 'H2H_STANDINGS' as const,
      };
      const allMatchesFinalReady = matchSetComplete && prepared.every((match) => match.finalReady);
      let headFinalReady = global.publication.state !== 'FINALIZED';
      // A transient source response may omit an already published match. Keep
      // publishing independently valid match snapshots, but never replace the
      // composite head with a smaller match set. A later reconciliation pass
      // can publish the new head once the source set is complete again.
      if (matchSetComplete && (global.publication.state !== 'FINALIZED' || allMatchesFinalReady)) {
        const headPayload = Object.fromEntries(
          prepared.map(({ payload }) => [String(payload.officialMatchId), payload]),
        );
        const headResult = await publishLiveLeaguePublicationV2({
          scope: headScope,
          state: global.publication.state,
          sourceCheckedAt: global.publication.sourceCheckedAt,
          contentUpdatedAt: maxIso([
            global.publication.revisions.scoreCore.contentUpdatedAt,
            ...prepared.map(({ payload }) => payload.sourceCheckedAt),
          ]),
          expectedNextCheckAt: expectedNextCheckAt(
            global.publication.sourceCheckedAt,
            expectedNextCheckAtValue,
          ),
          globalRef: {
            publicationId: global.publication.publicationId,
            generation: global.publication.generation,
          },
          revisions,
          counts: {
            expected: prepared.length,
            published: prepared.length,
            ready: prepared.filter(({ payload }) => payload.state === 'READY').length,
            noPicks: 0,
          },
          index: prepared.map(({ index }) => index),
          payload: headPayload,
          generationFloorLoader: () => readLiveLeagueCheckpointGenerationV2(headScope),
          redis,
        });
        const headRead = {
          publication: headResult.publication,
          index: prepared.map(({ index }) => index) as LeagueLiveIndex[],
          payload: headPayload,
          servedFrom: 'REDIS_CURRENT' as const,
        };
        if (
          headResult.published ||
          headResult.publication.times.checkpointedAt === null ||
          liveLeagueCheckpointIsDue(headRead, global.publication.state === 'FINALIZED')
        ) {
          await scheduleLeagueCheckpoint(
            headResult.publication,
            headResult.previous,
            headScope,
            redis,
          );
        }
        if (global.publication.state === 'FINALIZED') {
          const activeHead = await readLiveLeaguePublicationV2Pointer(headScope, 'active', redis);
          headFinalReady =
            activeHead?.publication.state === 'FINALIZED' &&
            activeHead.publication.times.checkpointedAt !== null;
        }
      }

      const standingsIsFinalized = global.publication.state === 'FINALIZED';
      let standingsFinalReady = !standingsIsFinalized;
      const existingStandings =
        (await readLiveLeaguePublicationV2Pointer(standingsScope, 'active', redis)) ??
        (await readLiveLeaguePublicationV2Pointer(standingsScope, 'previous', redis));
      const standingsSourceCheckedAt = isoOrFallback(
        standingsRead.sourceCheckedAt,
        global.publication.sourceCheckedAt,
      );
      const finalizationAt = standingsRead.finalizationAt;
      const standingsCoverageComplete =
        standingsRead.expectedMatchCount > 0 &&
        standingsRead.expectedMatchCount === standingsRead.completeMatchCount &&
        standingsRead.completeMissingSourceCount === 0;
      const standingsFreshForFinal =
        standingsCoverageComplete &&
        standingsRead.throughEventId === eventId &&
        isTimestampAtOrAfter(standingsRead.oldestCompleteSourceCheckedAt, finalizationAt);
      const liveStandingsPayload =
        !standingsIsFinalized && standings.length > 0
          ? standingsPayload(
              season,
              eventId,
              tournamentId,
              standingsRead.throughEventId,
              standingsSourceCheckedAt,
              standings,
              'UPDATING',
            )
          : null;
      const shouldSyncLiveStandings =
        liveStandingsPayload !== null && existingStandings?.publication.state !== 'FINALIZED';
      if (shouldSyncLiveStandings && liveStandingsPayload !== null) {
        // Seed the official overlay as soon as a live scope is first observed.
        // It is an independent, updating source and is never derived from live
        // scores. Heartbeat-only checks retain the same generation; a real
        // standings change creates a new snapshot.
        const standingsPayloadValue = liveStandingsPayload;
        const standingsIndex: H2HStandingsIndexRow[] = standingsPayloadValue.rows.map((row) => ({
          entryId: row.entryId,
          availability: 'READY',
        }));
        const standingsResult = await publishLiveLeaguePublicationV2({
          scope: standingsScope,
          state: global.publication.state,
          sourceCheckedAt: standingsSourceCheckedAt,
          contentUpdatedAt: standingsSourceCheckedAt,
          expectedNextCheckAt: expectedNextCheckAt(
            global.publication.sourceCheckedAt,
            expectedNextCheckAtValue,
          ),
          globalRef: {
            publicationId: global.publication.publicationId,
            generation: global.publication.generation,
          },
          revisions,
          counts: {
            expected: standingsIndex.length,
            published: standingsIndex.length,
            ready: standingsIndex.length,
            noPicks: 0,
          },
          index: standingsIndex,
          payload: { standings: standingsPayloadValue },
          generationFloorLoader: () => readLiveLeagueCheckpointGenerationV2(standingsScope),
          redis,
        });
        const standingsReadForCheckpoint = {
          publication: standingsResult.publication,
          index: standingsIndex as LeagueLiveIndex[],
          payload: { standings: standingsPayloadValue },
          servedFrom: 'REDIS_CURRENT' as const,
        };
        if (
          standingsResult.published ||
          standingsResult.publication.times.checkpointedAt === null ||
          liveLeagueCheckpointIsDue(standingsReadForCheckpoint, false)
        ) {
          await scheduleLeagueCheckpoint(
            standingsResult.publication,
            standingsResult.previous,
            standingsScope,
            redis,
          );
        }
      } else if (standingsIsFinalized && standingsFreshForFinal && standings.length > 0) {
        const standingsPayloadValue = standingsPayload(
          season,
          eventId,
          tournamentId,
          standingsRead.throughEventId,
          standingsSourceCheckedAt,
          standings,
          'READY',
        );
        const standingsIndex: H2HStandingsIndexRow[] = standingsPayloadValue.rows.map((row) => ({
          entryId: row.entryId,
          availability: 'READY',
        }));
        const standingsResult = await publishLiveLeaguePublicationV2({
          scope: standingsScope,
          state: global.publication.state,
          sourceCheckedAt: standingsSourceCheckedAt,
          contentUpdatedAt: standingsSourceCheckedAt,
          expectedNextCheckAt: expectedNextCheckAt(
            global.publication.sourceCheckedAt,
            expectedNextCheckAtValue,
          ),
          globalRef: {
            publicationId: global.publication.publicationId,
            generation: global.publication.generation,
          },
          revisions,
          counts: {
            expected: standingsIndex.length,
            published: standingsIndex.length,
            ready: standingsIndex.length,
            noPicks: 0,
          },
          index: standingsIndex,
          payload: { standings: standingsPayloadValue },
          generationFloorLoader: () => readLiveLeagueCheckpointGenerationV2(standingsScope),
          redis,
        });
        const standingsReadForCheckpoint = {
          publication: standingsResult.publication,
          index: standingsIndex as LeagueLiveIndex[],
          payload: { standings: standingsPayloadValue },
          servedFrom: 'REDIS_CURRENT' as const,
        };
        if (
          standingsResult.published ||
          standingsResult.publication.times.checkpointedAt === null ||
          liveLeagueCheckpointIsDue(standingsReadForCheckpoint, true)
        ) {
          await scheduleLeagueCheckpoint(
            standingsResult.publication,
            standingsResult.previous,
            standingsScope,
            redis,
          );
        }
        const activeStandings = await readLiveLeaguePublicationV2Pointer(
          standingsScope,
          'active',
          redis,
        );
        standingsFinalReady =
          activeStandings?.publication.state === 'FINALIZED' &&
          activeStandings.publication.times.checkpointedAt !== null;
      }
      if (standingsIsFinalized && (!standingsFreshForFinal || standings.length === 0)) {
        standingsFinalReady = false;
      }
      if (global.publication.state === 'FINALIZED' && phaseActive) {
        finalReady = finalReady && allMatchesFinalReady && headFinalReady && standingsFinalReady;
      }
    } catch (error) {
      totals.skipped += 1;
      if (global.publication.state === 'FINALIZED' && phaseActive) finalReady = false;
      logError('Live H2H league publication failed; retaining match/head snapshots', error, {
        season: season.seasonCode,
        eventId,
        tournamentId,
      });
    }
  }
  logInfo('Live H2H league publications synchronized', {
    season: season.seasonCode,
    eventId,
    globalPublicationId: global.publication.publicationId,
    globalGeneration: global.publication.generation,
    tournaments: tournaments.length,
    ...totals,
    finalReady,
  });
  return {
    globalPublicationId: global.publication.publicationId,
    globalGeneration: global.publication.generation,
    tournaments: tournaments.length,
    ...totals,
    finalReady,
  };
}
