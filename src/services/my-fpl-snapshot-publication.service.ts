import { createHash, randomUUID } from 'node:crypto';
import type postgres from 'postgres';

import { redisSingleton } from '../cache/singleton';
import { countEntryEligibility, isEntryEligibleForEvent } from '../domain/entry-eligibility';
import type { EventLive } from '../domain/event-lives';
import type { FplSeasonRef } from '../domain/fpl-season';
import { myFplSnapshotEventLockScope, myFplSnapshotSeasonLockScope } from '../domain/my-fpl-locks';
import {
  buildMyFplManagerReview,
  type MyFplAutomaticSubstitutionInput,
  type MyFplManagerReviewGameweekInput,
  type MyFplManagerReviewPickInput,
} from '../domain/my-fpl-manager-review';
import type { Fixture } from '../types';
import { getDbClient } from '../db/singleton';
import { contentHash, postgresJsonbCanonicalJson } from '../utils/content-hash';
import { logInfo, logWarn } from '../utils/logger';
import {
  buildScoreInputRevision,
  eventLiveV2ScoreService,
  loadFreshEventLiveAuthoritySnapshot,
  LIVE_POINTS_V2_ALGORITHM_VERSION,
} from './event-live-v2-score.service';
import type {
  EventLiveManagerPickRow,
  RevisionedEventLiveScore,
} from './event-live-v2-score.service';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type MyFplSnapshotKind = 'PROVISIONAL' | 'FINAL';

export type MyFplSnapshotPublication = Readonly<{
  seasonId: number;
  eventId: number;
  revision: number;
  snapshotDate: string;
  sourceCheckedAt: Date;
  publishedAt: Date;
  kind: MyFplSnapshotKind;
  expectedEntryCount: number;
  readyEntryCount: number;
  emptyEntryCount: number;
  /** Entries added after this gameweek are represented in the payload as EMPTY,
   * but are explicitly excluded from the eligible denominator. */
  notApplicableEntryCount: number;
  expectedTournamentCount: number;
  readyTournamentCount: number;
  contentSha256: string;
  scoreSource: 'FPL_EVENT_LIVE' | 'FPL_FINAL_RESULT' | null;
  livePublicationId: string | null;
  liveRevision: string | null;
  algorithmVersion: string | null;
  sourceMinCheckedAt: Date | null;
  sourceMaxCheckedAt: Date | null;
  overrideActor?: string | null;
  overrideReason?: string | null;
  idempotencyKey?: string | null;
}>;

export type MyFplSnapshotCaptureResult = Readonly<{
  status: 'published' | 'noop';
  publication: MyFplSnapshotPublication;
}>;

export type MyFplSnapshotCaptureOptions = {
  snapshotDate?: string;
  now?: Date;
  actor?: string;
  reason?: string;
  idempotencyKey?: string;
};

export type MyFplSnapshotRedisManifest = Readonly<{
  dataset: 'fpl:my-fpl';
  seasonCode: string;
  eventId: number;
  revision: number;
  snapshotDate: string;
  sourceCheckedAt: string;
  publishedAt: string;
  kind: MyFplSnapshotKind;
  contentSha256: string;
  scoreSource: 'FPL_EVENT_LIVE' | 'FPL_FINAL_RESULT' | null;
  livePublicationId: string | null;
  liveRevision: string | null;
  algorithmVersion: string | null;
  sourceMinCheckedAt: string | null;
  sourceMaxCheckedAt: string | null;
}>;

export type MyFplSnapshotOutboxDispatchResult = Readonly<{
  claimed: number;
  delivered: number;
  superseded: number;
  failed: number;
  /** Revisions whose Redis manifests were actually activated in this call. */
  deliveredRevisions?: readonly number[];
  /** Publication evidence for manifests activated in this call. */
  deliveredEvidence?: readonly MyFplSnapshotOutboxDeliveryEvidence[];
  /** Active outbox rows still pending after this dispatch attempt. */
  remaining?: number;
}>;

export type MyFplSnapshotOutboxDeliveryEvidence = Readonly<{
  seasonId: number;
  eventId: number;
  revision: number;
  kind: MyFplSnapshotKind;
  sourceCheckedAt: string;
  publishedAt: string;
}>;

export type MyFplSnapshotCoverageState =
  | 'COMPLETE'
  | 'CORRECTION_PENDING'
  | 'NO_PUBLICATION'
  | 'IMMUTABLE_FINAL';

export type MyFplSnapshotOperationalStatus = Readonly<{
  eventId: number;
  deadlineTime: string | null;
  finished: boolean;
  dataChecked: boolean;
  dataCheckedAt: string | null;
  activeRevision: number | null;
  activeSnapshotDate: string | null;
  activeKind: MyFplSnapshotKind | null;
  activePublishedAt: string | null;
  activeAgeSeconds: number | null;
  expectedEntryCount: number | null;
  readyEntryCount: number | null;
  emptyEntryCount: number | null;
  notApplicableEntryCount: number | null;
  expectedTournamentCount: number | null;
  readyTournamentCount: number | null;
  currentEntryCount: number;
  pendingCorrectionEntryCount: number;
  coverageState: MyFplSnapshotCoverageState;
  pendingOutboxCount: number;
  outboxAttempts: number;
  /** Pending Redis invalidations left by committed tournament deletions. */
  pendingInvalidationCount: number;
  invalidationAttempts: number;
  finalSla: 'NOT_DUE' | 'DUE' | 'MET' | 'BREACHED';
}>;

export class MyFplSnapshotIncompleteError extends Error {
  readonly code = 'MY_FPL_SNAPSHOT_INCOMPLETE';

  constructor(message: string) {
    super(message);
    this.name = 'MyFplSnapshotIncompleteError';
  }
}

export function resolveMyFplSnapshotCoverageState(
  kind: MyFplSnapshotKind | null,
  pendingCorrectionEntryCount: number,
): MyFplSnapshotCoverageState {
  if (kind === null) return 'NO_PUBLICATION';
  if (kind === 'FINAL') return 'IMMUTABLE_FINAL';
  return pendingCorrectionEntryCount > 0 ? 'CORRECTION_PENDING' : 'COMPLETE';
}

export function isMatchingProvisionalMyFplPublication(
  active: MyFplSnapshotPublication | null,
  candidate: Readonly<{
    kind: MyFplSnapshotKind;
    snapshotDate: string;
    contentSha256: string;
    scoreSource: MyFplSnapshotPublication['scoreSource'];
    livePublicationId: string | null;
    liveRevision: string | null;
    algorithmVersion: string | null;
    sourceMinCheckedAt: string;
    sourceMaxCheckedAt: string;
  }>,
): active is MyFplSnapshotPublication {
  return (
    candidate.kind === 'PROVISIONAL' &&
    isCompleteMyFplPublication(active) &&
    active.kind === candidate.kind &&
    active.snapshotDate === candidate.snapshotDate &&
    active.contentSha256 === candidate.contentSha256 &&
    active.scoreSource === candidate.scoreSource &&
    active.livePublicationId === candidate.livePublicationId &&
    active.liveRevision === candidate.liveRevision &&
    active.algorithmVersion === candidate.algorithmVersion &&
    active.sourceMinCheckedAt?.toISOString() === candidate.sourceMinCheckedAt &&
    active.sourceMaxCheckedAt?.toISOString() === candidate.sourceMaxCheckedAt
  );
}

/**
 * FPL reports an unranked manager's first-event cumulative total as zero even
 * when the event itself has points. This is an authoritative source semantic,
 * not a reason to relax reconciliation for later events or ranked entries.
 */
export function isAuthoritativeUnrankedFirstEventResult(
  input: Readonly<{
    firstScoringEvent: number;
    eventId: number;
    hasPreviousResult: boolean;
    overallPoints: number;
    overallRank: number | null;
  }>,
): boolean {
  return (
    input.firstScoringEvent === input.eventId &&
    !input.hasPreviousResult &&
    input.overallPoints === 0 &&
    input.overallRank === 0
  );
}

class MyFplCaptureLockBusyError extends Error {}

const MY_FPL_CAPTURE_LOCK_WAIT_TIMEOUT_MS = 2 * 60_000;
const MAX_MY_FPL_CAPTURE_COMMIT_CONFLICT_RETRIES = 3;
const myFplCaptureTails = new Map<string, Promise<void>>();

export function serializeMyFplSnapshotCapture(
  key: string,
  operation: () => Promise<MyFplSnapshotCaptureResult>,
): Promise<MyFplSnapshotCaptureResult> {
  const prior = myFplCaptureTails.get(key);
  const result = prior ? prior.then(operation) : Promise.resolve().then(operation);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  myFplCaptureTails.set(key, settled);
  void settled.then(() => {
    if (myFplCaptureTails.get(key) === settled) {
      myFplCaptureTails.delete(key);
    }
  });
  return result;
}

async function runMyFplCaptureTransaction(
  client: postgres.Sql,
  lockScopes: readonly string[],
  operation: (transaction: postgres.TransactionSql) => Promise<MyFplSnapshotCaptureResult>,
): Promise<MyFplSnapshotCaptureResult> {
  // A production transaction pool does not preserve session affinity between
  // statements, so a session-level advisory lock cannot protect the following
  // transaction. Try a transaction lock without waiting instead: every miss
  // rolls back immediately and opens a fresh repeatable-read snapshot. A
  // serialization or a publication-identity conflict can still occur at the
  // commit boundary; those receive a bounded number of fresh-snapshot retries.
  // Keep time spent building the snapshot outside the lock-wait budget.
  let lockWaitRemainingMs = MY_FPL_CAPTURE_LOCK_WAIT_TIMEOUT_MS;
  let commitBoundaryConflictRetries = 0;
  let idempotencyConflictRetries = 0;
  while (true) {
    const lockAttemptStartedAt = Date.now();
    try {
      return await client.begin('isolation level repeatable read', async (tx) => {
        for (const lockScope of lockScopes) {
          const lockRows = await tx<{ acquired: boolean }[]>`
            SELECT pg_try_advisory_xact_lock(hashtextextended(${lockScope}, 0)) AS acquired
          `;
          if (!lockRows[0]?.acquired) {
            throw new MyFplCaptureLockBusyError();
          }
        }
        return operation(tx);
      });
    } catch (error) {
      const contention = classifyMyFplCaptureContention(error);
      if (contention === 'lock-busy') {
        lockWaitRemainingMs -= Date.now() - lockAttemptStartedAt;
        if (lockWaitRemainingMs <= 0) {
          throw new Error(`Timed out waiting for My FPL capture locks ${lockScopes.join(',')}`, {
            cause: error,
          });
        }
        const waitStartedAt = Date.now();
        await new Promise((resolve) => setTimeout(resolve, Math.min(1_000, lockWaitRemainingMs)));
        lockWaitRemainingMs -= Date.now() - waitStartedAt;
        if (lockWaitRemainingMs <= 0) {
          throw new Error(`Timed out waiting for My FPL capture locks ${lockScopes.join(',')}`, {
            cause: error,
          });
        }
        continue;
      }
      if (contention === null) throw error;
      if (contention === 'idempotency') {
        if (idempotencyConflictRetries >= 1) {
          throw new Error(
            `My FPL capture idempotency conflict did not converge for ${lockScopes.join(',')}`,
            {
              cause: error,
            },
          );
        }
        idempotencyConflictRetries += 1;
        continue;
      }
      if (commitBoundaryConflictRetries >= MAX_MY_FPL_CAPTURE_COMMIT_CONFLICT_RETRIES) {
        throw new Error(
          `My FPL capture commit-boundary contention did not converge for ${lockScopes.join(',')}`,
          { cause: error },
        );
      }
      commitBoundaryConflictRetries += 1;
    }
  }
}

const ACTIVE_MY_FPL_PUBLICATION_CONSTRAINT = 'my_fpl_snapshot_publications_active_key';
const IDEMPOTENT_MY_FPL_PUBLICATION_CONSTRAINT = 'my_fpl_snapshot_publications_idempotency_key';

type MyFplCaptureContention = 'lock-busy' | 'serialization' | 'active-publication' | 'idempotency';

function classifyMyFplCaptureContention(error: unknown): MyFplCaptureContention | null {
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 4 && current !== null && typeof current === 'object'; depth += 1) {
    if (current instanceof MyFplCaptureLockBusyError) return 'lock-busy';
    if (seen.has(current)) break;
    seen.add(current);
    const record = current as {
      code?: unknown;
      constraint?: unknown;
      constraint_name?: unknown;
      cause?: unknown;
    };
    if (record.code === '40001') return 'serialization';
    if (record.code === '23505') {
      const constraint = String(record.constraint_name ?? record.constraint ?? '');
      if (constraint === ACTIVE_MY_FPL_PUBLICATION_CONSTRAINT) return 'active-publication';
      if (constraint === IDEMPOTENT_MY_FPL_PUBLICATION_CONSTRAINT) return 'idempotency';
    }
    current = record.cause;
  }
  return null;
}

export function isRetryableMyFplCaptureContention(error: unknown): boolean {
  return classifyMyFplCaptureContention(error) !== null;
}

type EntryIdentity = {
  id: number;
  entryName: string;
  playerName: string;
  region: string | null;
  startedEvent: number | null;
  overallPoints: number | null;
  overallRank: number | null;
  bank: number | null;
  teamValue: number | null;
  totalTransfers: number | null;
  transfersSyncedThroughEventId: number | null;
  pastSeasonsCheckedAt: string | null;
  pastSeasonsCount: number | null;
};

type HistoryRow = {
  eventId: number;
  eventPoints: number;
  eventRank: number | null;
  overallPoints: number;
  overallRank: number | null;
  eventTransfers: number;
  eventTransfersCost: number;
  eventNetPoints: number;
  eventBenchPoints: number;
  eventAutoSubPoints: number | null;
  eventChip: string;
  eventCaptainPoints: number;
  captainWebName: string | null;
  captainTeamShortName: string | null;
  teamValue: number | null;
  bank: number | null;
};

type PickRow = {
  entry_id: number;
  event_id: number;
  element: number;
  position: number;
  web_name: string;
  team_short_name: string | null;
  team_name: string | null;
  element_type: number;
  /** Team observed for this event pick, never the mutable current player team. */
  team_id: number | null;
  is_captain: boolean;
  is_vice_captain: boolean;
  active_chip: string | null;
  transfers: number | null;
  transfers_cost: number | null;
  source_updated_at: Date | string;
  multiplier: number;
  total_points: number | null;
  minutes: number | null;
  goals_scored: number | null;
  assists: number | null;
  clean_sheets: number | null;
  goals_conceded: number | null;
  yellow_cards: number | null;
  red_cards: number | null;
  saves: number | null;
  penalties_saved: number | null;
  bonus: number | null;
  bps: number | null;
  expected_goals: string | number | null;
  expected_assists: string | number | null;
  expected_goal_involvements: string | number | null;
  expected_goals_conceded: string | number | null;
  against_short_name: string | null;
  was_home: string | null;
  score: string | null;
  fixture_count: number | string | null;
};

type TransferRow = {
  entry_id: number;
  event_id: number;
  event_transfers: number;
  event_transfers_cost: number;
  event_chip: string | null;
  element_in_id: number | null;
  element_in_web_name: string | null;
  element_in_type: number | null;
  element_in_team_short_name: string | null;
  element_in_cost: number | null;
  element_in_points: number | null;
  element_in_played: boolean | null;
  element_out_id: number | null;
  element_out_web_name: string | null;
  element_out_type: number | null;
  element_out_team_short_name: string | null;
  element_out_cost: number | null;
  element_out_points: number | null;
  same_gameweek_gain: number | null;
  three_gameweek_gain: number | null;
  five_gameweek_gain: number | null;
  evaluated_through_event_id: number | null;
  transfer_time: Date | string;
};

type TournamentRow = {
  tournament_id: number;
  entry_id: number;
  group_id: number | null;
  current_group_rank: number | null;
  entry_name: string | null;
  player_name: string | null;
  event_points: number | null;
  event_cost: number | null;
  event_net_points: number | null;
  event_rank: number | null;
  overall_points: number | null;
  overall_rank: number | null;
  event_chip: string | null;
  captain_id: number | null;
  captain_web_name: string | null;
  captain_team_short_name: string | null;
  captain_points: number | null;
  team_value: number | null;
  bank: number | null;
  previous_event_net_points: number | null;
  previous_group_rank: number | null;
  input_revision: string | null;
  score_revision: string | null;
};

type EventResult = {
  source_result_id: number | null;
  updated_at: Date | string;
  event_id: number;
  entry_id: number;
  event_points: number;
  event_rank: number | null;
  overall_points: number;
  overall_rank: number | null;
  event_transfers: number;
  event_transfers_cost: number;
  event_net_points: number;
  event_bench_points: number | null;
  event_auto_sub_points: number | null;
  event_chip: string | null;
  played_captain_element_id: number | null;
  captain_points: number | null;
  event_picks: unknown;
  automatic_substitutions: unknown;
  team_value: number | null;
  bank: number | null;
  rich_synced_at: Date | string | null;
  input_revision: string | null;
  score_revision: string | null;
};

type EntrySource = {
  entry_id: number;
  entry_name: string;
  player_name: string;
  region: string | null;
  started_event: number | null;
  overall_points: number | null;
  overall_rank: number | null;
  bank: number | null;
  team_value: number | null;
  total_transfers: number | null;
  transfers_synced_through_event_id: number | null;
  past_seasons_checked_at: Date | string | null;
  past_seasons_count: number | null;
};

type JsonRecord = Record<string, unknown>;

/**
 * Provisional auto-substitution points are the incoming player's base points.
 * The projected lineup may temporarily give a vice-captain a 2x/3x effective
 * multiplier, but that captain multiplier must not leak into this diagnostic
 * metric (the finalized result path uses the same base-point definition).
 */
export function projectedEventAutoSubPoints(
  picks: readonly { element: number; total_points: number | null }[],
  effectiveLineup: ReadonlyMap<number, { autoSub: boolean }>,
): number {
  return picks.reduce((sum, pick) => {
    return sum + (effectiveLineup.get(pick.element)?.autoSub ? (pick.total_points ?? 0) : 0);
  }, 0);
}

const numberValue = (value: unknown, fallback = 0): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
};

const nullableNumber = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  return numberValue(value);
};

const integerValue = (value: unknown, fallback = 0): number =>
  Math.trunc(numberValue(value, fallback));

const iso = (value: Date | string | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

const chip = (value: string | null | undefined): string => {
  const compact = String(value ?? 'NONE')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  if (['BENCHBOOST', 'BBOOST', 'BB'].includes(compact)) return 'BENCH_BOOST';
  if (['TRIPLECAPTAIN', '3XC', 'TC'].includes(compact)) return 'TRIPLE_CAPTAIN';
  if (['FREEHIT', 'FH'].includes(compact)) return 'FREE_HIT';
  if (['WILDCARD', 'WC'].includes(compact)) return 'WILDCARD';
  if (['MANAGER', 'AM'].includes(compact)) return 'MANAGER';
  return 'NONE';
};

const positionName = (value: number): string => {
  if (value === 1) return 'GKP';
  if (value === 2) return 'DEF';
  if (value === 3) return 'MID';
  if (value === 4) return 'FWD';
  return '';
};

const utc8DateKey = (now: Date): string =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);

export const myFplSnapshotRedisManifestKey = (seasonCode: string, eventId: number): string => {
  if (!/^\d{4}$/.test(seasonCode) || !Number.isSafeInteger(eventId) || eventId <= 0) {
    throw new Error('Invalid My FPL Redis manifest scope');
  }
  return `llm:data:fpl:my-fpl:${seasonCode}:${eventId}:active`;
};

const MY_FPL_SNAPSHOT_REDIS_ACTIVATE_SCRIPT = `
local current_raw = redis.call('GET', KEYS[1])
local candidate_raw = ARGV[1]
local candidate = cjson.decode(candidate_raw)
if current_raw then
  local decoded, current = pcall(cjson.decode, current_raw)
  if not decoded or type(current) ~= 'table' or tonumber(current.revision) == nil then
    return {'invalid_active_manifest'}
  end
  if tonumber(current.revision) > tonumber(candidate.revision) then
    return {'stale'}
  end
  if tonumber(current.revision) == tonumber(candidate.revision)
    and current.contentSha256 ~= candidate.contentSha256 then
    return {'revision_conflict'}
  end
end
redis.call('SET', KEYS[1], candidate_raw)
return {'published'}
`;

const MY_FPL_SNAPSHOT_REDIS_INVALIDATE_SCRIPT = `
local current_raw = redis.call('GET', KEYS[1])
if not current_raw then
  return {'absent'}
end
local decoded, current = pcall(cjson.decode, current_raw)
if not decoded or type(current) ~= 'table' then
  redis.call('DEL', KEYS[1])
  return {'invalid_deleted'}
end
if ARGV[1] ~= '' and tonumber(current.revision) ~= tonumber(ARGV[1]) then
  return {'newer'}
end
redis.call('DEL', KEYS[1])
return {'deleted'}
`;

/**
 * Remove a Redis pointer only when it still names the deleted publication.
 * A concurrent rebuild can therefore publish a newer revision after the DB
 * deletion without having its fresh pointer removed by the cleanup path.
 */
export async function invalidateMyFplSnapshotRedisManifest(
  seasonCode: string,
  eventId: number,
  revision?: number | string,
): Promise<'absent' | 'deleted' | 'invalid_deleted' | 'newer'> {
  const redis = await redisSingleton.getClient();
  const result = (await redis.eval(
    MY_FPL_SNAPSHOT_REDIS_INVALIDATE_SCRIPT,
    1,
    myFplSnapshotRedisManifestKey(seasonCode, eventId),
    revision === undefined ? '' : String(revision),
  )) as [string];
  const status = result[0];
  if (
    status !== 'absent' &&
    status !== 'deleted' &&
    status !== 'invalid_deleted' &&
    status !== 'newer'
  ) {
    throw new Error(`My FPL Redis manifest invalidation failed: ${status}`);
  }
  logInfo('Invalidated My FPL snapshot Redis manifest', { seasonCode, eventId, revision, status });
  return status;
}

const automaticSubElements = (value: unknown): Set<number> => {
  if (!Array.isArray(value)) return new Set();
  return new Set(
    value.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const candidate = item as JsonRecord;
      const element = integerValue(candidate.element_in ?? candidate.elementIn, 0);
      return element > 0 ? [element] : [];
    }),
  );
};

const automaticSubstitutionInputs = (
  value: unknown,
): readonly MyFplAutomaticSubstitutionInput[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const candidate = item as JsonRecord;
    const elementIn = integerValue(candidate.element_in ?? candidate.elementIn, 0);
    const elementOut = integerValue(candidate.element_out ?? candidate.elementOut, 0);
    return elementIn > 0 && elementOut > 0 ? [{ elementIn, elementOut }] : [];
  });
};

const mapIdentity = (row: EntrySource): EntryIdentity => ({
  id: row.entry_id,
  entryName: row.entry_name,
  playerName: row.player_name,
  region: row.region,
  startedEvent: row.started_event,
  overallPoints: row.overall_points,
  overallRank: row.overall_rank,
  bank: row.bank,
  teamValue: row.team_value,
  totalTransfers: row.total_transfers,
  transfersSyncedThroughEventId: row.transfers_synced_through_event_id,
  pastSeasonsCheckedAt: iso(row.past_seasons_checked_at),
  pastSeasonsCount: row.past_seasons_count,
});

const mapPick = (
  row: PickRow,
  autoSub: ReadonlySet<number>,
  effectiveLineup?: ReadonlyMap<
    number,
    { effectiveMultiplier: number; pickActive: boolean; autoSub: boolean }
  >,
): JsonRecord => {
  const minutes = integerValue(row.minutes);
  const yellowCards = integerValue(row.yellow_cards);
  const redCards = integerValue(row.red_cards);
  const fixtureCount = integerValue(row.fixture_count);
  return {
    element: row.element,
    position: row.position,
    webName: row.web_name,
    teamShortName: row.team_short_name ?? '',
    teamName: row.team_name ?? '',
    elementTypeName: positionName(row.element_type),
    isCaptain: row.is_captain,
    isViceCaptain: row.is_vice_captain,
    multiplier: effectiveLineup?.get(row.element)?.effectiveMultiplier ?? row.multiplier,
    totalPoints: integerValue(row.total_points),
    minutes,
    goalsScored: integerValue(row.goals_scored),
    assists: integerValue(row.assists),
    cleanSheets: integerValue(row.clean_sheets),
    goalsConceded: integerValue(row.goals_conceded),
    yellowCards,
    redCards,
    saves: integerValue(row.saves),
    penaltiesSaved: integerValue(row.penalties_saved),
    bonus: integerValue(row.bonus),
    bps: integerValue(row.bps),
    againstShortName: row.against_short_name ?? '',
    wasHome: row.was_home ?? '',
    score: row.score ?? '',
    fixtureCount,
    bgw: fixtureCount === 0,
    dgw: fixtureCount > 1,
    isPlayed: minutes > 0 || yellowCards > 0 || redCards > 0,
    autoSub: effectiveLineup?.get(row.element)?.autoSub ?? autoSub.has(row.element),
    expectedGoals: nullableNumber(row.expected_goals),
    expectedAssists: nullableNumber(row.expected_assists),
    expectedGoalInvolvements: nullableNumber(row.expected_goal_involvements),
    expectedGoalsConceded: nullableNumber(row.expected_goals_conceded),
  };
};

/**
 * Keep captain blank classification identical to the established league
 * result semantics. Appearance-only points (including two points) are blank;
 * goals, assists, bonus, penalty saves, >3 saves, and GK/DEF clean sheets are
 * qualifying returns.
 */
const isBlankManagerCaptain = (picks: readonly JsonRecord[]): boolean => {
  const captain = picks.find((pick) => pick.isCaptain === true);
  if (!captain) return true;
  const goalsScored = integerValue(captain.goalsScored);
  const assists = integerValue(captain.assists);
  const bonus = integerValue(captain.bonus);
  const penaltiesSaved = integerValue(captain.penaltiesSaved);
  const saves = integerValue(captain.saves);
  const cleanSheets = integerValue(captain.cleanSheets);
  if (goalsScored > 0 || assists > 0 || bonus > 0 || penaltiesSaved > 0 || saves >= 3) {
    return false;
  }
  const elementTypeName = String(captain.elementTypeName ?? '');
  if ((elementTypeName === 'GKP' || elementTypeName === 'DEF') && cleanSheets > 0) {
    return false;
  }
  return true;
};

type CanonicalEventPick = Readonly<{
  element: number;
  position: number;
  multiplier: number;
  is_captain: boolean;
  is_vice_captain: boolean;
}>;

const parseCanonicalEventPicks = (value: unknown): CanonicalEventPick[] | null => {
  if (!Array.isArray(value) || value.length !== 15) return null;
  const picks = value.flatMap((candidate): CanonicalEventPick[] => {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return [];
    const row = candidate as JsonRecord;
    if (
      typeof row.element !== 'number' ||
      !Number.isSafeInteger(row.element) ||
      row.element <= 0 ||
      typeof row.position !== 'number' ||
      !Number.isSafeInteger(row.position) ||
      row.position < 1 ||
      row.position > 15 ||
      typeof row.multiplier !== 'number' ||
      !Number.isSafeInteger(row.multiplier) ||
      row.multiplier < 0 ||
      row.multiplier > 3 ||
      typeof row.is_captain !== 'boolean' ||
      typeof row.is_vice_captain !== 'boolean'
    ) {
      return [];
    }
    return [
      {
        element: row.element,
        position: row.position,
        multiplier: row.multiplier,
        is_captain: row.is_captain,
        is_vice_captain: row.is_vice_captain,
      },
    ];
  });
  if (
    picks.length !== 15 ||
    new Set(picks.map((pick) => pick.element)).size !== 15 ||
    new Set(picks.map((pick) => pick.position)).size !== 15 ||
    picks.filter((pick) => pick.is_captain).length !== 1 ||
    picks.filter((pick) => pick.is_vice_captain).length !== 1 ||
    picks.some((pick) => pick.is_captain && pick.is_vice_captain)
  ) {
    return null;
  }
  return picks.sort((left, right) => left.position - right.position);
};

/**
 * Final score rows carry the immutable pick payload used by FPL to calculate
 * the result. Display fields (player name, fixture and live stats) still come
 * from the event pick read model, but score-bearing fields must be overlaid
 * from the result payload. A mismatch fails closed instead of combining two
 * different team revisions.
 */
const overlayFinalResultPicks = (
  result: EventResult,
  displayRows: readonly PickRow[],
): PickRow[] | null => {
  const finalPicks = parseCanonicalEventPicks(result.event_picks);
  if (!finalPicks || displayRows.length !== 15) return null;
  const displayByElement = new Map(displayRows.map((row) => [row.element, row] as const));
  if (displayByElement.size !== 15) return null;
  const merged = finalPicks.map((pick) => {
    const display = displayByElement.get(pick.element);
    if (!display || display.position !== pick.position) return null;
    return {
      ...display,
      position: pick.position,
      multiplier: pick.multiplier,
      is_captain: pick.is_captain,
      is_vice_captain: pick.is_vice_captain,
      active_chip: pick.position === 1 ? display.active_chip : null,
      transfers: pick.position === 1 ? display.transfers : null,
      transfers_cost: pick.position === 1 ? display.transfers_cost : null,
    } satisfies PickRow;
  });
  return merged.every((row): row is PickRow => row !== null) ? merged : null;
};

/**
 * Current-event pick detail must use the same immutable player-live payload as
 * the projected manager headline. The mutable player_gameweek_stats table is
 * still used for historical/final reads, but never for a provisional score.
 */
const overlayProjectedEventLiveStats = (
  eventId: number,
  rows: PickRow[],
  eventLives: readonly EventLive[],
): void => {
  const liveByElement = new Map(eventLives.map((row) => [row.elementId, row] as const));
  for (const row of rows) {
    const live = liveByElement.get(row.element);
    if (!live) {
      throw new MyFplSnapshotIncompleteError(
        `Event-live publication is missing player ${row.element} for event ${eventId}`,
      );
    }
    row.total_points = live.totalPoints;
    row.minutes = live.minutes;
    row.goals_scored = live.goalsScored;
    row.assists = live.assists;
    row.clean_sheets = live.cleanSheets;
    row.goals_conceded = live.goalsConceded;
    row.yellow_cards = live.yellowCards;
    row.red_cards = live.redCards;
    row.saves = live.saves;
    row.penalties_saved = live.penaltiesSaved;
    row.bonus = live.bonus;
    row.bps = live.bps;
    row.expected_goals = live.expectedGoals;
    row.expected_assists = live.expectedAssists;
    row.expected_goal_involvements = live.expectedGoalInvolvements;
    row.expected_goals_conceded = live.expectedGoalsConceded;
  }
};

/**
 * Fixture display facts must come from the same pinned Live Points V2 publication as
 * the projected score. The mutable fixtures table may advance while a My FPL
 * capture is assembling its children, so only team labels remain database
 * presentation metadata here; fixture membership, home/away and score are
 * rebuilt from the pinned immutable fixture payload.
 */
const overlayPinnedEventFixtures = (
  eventId: number,
  rows: PickRow[],
  fixtures: readonly Fixture[],
  teamShortNameById: ReadonlyMap<number, string>,
): void => {
  const kickoffTimestamp = (value: Date | string | null): number => {
    const timestamp = value instanceof Date ? value.getTime() : Date.parse(value ?? '');
    return Number.isFinite(timestamp) ? timestamp : Number.MAX_SAFE_INTEGER;
  };
  const eventFixtures = fixtures
    .filter((fixture) => fixture.event === eventId)
    .sort(
      (left, right) =>
        kickoffTimestamp(left.kickoffTime as Date | string | null) -
          kickoffTimestamp(right.kickoffTime as Date | string | null) || left.id - right.id,
    );
  const fixtureIds = new Set<number>();
  for (const fixture of eventFixtures) {
    if (fixtureIds.has(fixture.id)) {
      throw new MyFplSnapshotIncompleteError(
        `Event-live publication contains duplicate fixture ${fixture.id} for event ${eventId}`,
      );
    }
    fixtureIds.add(fixture.id);
  }
  if (fixtures.some((fixture) => fixture.event !== null && fixture.event !== eventId)) {
    throw new MyFplSnapshotIncompleteError(
      `Event-live publication contains fixtures outside event ${eventId}`,
    );
  }

  for (const row of rows) {
    if (row.team_id === null || !Number.isSafeInteger(row.team_id) || row.team_id <= 0) {
      throw new MyFplSnapshotIncompleteError(
        `Event pick ${row.element} has no event-scoped team for event ${eventId}`,
      );
    }
    const playerFixtures = eventFixtures.filter(
      (fixture) => fixture.teamH === row.team_id || fixture.teamA === row.team_id,
    );
    row.fixture_count = playerFixtures.length;
    row.against_short_name = playerFixtures
      .map((fixture) => {
        const opponentId = fixture.teamH === row.team_id ? fixture.teamA : fixture.teamH;
        const opponentShortName = teamShortNameById.get(opponentId);
        if (!opponentShortName) {
          throw new MyFplSnapshotIncompleteError(
            `Event-live publication is missing team metadata for opponent ${opponentId} in event ${eventId}`,
          );
        }
        return opponentShortName;
      })
      .join(' / ');
    row.was_home = playerFixtures
      .map((fixture) => (fixture.teamH === row.team_id ? 'H' : 'A'))
      .join(' / ');
    row.score = playerFixtures
      .map((fixture) => {
        if (fixture.teamHScore === null || fixture.teamAScore === null) return '';
        return fixture.teamH === row.team_id
          ? `${fixture.teamHScore}-${fixture.teamAScore}`
          : `${fixture.teamAScore}-${fixture.teamHScore}`;
      })
      .join(' / ');
  }
};

const mapTransfer = (row: TransferRow): JsonRecord => ({
  eventId: row.event_id,
  elementIn: row.element_in_id,
  elementInWebName: row.element_in_web_name ?? '',
  elementInTypeName: positionName(integerValue(row.element_in_type)),
  elementInTeamShortName: row.element_in_team_short_name ?? '',
  elementInCost: integerValue(row.element_in_cost),
  elementInPoints: row.element_in_points,
  elementInPlayed: row.element_in_played,
  elementOut: row.element_out_id,
  elementOutWebName: row.element_out_web_name ?? '',
  elementOutTypeName: positionName(integerValue(row.element_out_type)),
  elementOutTeamShortName: row.element_out_team_short_name ?? '',
  elementOutCost: integerValue(row.element_out_cost),
  elementOutPoints: row.element_out_points,
  sameGameweekGain: row.same_gameweek_gain,
  threeGameweekGain: row.three_gameweek_gain,
  fiveGameweekGain: row.five_gameweek_gain,
  evaluatedThroughEventId: row.evaluated_through_event_id,
  time: iso(row.transfer_time) ?? new Date(0).toISOString(),
});

const resultPayload = (result: EventResult, picks: JsonRecord[]): JsonRecord => ({
  eventId: result.event_id,
  inputRevision: result.input_revision,
  scoreRevision: result.score_revision,
  eventPoints: result.event_points,
  eventRank: result.event_rank,
  overallPoints: result.overall_points,
  overallRank: result.overall_rank,
  eventTransfers: result.event_transfers,
  eventTransfersCost: result.event_transfers_cost,
  eventNetPoints: result.event_net_points,
  eventBenchPoints: result.event_bench_points ?? 0,
  eventAutoSubPoints: result.event_auto_sub_points ?? 0,
  eventChip: chip(result.event_chip),
  eventCaptainPoints: result.captain_points ?? 0,
  playedCaptainWebName:
    (picks.find((pick) => integerValue(pick.element) === result.played_captain_element_id)
      ?.webName as string | undefined) ?? null,
  playedCaptainTeamShortName:
    (picks.find((pick) => integerValue(pick.element) === result.played_captain_element_id)
      ?.teamShortName as string | undefined) ?? null,
  teamValue: result.team_value,
  bank: result.bank,
  picks,
  automaticSubstitutions: automaticSubstitutionInputs(result.automatic_substitutions),
});

const managerReviewPickInput = (pick: JsonRecord): MyFplManagerReviewPickInput => ({
  element: integerValue(pick.element),
  position: integerValue(pick.position),
  webName: String(pick.webName ?? ''),
  teamShortName: String(pick.teamShortName ?? ''),
  elementTypeName: String(pick.elementTypeName ?? ''),
  isCaptain: pick.isCaptain === true,
  isViceCaptain: pick.isViceCaptain === true,
  multiplier: integerValue(pick.multiplier),
  totalPoints: integerValue(pick.totalPoints),
  isPlayed: pick.isPlayed === true,
  autoSub: pick.autoSub === true,
});

const managerReviewGameweekInput = (
  result: EventResult,
  picks: readonly JsonRecord[],
  status: MyFplSnapshotKind,
): MyFplManagerReviewGameweekInput => {
  const eventChip = chip(result.event_chip);
  const playerPoints = picks.reduce(
    (sum, pick) => sum + integerValue(pick.totalPoints) * integerValue(pick.multiplier),
    0,
  );
  const playedCaptain = picks.find(
    (pick) => integerValue(pick.element) === result.played_captain_element_id,
  );
  return {
    eventId: result.event_id,
    status,
    eventPoints: result.event_points,
    eventRank: result.event_rank,
    overallPoints: result.overall_points,
    overallRank: result.overall_rank,
    eventTransfers: result.event_transfers,
    eventTransfersCost: result.event_transfers_cost,
    eventNetPoints: result.event_net_points,
    eventBenchPoints: result.event_bench_points ?? 0,
    eventAutoSubPoints: result.event_auto_sub_points ?? 0,
    eventChip,
    eventCaptainPoints: result.captain_points ?? 0,
    assistantManagerPoints: eventChip === 'MANAGER' ? result.event_points - playerPoints : 0,
    captainBlank: isBlankManagerCaptain(picks),
    playedCaptainElement: result.played_captain_element_id,
    playedCaptainWebName: typeof playedCaptain?.webName === 'string' ? playedCaptain.webName : null,
    playedCaptainTeamShortName:
      typeof playedCaptain?.teamShortName === 'string' ? playedCaptain.teamShortName : null,
    teamValue: result.team_value,
    bank: result.bank,
    picks: picks.map(managerReviewPickInput),
    automaticSubstitutions: automaticSubstitutionInputs(result.automatic_substitutions),
  };
};

const canonicalEventPicks = (picks: readonly PickRow[]) =>
  [...picks]
    .sort((left, right) => left.position - right.position || left.element - right.element)
    .map((pick) => ({
      element: pick.element,
      position: pick.position,
      multiplier: pick.multiplier,
      is_captain: pick.is_captain,
      is_vice_captain: pick.is_vice_captain,
    }));

const finalResultRevisions = (
  result: EventResult,
  picks: readonly PickRow[],
  dataCheckedAt: Date | string,
): { inputRevision: string; scoreRevision: string } => {
  const eventPicks = canonicalEventPicks(picks);
  const picksRevision = contentHash(eventPicks);
  const resultRevision = contentHash({
    entryId: result.entry_id,
    eventId: result.event_id,
    sourceResultId: result.source_result_id,
    eventPoints: result.event_points,
    eventNetPoints: result.event_net_points,
    overallPoints: result.overall_points,
    eventTransfers: result.event_transfers,
    eventTransfersCost: result.event_transfers_cost,
    eventChip: result.event_chip,
    playedCaptainElementId: result.played_captain_element_id,
    captainPoints: result.captain_points,
    automaticSubstitutions: result.automatic_substitutions,
    eventPicks,
  });
  const inputRevision = contentHash({
    eventId: result.event_id,
    entryId: result.entry_id,
    resultRevision,
    picksRevision,
    dataCheckedAt: new Date(dataCheckedAt).toISOString(),
  });
  const scoreRevision = contentHash({
    inputRevision,
    eventPoints: result.event_points,
    netEventPoints: result.event_net_points,
    totalPoints: result.overall_points,
    transferCost: result.event_transfers_cost,
  });
  return { inputRevision, scoreRevision };
};

type ProjectedManagerScore = RevisionedEventLiveScore;

const projectedResult = (
  entry: EntrySource,
  eventId: number,
  score: ProjectedManagerScore,
  picks: PickRow[],
): EventResult => {
  const positionOnePick = picks.find((pick) => pick.position === 1);
  const effectiveLineup = new Map(
    (score.effectiveLineup ?? []).map((row) => [row.elementId, row] as const),
  );
  const captain =
    picks.find((pick) => effectiveLineup.get(pick.element)?.captainForScoring) ??
    picks.find((pick) => pick.is_captain);
  const incomingAutoSubs = picks.filter((pick) => {
    const effective = effectiveLineup.get(pick.element);
    return effective?.autoSub === true && effective.pickActive === true;
  });
  const automaticSubstitutions = incomingAutoSubs.map((pick) => {
    const outgoingElement = effectiveLineup.get(pick.element)?.autoSubForElementId;
    if (!outgoingElement) {
      throw new MyFplSnapshotIncompleteError(
        `Projected auto-substitution for entry ${entry.entry_id} has no accepted outgoing starter`,
      );
    }
    return { element_in: pick.element, element_out: outgoingElement };
  });
  const eventPoints = score.eventPoints;
  const eventNetPoints = score.netEventPoints;
  const transferCost = score.transferCost;
  return {
    source_result_id: null,
    updated_at: score.picksCheckedAt,
    event_id: eventId,
    entry_id: entry.entry_id,
    event_points: eventPoints,
    event_rank: null,
    overall_points: score.totalPoints ?? entry.overall_points ?? 0,
    overall_rank: null,
    event_transfers: positionOnePick?.transfers ?? 0,
    event_transfers_cost: transferCost,
    event_net_points: eventNetPoints,
    event_bench_points: picks.reduce((sum, pick) => {
      const effective = effectiveLineup.get(pick.element);
      return sum + (effective?.pickActive === false ? (pick.total_points ?? 0) : 0);
    }, 0),
    event_auto_sub_points: projectedEventAutoSubPoints(picks, effectiveLineup),
    event_chip: positionOnePick?.active_chip ?? null,
    played_captain_element_id: captain?.element ?? null,
    captain_points: captain
      ? (captain.total_points ?? 0) *
        (effectiveLineup.get(captain.element)?.effectiveMultiplier ?? 1)
      : 0,
    event_picks: canonicalEventPicks(picks),
    automatic_substitutions: automaticSubstitutions,
    team_value: entry.team_value,
    bank: entry.bank,
    // The projected row is sourced from the pinned Live Points V2 publication; it
    // intentionally has no rich result timestamp. Publication provenance is
    // carried separately by the My FPL header.
    rich_synced_at: null,
    input_revision: score.inputRevision ?? null,
    score_revision: score.revision,
  };
};

/**
 * The capture transaction reads the payload picks/results while the shared
 * manager-score service reads its own connection. Recompute the canonical
 * input revisions from the transaction rows and reject the publication if a
 * pick or finalized baseline changed between those reads. This keeps the
 * headline, detail picks and tournament row on one score input revision.
 */
const projectedScoreUsesCaptureInputs = (
  eventId: number,
  entryId: number,
  entryStartedEvent: number | null,
  score: ProjectedManagerScore,
  picks: readonly PickRow[],
  previousResults: readonly EventResult[],
  authorityRevision: string,
): boolean => {
  const firstScoringEvent = Math.max(1, entryStartedEvent ?? 1);
  const previousEntryResults = previousResults.filter(
    (row) =>
      row.entry_id === entryId && row.event_id >= firstScoringEvent && row.event_id < eventId,
  );
  const previousTotal = previousEntryResults.reduce(
    (sum, row) => sum + (row.event_net_points ?? 0),
    0,
  );
  const inputRevision = buildScoreInputRevision({
    algorithmVersion: LIVE_POINTS_V2_ALGORITHM_VERSION,
    authorityRevision,
    entryId,
    entryStartedEvent,
    picks: picks.map((pick) => ({
      position: pick.position,
      elementId: pick.element,
      elementType: pick.element_type,
      teamId: pick.team_id,
      multiplier: pick.multiplier,
      isCaptain: pick.is_captain,
      isViceCaptain: pick.is_vice_captain,
      transfersCost: pick.transfers_cost,
      sourceUpdatedAt: new Date(pick.source_updated_at),
      activeChip: pick.active_chip,
    })),
    previousTotal: eventId === firstScoringEvent ? 0 : previousTotal,
    previousTotalsThroughEventId: eventId > firstScoringEvent ? eventId - 1 : null,
    previousResultEvidence: previousEntryResults.map((row) => ({
      entryId: row.entry_id,
      eventId: row.event_id,
      sourceResultId: row.source_result_id,
      eventNetPoints: row.event_net_points,
      richSyncedAt: row.rich_synced_at ? new Date(row.rich_synced_at) : null,
      updatedAt: new Date(row.updated_at),
    })),
  });
  return (
    score.inputRevision === inputRevision.inputRevision &&
    score.picksRevision === inputRevision.picksRevision &&
    score.previousTotalsRevision === inputRevision.previousTotalsRevision
  );
};

const average = (values: number[]): number | null =>
  values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;

function makeMetric(
  key: string,
  rows: JsonRecord[],
  value: (row: JsonRecord) => number | null,
  higherIsBetter: boolean,
): JsonRecord {
  const values = rows
    .map((row) => ({ row, value: value(row) }))
    .filter((item): item is { row: JsonRecord; value: number } => item.value !== null);
  const ordered = [...values].sort((left, right) =>
    higherIsBetter ? right.value - left.value : left.value - right.value,
  );
  const leader = ordered[0];
  return {
    key,
    leaderValue: leader?.value ?? null,
    leaderEntryId: leader ? integerValue(leader.row.entryId) : null,
    leaderEntryName: leader ? (leader.row.entryName as string | null) : null,
    leaderPlayerName: leader ? (leader.row.playerName as string | null) : null,
    averageValue: average(values.map((item) => item.value)),
    higherIsBetter,
  };
}

function buildAggregate(
  tournamentId: number,
  eventId: number,
  rows: JsonRecord[],
  historyByEntry: ReadonlyMap<number, HistoryRow[]>,
): JsonRecord {
  const ranked = rows.filter((row) => row.eventNetPoints !== null);
  const overallOrdered = [...ranked].sort(
    (left, right) => numberValue(right.overallPoints, -1) - numberValue(left.overallPoints, -1),
  );
  const rankFor = (source: JsonRecord[], key: 'eventNetPoints' | 'previousEventNetPoints') => {
    const sorted = source
      .filter((row) => row[key] !== null)
      .sort((left, right) => numberValue(right[key], -1) - numberValue(left[key], -1));
    return new Map(sorted.map((row, index) => [integerValue(row.entryId), index + 1]));
  };
  const currentRanks = rankFor(rows, 'eventNetPoints');
  const previousRanks = rankFor(rows, 'previousEventNetPoints');
  const rowWithRanks: Array<JsonRecord & { rank: number | null; previousRank: number | null }> =
    rows.map((row) => ({
      ...row,
      // Tournament board rows carry the authoritative points-group ranks.
      // Keep those values for grouped tournaments; only the full-field rank
      // fallback is derived from the event-net ordering.
      rank:
        typeof row.rank === 'number'
          ? row.rank
          : (currentRanks.get(integerValue(row.entryId)) ?? null),
      previousRank:
        typeof row.previousRank === 'number'
          ? row.previousRank
          : (previousRanks.get(integerValue(row.entryId)) ?? null),
    }));
  const performance = (row: JsonRecord): JsonRecord => ({
    entryId: integerValue(row.entryId),
    entryName: row.entryName ?? null,
    playerName: row.playerName ?? null,
    eventPoints: integerValue(row.eventPoints),
    eventNetPoints: integerValue(row.eventNetPoints),
    rank: row.rank ?? null,
    previousRank: row.previousRank ?? null,
    captainId: row.captainId ?? null,
    captainWebName: row.captainWebName ?? null,
    captainTeamShortName: row.captainTeamShortName ?? null,
    captainPoints: row.captainPoints ?? null,
  });
  const topPerformers = [...rowWithRanks]
    .filter((row) => row.eventNetPoints !== null)
    .sort((left, right) => numberValue(right.eventPoints) - numberValue(left.eventPoints))
    .slice(0, 5)
    .map(performance);
  const risers = [...rowWithRanks]
    .filter((row) => row.rank !== null && row.previousRank !== null)
    .sort(
      (left, right) =>
        numberValue(right.previousRank) -
        numberValue(right.rank) -
        (numberValue(left.previousRank) - numberValue(left.rank)),
    )
    .slice(0, 5)
    .map(performance);
  const fallers = [...rowWithRanks]
    .filter((row) => row.rank !== null && row.previousRank !== null)
    .sort(
      (left, right) =>
        numberValue(right.rank) -
        numberValue(right.previousRank) -
        (numberValue(left.rank) - numberValue(left.previousRank)),
    )
    .slice(0, 5)
    .map(performance);

  const distribution = (key: string, label: (row: JsonRecord) => string, team = false) => {
    const groups = new Map<string, JsonRecord[]>();
    const completeRows = rows.filter((row) => row.eventNetPoints !== null);
    for (const row of completeRows) {
      const groupKey = String(row[key] ?? 'NONE');
      const group = groups.get(groupKey) ?? [];
      group.push(row);
      groups.set(groupKey, group);
    }
    return [...groups.entries()].map(([groupKey, group]) => ({
      key: groupKey,
      label: label(group[0] ?? {}),
      teamShortName: team ? (group[0]?.captainTeamShortName ?? null) : null,
      count: group.length,
      percentage: completeRows.length === 0 ? 0 : (group.length * 100) / completeRows.length,
      averagePoints: average(group.map((row) => integerValue(row.eventPoints))) ?? 0,
    }));
  };

  const seasonPaths: JsonRecord = {};
  const pathEvents = [
    ...new Set(
      [...historyByEntry.values()]
        .flatMap((history) => history.map((item) => item.eventId))
        .filter((historyEventId) => historyEventId <= eventId),
    ),
  ].sort((left, right) => left - right);
  for (const row of rows) {
    const entryId = integerValue(row.entryId);
    const history = historyByEntry.get(entryId) ?? [];
    const cumulative = new Map<number, number>();
    const points = pathEvents.flatMap((pathEventId) => {
      const field = rows.flatMap((fieldRow) => {
        const fieldHistory = (historyByEntry.get(integerValue(fieldRow.entryId)) ?? []).find(
          (item) => item.eventId === pathEventId,
        );
        if (!fieldHistory) return [];
        const fieldEntryId = integerValue(fieldRow.entryId);
        const nextCumulative = (cumulative.get(fieldEntryId) ?? 0) + fieldHistory.eventNetPoints;
        cumulative.set(fieldEntryId, nextCumulative);
        return [{ entryId: fieldEntryId, cumulative: nextCumulative, history: fieldHistory }];
      });
      const mine = history.find((item) => item.eventId === pathEventId);
      if (!mine) return [];
      const ordered = [...field].sort(
        (left, right) => right.cumulative - left.cumulative || left.entryId - right.entryId,
      );
      const leader = ordered[0];
      const averagePoints = average(field.map((item) => item.history.overallPoints));
      return [
        {
          gameweek: pathEventId,
          tournamentRank: ordered.findIndex((item) => item.entryId === entryId) + 1,
          gapToLeader: leader
            ? Math.max(0, leader.cumulative - (cumulative.get(entryId) ?? 0))
            : null,
          pointsVsAverage: averagePoints === null ? null : mine.overallPoints - averagePoints,
          fieldSize: field.length,
          overallPoints: mine.overallPoints,
          leaderOverallPoints: leader?.history.overallPoints ?? null,
          averageOverallPoints: averagePoints,
        },
      ];
    });
    seasonPaths[String(entryId)] = points;
  }

  const viewerByEntryId: JsonRecord = {};
  for (const row of rowWithRanks) {
    const entryId = integerValue(row.entryId);
    const history = historyByEntry.get(entryId) ?? [];
    const totalCosts = history.reduce((sum, item) => sum + item.eventTransfersCost, 0);
    const totalBenchPoints = history.reduce((sum, item) => sum + item.eventBenchPoints, 0);
    const autoSubPoints = history.reduce((sum, item) => sum + (item.eventAutoSubPoints ?? 0), 0);
    viewerByEntryId[String(entryId)] = {
      entryId,
      overallRank: row.overallRank ?? null,
      tournamentOverallRank: row.rank ?? null,
      teamValue: row.teamValue ?? null,
      tournamentTeamValueRank: null,
      transfersNum: history.reduce((sum, item) => sum + item.eventTransfers, 0),
      tournamentTransfersRank: null,
      totalCosts,
      tournamentCostsRank: null,
      totalBenchPoints,
      tournamentBenchPointsRank: null,
      autoSubPoints,
      tournamentAutoSubRank: null,
      overallPoints: row.overallPoints ?? null,
      leaderOverallPoints: overallOrdered[0]?.overallPoints ?? null,
      gapToLeader:
        row.overallPoints === null || overallOrdered[0]?.overallPoints === undefined
          ? null
          : Math.max(
              0,
              numberValue(overallOrdered[0].overallPoints) - numberValue(row.overallPoints),
            ),
      pointsBehindNext: null,
      pointsAheadOfPrev: null,
    };
  }

  const metrics = [
    makeMetric('OVERALL_POINTS', rows, (row) => nullableNumber(row.overallPoints), true),
    makeMetric('TEAM_VALUE', rows, (row) => nullableNumber(row.teamValue), true),
    makeMetric(
      'TRANSFERS',
      rows,
      (row) =>
        (historyByEntry.get(integerValue(row.entryId)) ?? []).reduce(
          (sum, item) => sum + item.eventTransfers,
          0,
        ),
      false,
    ),
    makeMetric(
      'TOTAL_COSTS',
      rows,
      (row) =>
        (historyByEntry.get(integerValue(row.entryId)) ?? []).reduce(
          (sum, item) => sum + item.eventTransfersCost,
          0,
        ),
      false,
    ),
    makeMetric(
      'BENCH_POINTS',
      rows,
      (row) =>
        (historyByEntry.get(integerValue(row.entryId)) ?? []).reduce(
          (sum, item) => sum + item.eventBenchPoints,
          0,
        ),
      true,
    ),
    makeMetric(
      'AUTO_SUB_POINTS',
      rows,
      (row) =>
        (historyByEntry.get(integerValue(row.entryId)) ?? []).reduce(
          (sum, item) => sum + (item.eventAutoSubPoints ?? 0),
          0,
        ),
      true,
    ),
  ];

  const averageOverallPoints = average(
    ranked.map((row) => numberValue(row.overallPoints)).filter((value) => Number.isFinite(value)),
  );

  return {
    eventId,
    entryCount: rows.length,
    leaderOverallPoints: overallOrdered[0]?.overallPoints ?? null,
    secondOverallPoints: overallOrdered[1]?.overallPoints ?? null,
    gapFirstSecond:
      overallOrdered[0] && overallOrdered[1]
        ? numberValue(overallOrdered[0].overallPoints) -
          numberValue(overallOrdered[1].overallPoints)
        : null,
    averageOverallPoints: averageOverallPoints === null ? null : Math.round(averageOverallPoints),
    metrics,
    viewers: viewerByEntryId,
    topPerformers,
    risers,
    fallers,
    captainDistribution: distribution(
      'captainId',
      (row) => String(row.captainWebName ?? 'NONE'),
      true,
    ),
    chipDistribution: distribution('eventChip', (row) => String(row.eventChip ?? 'NONE')),
    seasonPath: [],
    seasonPaths,
    tournamentId,
  };
}

function groupBy<T>(rows: readonly T[], key: (row: T) => number): Map<number, T[]> {
  const grouped = new Map<number, T[]>();
  for (const row of rows) {
    const group = grouped.get(key(row)) ?? [];
    group.push(row);
    grouped.set(key(row), group);
  }
  return grouped;
}

type MyFplPublicationRow = {
  season_id: number;
  event_id: number;
  revision: number | string;
  snapshot_date: string;
  source_checked_at: Date | string;
  published_at: Date | string;
  kind: MyFplSnapshotKind;
  expected_entry_count: number;
  ready_entry_count: number;
  empty_entry_count: number;
  not_applicable_entry_count: number;
  expected_tournament_count: number;
  ready_tournament_count: number;
  content_sha256: string;
  score_source: 'FPL_EVENT_LIVE' | 'FPL_FINAL_RESULT' | null;
  live_publication_id: string | null;
  live_revision: string | null;
  algorithm_version: string | null;
  source_min_checked_at: Date | string | null;
  source_max_checked_at: Date | string | null;
  override_actor: string | null;
  override_reason: string | null;
  idempotency_key: string | null;
};

function mapMyFplPublication(row: MyFplPublicationRow): MyFplSnapshotPublication {
  const revision = Number(row.revision);
  if (!Number.isSafeInteger(revision) || revision <= 0) {
    throw new Error('My FPL publication has an invalid revision');
  }
  return {
    seasonId: row.season_id,
    eventId: row.event_id,
    revision,
    snapshotDate: row.snapshot_date,
    sourceCheckedAt: new Date(row.source_checked_at),
    publishedAt: new Date(row.published_at),
    kind: row.kind,
    expectedEntryCount: row.expected_entry_count,
    readyEntryCount: row.ready_entry_count,
    emptyEntryCount: row.empty_entry_count,
    notApplicableEntryCount: row.not_applicable_entry_count,
    expectedTournamentCount: row.expected_tournament_count,
    readyTournamentCount: row.ready_tournament_count,
    contentSha256: row.content_sha256,
    scoreSource: row.score_source,
    livePublicationId: row.live_publication_id,
    liveRevision: row.live_revision,
    algorithmVersion: row.algorithm_version,
    sourceMinCheckedAt: row.source_min_checked_at ? new Date(row.source_min_checked_at) : null,
    sourceMaxCheckedAt: row.source_max_checked_at ? new Date(row.source_max_checked_at) : null,
    overrideActor: row.override_actor,
    overrideReason: row.override_reason,
    idempotencyKey: row.idempotency_key,
  };
}

/**
 * A publication is readable only when its score authority and source span
 * describe one complete, internally consistent capture. Incomplete legacy or
 * partially migrated rows are treated as unavailable; callers must recapture
 * instead of silently using their payload.
 */
export function isCompleteMyFplPublication(
  publication: MyFplSnapshotPublication | null,
): publication is MyFplSnapshotPublication {
  if (!publication) return false;
  const sourceCheckedAt = publication.sourceCheckedAt.getTime();
  const sourceMinCheckedAt = publication.sourceMinCheckedAt?.getTime() ?? Number.NaN;
  const sourceMaxCheckedAt = publication.sourceMaxCheckedAt?.getTime() ?? Number.NaN;
  if (
    !Number.isSafeInteger(publication.seasonId) ||
    publication.seasonId <= 0 ||
    !Number.isSafeInteger(publication.eventId) ||
    publication.eventId <= 0 ||
    !Number.isSafeInteger(publication.revision) ||
    publication.revision <= 0 ||
    !Number.isFinite(sourceCheckedAt) ||
    !Number.isFinite(sourceMinCheckedAt) ||
    !Number.isFinite(sourceMaxCheckedAt) ||
    sourceCheckedAt !== sourceMinCheckedAt ||
    sourceMinCheckedAt > sourceMaxCheckedAt ||
    !Number.isFinite(publication.publishedAt.getTime()) ||
    !/^[0-9a-f]{64}$/i.test(publication.contentSha256) ||
    !Number.isSafeInteger(publication.expectedEntryCount) ||
    publication.expectedEntryCount < 0 ||
    !Number.isSafeInteger(publication.readyEntryCount) ||
    publication.readyEntryCount < 0 ||
    !Number.isSafeInteger(publication.emptyEntryCount) ||
    publication.emptyEntryCount < 0 ||
    !Number.isSafeInteger(publication.notApplicableEntryCount) ||
    publication.notApplicableEntryCount < 0 ||
    publication.readyEntryCount + publication.emptyEntryCount !== publication.expectedEntryCount ||
    !Number.isSafeInteger(publication.expectedTournamentCount) ||
    publication.expectedTournamentCount < 0 ||
    !Number.isSafeInteger(publication.readyTournamentCount) ||
    publication.readyTournamentCount !== publication.expectedTournamentCount
  ) {
    return false;
  }
  if (publication.kind === 'PROVISIONAL') {
    return (
      publication.scoreSource === 'FPL_EVENT_LIVE' &&
      publication.livePublicationId !== null &&
      UUID_RE.test(publication.livePublicationId) &&
      publication.liveRevision !== null &&
      publication.liveRevision.trim() !== '' &&
      publication.algorithmVersion === LIVE_POINTS_V2_ALGORITHM_VERSION
    );
  }
  return (
    publication.kind === 'FINAL' &&
    publication.scoreSource === 'FPL_FINAL_RESULT' &&
    publication.livePublicationId === null &&
    publication.liveRevision === null &&
    publication.algorithmVersion === null
  );
}

async function loadActivePublication(
  client: postgres.Sql | postgres.TransactionSql,
  seasonId: number,
  eventId: number,
): Promise<MyFplSnapshotPublication | null> {
  const rows = await client<MyFplPublicationRow[]>`
    SELECT season_id, event_id, revision, snapshot_date, source_checked_at,
           published_at, kind, expected_entry_count, ready_entry_count,
           empty_entry_count, not_applicable_entry_count,
           expected_tournament_count, ready_tournament_count,
           content_sha256, score_source, live_publication_id, live_revision,
           algorithm_version, source_min_checked_at, source_max_checked_at,
           override_actor, override_reason, idempotency_key
    FROM competition.my_fpl_snapshot_publications
    WHERE season_id = ${seasonId} AND event_id = ${eventId} AND active
    ORDER BY revision DESC
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  const publication = mapMyFplPublication(row);
  return isCompleteMyFplPublication(publication) ? publication : null;
}

async function loadPublicationByIdempotencyKey(
  client: postgres.TransactionSql,
  seasonId: number,
  eventId: number,
  idempotencyKey: string,
): Promise<MyFplSnapshotPublication | null> {
  const rows = await client<MyFplPublicationRow[]>`
    SELECT season_id, event_id, revision, snapshot_date, source_checked_at,
           published_at, kind, expected_entry_count, ready_entry_count,
           empty_entry_count, not_applicable_entry_count,
           expected_tournament_count, ready_tournament_count,
           content_sha256, score_source, live_publication_id, live_revision,
           algorithm_version, source_min_checked_at, source_max_checked_at,
           override_actor, override_reason, idempotency_key
    FROM competition.my_fpl_snapshot_publications
    WHERE season_id = ${seasonId} AND event_id = ${eventId}
      AND idempotency_key = ${idempotencyKey}
    LIMIT 1
  `;
  if (!rows[0]) return null;
  const publication = mapMyFplPublication(rows[0]);
  return isCompleteMyFplPublication(publication) ? publication : null;
}

export async function getActiveMyFplPublication(
  season: FplSeasonRef,
  eventId: number,
): Promise<MyFplSnapshotPublication | null> {
  return loadActivePublication(await getDbClient(), season.seasonId, eventId);
}

/**
 * A FINAL publication may have been written by the pre-manager-review
 * snapshot contract.  The maintenance worker can use this check to skip a
 * settled event only when every expected entry row is the hard-cut v2 shape;
 * a legacy FINAL must flow through capture so it is rebuilt before consumers
 * are allowed to observe it.
 */
export async function isManagerReviewV2MyFplPublication(
  season: FplSeasonRef,
  eventId: number,
  publication: MyFplSnapshotPublication | null,
): Promise<boolean> {
  if (
    !publication ||
    publication.kind !== 'FINAL' ||
    !isCompleteMyFplPublication(publication) ||
    publication.seasonId !== season.seasonId ||
    publication.eventId !== eventId
  ) {
    return false;
  }
  const rows = await (await getDbClient())<{ total_count: number; v2_count: number }[]>`
    SELECT count(*)::integer AS total_count,
           count(*) FILTER (
             WHERE jsonb_typeof(payload) = 'object'
               AND payload->>'contractVersion' = '2'
           )::integer AS v2_count
    FROM competition.my_fpl_snapshot_entries
    WHERE season_id = ${season.seasonId}
      AND event_id = ${eventId}
      AND revision = ${publication.revision}
  `;
  const counts = rows[0];
  const expectedEntryRows = publication.expectedEntryCount + publication.notApplicableEntryCount;
  return Boolean(
    counts &&
      expectedEntryRows > 0 &&
      counts.total_count === expectedEntryRows &&
      counts.v2_count === expectedEntryRows,
  );
}

/**
 * Redis is a derived pointer, so a missing/corrupt pointer must not force a
 * new source capture when PostgreSQL already has the active complete
 * publication.  Re-open its delivered receipt for the normal CAS delivery
 * path; the worker can then settle the pointer without mixing revisions.
 */
export async function requeueDeliveredMyFplSnapshotPublication(
  season: FplSeasonRef,
  eventId: number,
  revision: number,
): Promise<boolean> {
  if (!Number.isSafeInteger(revision) || revision <= 0) return false;
  const rows = await (
    await getDbClient()
  ).begin(
    async (tx) =>
      tx<{ outbox_id: string }[]>`
      UPDATE competition.my_fpl_snapshot_publication_outbox outbox
      SET status = 'PENDING',
          available_at = clock_timestamp(),
          delivered_at = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL,
          last_error = 'Redis manifest missing or invalid; replaying durable publication',
          updated_at = clock_timestamp()
      FROM competition.my_fpl_snapshot_publications publication
      WHERE outbox.season_id = ${season.seasonId}
        AND outbox.event_id = ${eventId}
        AND outbox.revision = ${revision}
        AND outbox.status = 'DELIVERED'
        AND publication.season_id = outbox.season_id
        AND publication.event_id = outbox.event_id
        AND publication.revision = outbox.revision
        AND publication.active = true
      RETURNING outbox.outbox_id
    `,
  );
  return rows.length === 1;
}

export async function hasFinalMyFplPublication(
  season: FplSeasonRef,
  eventId: number,
): Promise<boolean> {
  const publication = await getActiveMyFplPublication(season, eventId);
  return publication?.kind === 'FINAL' && isCompleteMyFplPublication(publication);
}

export async function getMyFplSnapshotOperationalStatus(
  season: FplSeasonRef,
  now = new Date(),
): Promise<readonly MyFplSnapshotOperationalStatus[]> {
  const rows = await (await getDbClient())<
    {
      event_id: number;
      deadline_time: Date | string | null;
      finished: boolean;
      data_checked: boolean;
      data_checked_at: Date | string | null;
      revision: number | string | null;
      snapshot_date: string | null;
      kind: MyFplSnapshotKind | null;
      published_at: Date | string | null;
      expected_entry_count: number | null;
      ready_entry_count: number | null;
      empty_entry_count: number | null;
      not_applicable_entry_count: number | null;
      expected_tournament_count: number | null;
      ready_tournament_count: number | null;
      current_entry_count: number;
      missing_active_entry_count: number;
      pending_outbox_count: number;
      outbox_attempts: number;
      pending_invalidation_count: number;
      invalidation_attempts: number;
    }[]
  >`
    SELECT event.event_id, event.deadline_time, event.finished, event.data_checked,
           event.data_checked_at, publication.revision, publication.snapshot_date,
           publication.kind, publication.published_at, publication.expected_entry_count,
           publication.ready_entry_count, publication.empty_entry_count,
           publication.expected_tournament_count, publication.ready_tournament_count,
           coverage.current_entry_count, coverage.not_applicable_entry_count,
           coverage.missing_active_entry_count,
           COALESCE(outbox.pending_outbox_count, 0)::integer AS pending_outbox_count,
           COALESCE(outbox.outbox_attempts, 0)::integer AS outbox_attempts,
           COALESCE(invalidation.pending_invalidation_count, 0)::integer
             AS pending_invalidation_count,
           COALESCE(invalidation.invalidation_attempts, 0)::integer AS invalidation_attempts
    FROM fpl.events event
    LEFT JOIN competition.my_fpl_snapshot_publications publication
      ON publication.season_id = event.season_id
     AND publication.event_id = event.event_id
     AND publication.active
    LEFT JOIN LATERAL (
      SELECT count(*)::integer AS current_entry_count,
             count(*) FILTER (
               WHERE current_entry.started_event IS NOT NULL
                 AND current_entry.started_event > event.event_id
             )::integer AS not_applicable_entry_count,
             count(*) FILTER (
               WHERE publication.revision IS NOT NULL
                 AND (current_entry.started_event IS NULL OR current_entry.started_event <= event.event_id)
                 AND NOT EXISTS (
                   SELECT 1
                   FROM competition.my_fpl_snapshot_entries snapshot_entry
                   WHERE snapshot_entry.season_id = current_entry.season_id
                     AND snapshot_entry.event_id = event.event_id
                     AND snapshot_entry.revision = publication.revision
                     AND snapshot_entry.entry_id = current_entry.entry_id
                 )
             )::integer AS missing_active_entry_count
      FROM competition.entries current_entry
      WHERE current_entry.season_id = event.season_id
    ) coverage ON TRUE
    LEFT JOIN LATERAL (
      SELECT count(*) FILTER (WHERE status IN ('PENDING', 'PROCESSING'))::integer AS pending_outbox_count,
             COALESCE(max(attempts), 0)::integer AS outbox_attempts
      FROM competition.my_fpl_snapshot_publication_outbox outbox_row
      WHERE outbox_row.season_id = event.season_id
        AND outbox_row.event_id = event.event_id
    ) outbox ON TRUE
    LEFT JOIN LATERAL (
      SELECT count(*) FILTER (WHERE status IN ('PENDING', 'PROCESSING', 'FAILED'))::integer
               AS pending_invalidation_count,
             COALESCE(max(attempts), 0)::integer AS invalidation_attempts
      FROM competition.my_fpl_snapshot_invalidation_outbox invalidation_row
      WHERE invalidation_row.season_id = event.season_id
        AND invalidation_row.event_id = event.event_id
    ) invalidation ON TRUE
    WHERE event.season_id = ${season.seasonId}
    ORDER BY event.event_id
  `;
  return rows.map((row) => {
    const dataCheckedAt = iso(row.data_checked_at);
    const publishedAt = iso(row.published_at);
    const finalDueAt = dataCheckedAt
      ? new Date(new Date(dataCheckedAt).getTime() + 2 * 60 * 60_000)
      : null;
    const finalSla: MyFplSnapshotOperationalStatus['finalSla'] =
      !row.finished || !row.data_checked
        ? 'NOT_DUE'
        : row.kind === 'FINAL'
          ? 'MET'
          : finalDueAt && now.getTime() <= finalDueAt.getTime()
            ? 'DUE'
            : 'BREACHED';
    const pendingCorrectionEntryCount =
      row.kind === 'PROVISIONAL' ? row.missing_active_entry_count : 0;
    return {
      eventId: row.event_id,
      deadlineTime: iso(row.deadline_time),
      finished: row.finished,
      dataChecked: row.data_checked,
      dataCheckedAt,
      activeRevision: row.revision === null ? null : Number(row.revision),
      activeSnapshotDate: row.snapshot_date,
      activeKind: row.kind,
      activePublishedAt: publishedAt,
      activeAgeSeconds: publishedAt
        ? Math.max(0, Math.floor((now.getTime() - new Date(publishedAt).getTime()) / 1000))
        : null,
      expectedEntryCount: row.expected_entry_count,
      readyEntryCount: row.ready_entry_count,
      emptyEntryCount: row.empty_entry_count,
      notApplicableEntryCount: row.not_applicable_entry_count,
      expectedTournamentCount: row.expected_tournament_count,
      readyTournamentCount: row.ready_tournament_count,
      currentEntryCount: row.current_entry_count,
      pendingCorrectionEntryCount,
      coverageState: resolveMyFplSnapshotCoverageState(row.kind, pendingCorrectionEntryCount),
      pendingOutboxCount: row.pending_outbox_count,
      outboxAttempts: row.outbox_attempts,
      pendingInvalidationCount: row.pending_invalidation_count,
      invalidationAttempts: row.invalidation_attempts,
      finalSla,
    };
  });
}

async function captureMyFplSnapshotOnce(
  season: FplSeasonRef,
  eventId: number,
  kind: MyFplSnapshotKind,
  options: MyFplSnapshotCaptureOptions = {},
): Promise<MyFplSnapshotCaptureResult> {
  const now = options.now ?? new Date();
  const snapshotDate = options.snapshotDate ?? utc8DateKey(now);
  const override = [options.actor, options.reason, options.idempotencyKey].filter(
    (value) => value !== undefined,
  );
  if (override.length !== 0 && (kind !== 'FINAL' || override.length !== 3)) {
    throw new Error('My FPL final override requires actor, reason, and idempotencyKey');
  }
  const overrideActor = options.actor?.trim() || null;
  const overrideReason = options.reason?.trim() || null;
  const idempotencyKey = options.idempotencyKey?.trim() || null;
  if (
    override.length !== 0 &&
    (!overrideActor || !overrideReason || !idempotencyKey || idempotencyKey.length > 200)
  ) {
    throw new Error('My FPL final override metadata is invalid');
  }
  const client = await getDbClient();
  // The production postgres-js runtime is configured with string timestamp
  // parameters. Keep the publication transaction on the same explicit wire
  // representation instead of passing Bun Date objects through the tagged
  // template serializer (which rejects Date at runtime).
  const nowIso = now.toISOString();
  const supersededBeforeIso = new Date(now.getTime() - 24 * 60 * 60_000).toISOString();
  const lockScopes = [
    myFplSnapshotSeasonLockScope(season.seasonId),
    myFplSnapshotEventLockScope(season.seasonId, eventId),
  ] as const;
  return runMyFplCaptureTransaction(client, lockScopes, async (tx) => {
    const eventRows = await tx<
      {
        finished: boolean;
        data_checked: boolean;
        data_checked_at: Date | string | null;
        deadline_time: Date | string | null;
      }[]
    >`
      SELECT finished, data_checked, data_checked_at, deadline_time
      FROM fpl.events
      WHERE season_id = ${season.seasonId} AND event_id = ${eventId}
      LIMIT 1
    `;
    const event = eventRows[0];
    if (!event) throw new MyFplSnapshotIncompleteError(`Event ${eventId} does not exist`);
    if (kind === 'FINAL' && (!event.finished || !event.data_checked)) {
      throw new MyFplSnapshotIncompleteError(`Event ${eventId} is not finalized by FPL`);
    }
    if (kind === 'FINAL' && !event.data_checked_at) {
      throw new MyFplSnapshotIncompleteError(
        `Event ${eventId} has no data_checked_at freshness fence`,
      );
    }
    if (kind === 'PROVISIONAL' && event.finished && event.data_checked) {
      throw new MyFplSnapshotIncompleteError(
        `Event ${eventId} is finalized; a PROVISIONAL capture is not an allowed score source`,
      );
    }
    if (event.deadline_time && new Date(event.deadline_time).getTime() > now.getTime()) {
      throw new MyFplSnapshotIncompleteError(`Event ${eventId} deadline has not passed`);
    }

    const active = await loadActivePublication(tx, season.seasonId, eventId);
    let activeFinalUsesManagerReviewV2 = false;
    if (isCompleteMyFplPublication(active) && active.kind === 'FINAL') {
      const activeEntryPayloadCounts = await tx<{ total_count: number; v2_count: number }[]>`
        SELECT count(*)::integer AS total_count,
               count(*) FILTER (
                 WHERE jsonb_typeof(payload) = 'object'
                   AND payload->>'contractVersion' = '2'
               )::integer AS v2_count
        FROM competition.my_fpl_snapshot_entries
        WHERE season_id = ${season.seasonId}
          AND event_id = ${eventId}
          AND revision = ${active.revision}
      `;
      const counts = activeEntryPayloadCounts[0];
      const expectedEntryRows = active.expectedEntryCount + active.notApplicableEntryCount;
      activeFinalUsesManagerReviewV2 = Boolean(
        counts &&
          expectedEntryRows > 0 &&
          counts.total_count === expectedEntryRows &&
          counts.v2_count === expectedEntryRows,
      );
    }
    if (
      activeFinalUsesManagerReviewV2 &&
      (!overrideActor ||
        !overrideReason ||
        !idempotencyKey ||
        active?.idempotencyKey === idempotencyKey)
    ) {
      return { status: 'noop', publication: active! };
    }
    if (idempotencyKey) {
      const priorOverride = await loadPublicationByIdempotencyKey(
        tx,
        season.seasonId,
        eventId,
        idempotencyKey,
      );
      if (
        priorOverride &&
        (!isCompleteMyFplPublication(active) ||
          activeFinalUsesManagerReviewV2 ||
          active.revision !== priorOverride.revision)
      ) {
        return { status: 'noop', publication: priorOverride };
      }
    }

    const entries = await tx<EntrySource[]>`
      SELECT entry_id, entry_name, player_name, region, started_event,
             overall_points, overall_rank, bank, team_value, total_transfers,
             transfers_synced_through_event_id, past_seasons_checked_at,
             past_seasons_count
      FROM competition.entries
      WHERE season_id = ${season.seasonId}
      ORDER BY entry_id
    `;
    if (entries.length === 0) {
      throw new MyFplSnapshotIncompleteError('No current-season entries are available');
    }
    const entrySourceById = new Map(entries.map((entry) => [entry.entry_id, entry] as const));
    const entryEligibility = countEntryEligibility(
      entries.map((entry) => ({ startedEvent: entry.started_event, eventId })),
    );
    const expectedEntryCount = entryEligibility.eligibleCount;
    const notApplicableEntryCount = entryEligibility.notApplicableCount;

    // Provisional scores never read the current event result. Final scores read
    // the current event only after the final fence has passed.
    const resultUpperBound = kind === 'FINAL' ? eventId : Math.max(0, eventId - 1);

    const resultRows = await tx<EventResult[]>`
      SELECT result.source_result_id, result.updated_at, result.event_id, result.entry_id,
             result.event_points, result.event_rank, result.overall_points,
             result.overall_rank, result.event_transfers, result.event_transfers_cost,
             result.event_net_points, result.event_bench_points, result.event_auto_sub_points,
             result.event_chip::text, result.played_captain_element_id, result.captain_points,
             result.event_picks,
             result.automatic_substitutions, result.team_value, result.bank, result.rich_synced_at,
             NULL::text AS input_revision, NULL::text AS score_revision
      FROM competition.entry_event_results result
      JOIN fpl.events result_event
        ON result_event.season_id = result.season_id
       AND result_event.event_id = result.event_id
      WHERE result.season_id = ${season.seasonId}
        AND result.event_id <= ${resultUpperBound}
        AND result_event.finished = true
        AND result_event.data_checked = true
      ORDER BY result.entry_id, result.event_id
    `;
    const currentResults = new Map(
      resultRows
        .filter((row) => row.event_id === eventId && row.rich_synced_at !== null)
        .map((row) => [row.entry_id, row]),
    );
    const isIncludedReviewResult = (row: {
      entry_id: number;
      event_id?: number;
      eventId?: number;
    }): boolean => {
      const entry = entrySourceById.get(row.entry_id);
      const rowEventId = row.event_id ?? row.eventId;
      return Boolean(
        entry &&
          rowEventId !== undefined &&
          isEntryEligibleForEvent({
            startedEvent: entry.started_event,
            eventId: rowEventId,
          }),
      );
    };
    const resultsByEntry = groupBy(
      resultRows.filter(isIncludedReviewResult),
      (row) => row.entry_id,
    );
    if (kind === 'FINAL') {
      const finalFreshAfter = event.data_checked_at
        ? new Date(event.data_checked_at).getTime()
        : Number.NaN;
      for (const entry of entries) {
        if (!isEntryEligibleForEvent({ startedEvent: entry.started_event, eventId })) continue;
        const current = currentResults.get(entry.entry_id);
        if (!current) continue;
        if (
          !Number.isFinite(finalFreshAfter) ||
          current.rich_synced_at === null ||
          new Date(current.rich_synced_at).getTime() < finalFreshAfter
        ) {
          throw new MyFplSnapshotIncompleteError(
            `Entry ${entry.entry_id} final result is older than data_checked_at for event ${eventId}`,
          );
        }
        const firstScoringEvent = Math.max(1, entry.started_event ?? 1);
        const previous = resultRows
          .filter(
            (row) =>
              row.entry_id === entry.entry_id &&
              row.event_id >= firstScoringEvent &&
              row.event_id < eventId,
          )
          .at(-1);
        const previousTotal = previous?.overall_points ?? 0;
        const reconciles = current.overall_points === previousTotal + current.event_net_points;
        const acceptsUnrankedFirstEvent = isAuthoritativeUnrankedFirstEventResult({
          firstScoringEvent,
          eventId,
          hasPreviousResult: previous !== undefined,
          overallPoints: current.overall_points,
          overallRank: current.overall_rank,
        });
        if (!reconciles && !acceptsUnrankedFirstEvent) {
          throw new MyFplSnapshotIncompleteError(
            `Entry ${entry.entry_id} final total does not reconcile for event ${eventId}`,
          );
        }
        if (acceptsUnrankedFirstEvent && !reconciles) {
          logWarn('Accepted authoritative unranked first-event cumulative total', {
            season: season.seasonCode,
            eventId,
          });
        }
        if (current.event_net_points !== current.event_points - current.event_transfers_cost) {
          throw new MyFplSnapshotIncompleteError(
            `Entry ${entry.entry_id} final net points do not reconcile for event ${eventId}`,
          );
        }
      }
    }
    const finalizedHistoryEvents = await tx<{ event_id: number }[]>`
      SELECT event_id
      FROM fpl.events
      WHERE season_id = ${season.seasonId}
        AND event_id <= ${resultUpperBound}
        AND finished = true
        AND data_checked = true
      ORDER BY event_id
    `;
    const historyRows = await tx<(HistoryRow & { entry_id: number })[]>`
      SELECT result.entry_id,
             result.event_id AS "eventId",
             result.event_points AS "eventPoints",
             result.event_rank AS "eventRank",
             result.overall_points AS "overallPoints",
             result.overall_rank AS "overallRank",
             result.event_transfers AS "eventTransfers",
             result.event_transfers_cost AS "eventTransfersCost",
             result.event_net_points AS "eventNetPoints",
             result.event_bench_points AS "eventBenchPoints",
             result.event_auto_sub_points AS "eventAutoSubPoints",
             result.event_chip::text AS "eventChip",
             result.captain_points AS "eventCaptainPoints",
             player.web_name AS "captainWebName",
             team.short_name AS "captainTeamShortName",
             result.team_value AS "teamValue",
             result.bank
      FROM competition.entry_event_results result
      JOIN fpl.events result_event
        ON result_event.season_id = result.season_id
       AND result_event.event_id = result.event_id
      LEFT JOIN fpl.players player
        ON player.season_id = result.season_id
       AND player.element_id = result.played_captain_element_id
      LEFT JOIN LATERAL (
        SELECT fixture_stats.team_id
        FROM fpl.player_fixture_stats fixture_stats
        WHERE fixture_stats.season_id = result.season_id
          AND fixture_stats.event_id = result.event_id
          AND fixture_stats.element_id = result.played_captain_element_id
        ORDER BY fixture_stats.fixture_id
        LIMIT 1
      ) historical_captain_team ON TRUE
      LEFT JOIN fpl.teams team
        ON team.season_id = player.season_id
       AND team.team_id = COALESCE(historical_captain_team.team_id, player.team_id)
      WHERE result.season_id = ${season.seasonId}
        AND result.event_id <= ${resultUpperBound}
        AND result.rich_synced_at IS NOT NULL
        AND result_event.finished = true
        AND result_event.data_checked = true
      ORDER BY result.entry_id, result.event_id
    `;
    const mappedHistory = groupBy(
      historyRows.filter(isIncludedReviewResult),
      (row) => row.entry_id,
    );

    const pickRows = await tx<PickRow[]>`
      SELECT pick.entry_id, pick.event_id, pick.element_id AS element, pick.position,
             player.web_name, team.short_name AS team_short_name,
             team.name AS team_name, player.element_type,
             COALESCE(historical_team.team_id, pick.event_team_id) AS team_id,
             pick.is_captain, pick.is_vice_captain, pick.active_chip::text,
             pick.transfers, pick.transfers_cost, pick.multiplier, pick.source_updated_at,
             stats.total_points, stats.minutes, stats.goals_scored,
             stats.assists, stats.clean_sheets, stats.goals_conceded,
             stats.yellow_cards, stats.red_cards, stats.saves, stats.penalties_saved,
             stats.bonus,
             stats.bps, stats.expected_goals, stats.expected_assists,
             stats.expected_goal_involvements, stats.expected_goals_conceded,
             fixture.against_short_name, fixture.was_home, fixture.score,
             fixture.fixture_count
      FROM competition.entry_event_picks pick
      JOIN fpl.players player
        ON player.season_id = pick.season_id AND player.element_id = pick.element_id
      LEFT JOIN LATERAL (
        SELECT min(fixture_stats.team_id) AS team_id
        FROM fpl.player_fixture_stats fixture_stats
        WHERE fixture_stats.season_id = pick.season_id
          AND fixture_stats.event_id = pick.event_id
          AND fixture_stats.element_id = pick.element_id
        HAVING count(DISTINCT fixture_stats.team_id) = 1
      ) historical_team ON TRUE
      LEFT JOIN fpl.teams team
        ON team.season_id = player.season_id
       AND team.team_id = COALESCE(historical_team.team_id, pick.event_team_id)
      LEFT JOIN fpl.player_gameweek_stats stats
        ON stats.season_id = pick.season_id
       AND stats.event_id = pick.event_id
       AND stats.element_id = pick.element_id
      LEFT JOIN LATERAL (
        SELECT count(DISTINCT fixture.fixture_id)::integer AS fixture_count,
               string_agg(opponent.short_name, ' / ' ORDER BY fixture.kickoff_time NULLS LAST, fixture.fixture_id) AS against_short_name,
               string_agg(CASE WHEN fixture.team_h_id = fixture_stats.team_id THEN 'H' ELSE 'A' END, ' / ' ORDER BY fixture.kickoff_time NULLS LAST, fixture.fixture_id) AS was_home,
               string_agg(CASE
                 WHEN fixture.team_h_score IS NULL OR fixture.team_a_score IS NULL THEN ''
                 WHEN fixture.team_h_id = fixture_stats.team_id THEN fixture.team_h_score || '-' || fixture.team_a_score
                 ELSE fixture.team_a_score || '-' || fixture.team_h_score
               END, ' / ' ORDER BY fixture.kickoff_time NULLS LAST, fixture.fixture_id) AS score
        FROM fpl.fixtures fixture
        JOIN fpl.player_fixture_stats fixture_stats
          ON fixture_stats.season_id = fixture.season_id
         AND fixture_stats.fixture_id = fixture.fixture_id
         AND fixture_stats.element_id = pick.element_id
        LEFT JOIN fpl.teams opponent
          ON opponent.season_id = fixture.season_id
         AND opponent.team_id = CASE
           WHEN fixture.team_h_id = fixture_stats.team_id THEN fixture.team_a_id
           ELSE fixture.team_h_id END
        WHERE fixture.season_id = pick.season_id
          AND fixture.event_id = pick.event_id
          AND fixture_stats.team_id = COALESCE(historical_team.team_id, pick.event_team_id)
      ) fixture ON TRUE
      WHERE pick.season_id = ${season.seasonId} AND pick.event_id = ${eventId}
      ORDER BY pick.entry_id, pick.position
    `;
    const picksByEntry = groupBy(pickRows, (row) => row.entry_id);

    const historicalReviewPickRows = await tx<PickRow[]>`
      SELECT pick.entry_id, pick.event_id, pick.element_id AS element, pick.position,
             player.web_name, team.short_name AS team_short_name,
             team.name AS team_name, player.element_type,
             pick.event_team_id AS team_id,
             pick.is_captain, pick.is_vice_captain, pick.active_chip::text,
             pick.transfers, pick.transfers_cost, pick.multiplier, pick.source_updated_at,
             stats.total_points, stats.minutes, stats.goals_scored,
             stats.assists, stats.clean_sheets, stats.goals_conceded,
             stats.yellow_cards, stats.red_cards, stats.saves, stats.penalties_saved,
             stats.bonus,
             stats.bps, stats.expected_goals, stats.expected_assists,
             stats.expected_goal_involvements, stats.expected_goals_conceded,
             NULL::text AS against_short_name, NULL::text AS was_home,
             NULL::text AS score, 0::integer AS fixture_count
      FROM competition.entry_event_picks pick
      JOIN fpl.events event
        ON event.season_id = pick.season_id
       AND event.event_id = pick.event_id
       AND event.finished = true
       AND event.data_checked = true
      JOIN fpl.players player
        ON player.season_id = pick.season_id AND player.element_id = pick.element_id
      LEFT JOIN fpl.teams team
        ON team.season_id = pick.season_id
       AND team.team_id = pick.event_team_id
      JOIN fpl.player_gameweek_stats stats
        ON stats.season_id = pick.season_id
       AND stats.event_id = pick.event_id
       AND stats.element_id = pick.element_id
      WHERE pick.season_id = ${season.seasonId}
        AND pick.event_id < ${eventId}
      ORDER BY pick.entry_id, pick.event_id, pick.position
    `;
    const historicalReviewPicksByEntryEvent = new Map<string, PickRow[]>();
    for (const pick of historicalReviewPickRows) {
      const key = `${pick.entry_id}:${pick.event_id}`;
      const rows = historicalReviewPicksByEntryEvent.get(key) ?? [];
      rows.push(pick);
      historicalReviewPicksByEntryEvent.set(key, rows);
    }

    if (kind === 'FINAL') {
      for (const current of currentResults.values()) {
        const finalPicks = overlayFinalResultPicks(
          current,
          picksByEntry.get(current.entry_id) ?? [],
        );
        if (!finalPicks) {
          throw new MyFplSnapshotIncompleteError(
            `Entry ${current.entry_id} final result picks are incomplete or changed for event ${eventId}`,
          );
        }
        picksByEntry.set(current.entry_id, finalPicks);
      }
    }

    for (const historicalResult of resultRows) {
      if (historicalResult.event_id >= eventId) continue;
      const historicalEntry = entrySourceById.get(historicalResult.entry_id);
      if (
        !historicalEntry ||
        !isEntryEligibleForEvent({
          startedEvent: historicalEntry.started_event,
          eventId: historicalResult.event_id,
        })
      ) {
        // Backfilled result rows can legitimately predate a late entrant's
        // first scoring event. They must not become review timeline inputs.
        continue;
      }
      const key = `${historicalResult.entry_id}:${historicalResult.event_id}`;
      const historicalPicks = historicalReviewPicksByEntryEvent.get(key) ?? [];
      const finalPicks = overlayFinalResultPicks(historicalResult, historicalPicks);
      if (!finalPicks) {
        throw new MyFplSnapshotIncompleteError(
          `Entry ${historicalResult.entry_id} review picks are incomplete for event ${historicalResult.event_id}`,
        );
      }
      historicalReviewPicksByEntryEvent.set(key, finalPicks);
    }

    if (kind === 'FINAL' && event.data_checked_at) {
      for (const current of currentResults.values()) {
        const revisions = finalResultRevisions(
          current,
          picksByEntry.get(current.entry_id) ?? [],
          event.data_checked_at,
        );
        current.input_revision = revisions.inputRevision;
        current.score_revision = revisions.scoreRevision;
      }
    }

    if (kind === 'FINAL') {
      for (const [entryId, current] of currentResults) {
        const entryPicks = picksByEntry.get(entryId) ?? [];
        if (entryPicks.length !== 15) continue;
        const detailPoints = entryPicks.reduce(
          (sum, pick) => sum + integerValue(pick.total_points) * pick.multiplier,
          0,
        );
        const managerChip = chip(current.event_chip) === 'MANAGER';
        const managerPoints = managerChip ? current.event_points - detailPoints : 0;
        if (
          !Number.isSafeInteger(managerPoints) ||
          managerPoints < 0 ||
          detailPoints + managerPoints !== current.event_points
        ) {
          throw new MyFplSnapshotIncompleteError(
            `Entry ${entryId} final headline/detail mismatch for event ${eventId}`,
          );
        }
      }
    }

    // The provisional path is one revision-pinned event-live batch. It never
    // reads the current event's entry_event_results. FINAL uses only the
    // finalized result path and never invokes the projector.
    const projectedScoresByEntry = new Map<number, ProjectedManagerScore>();
    const provisionalEventPointsByElement = new Map<number, number>();
    let projectedBatch: Awaited<ReturnType<typeof eventLiveV2ScoreService.load>> = null;
    if (kind === 'PROVISIONAL') {
      const activeEntryIds = entries
        .filter((entry) => isEntryEligibleForEvent({ startedEvent: entry.started_event, eventId }))
        .map((entry) => entry.entry_id);
      projectedBatch = await eventLiveV2ScoreService.load(season, eventId, activeEntryIds, {
        includeEffectiveLineup: true,
        preloadedInputs: {
          pickRows: pickRows.map(
            (row): EventLiveManagerPickRow => ({
              entryId: row.entry_id,
              position: row.position,
              elementId: row.element,
              multiplier: row.multiplier,
              isCaptain: row.is_captain,
              isViceCaptain: row.is_vice_captain,
              transfers: row.transfers,
              transfersCost: row.transfers_cost,
              sourceUpdatedAt:
                row.source_updated_at instanceof Date
                  ? row.source_updated_at
                  : new Date(row.source_updated_at),
              elementType: row.element_type,
              teamId: row.team_id,
              activeChip: row.active_chip,
            }),
          ),
          entryInfos: entries.map((entry) => ({
            id: entry.entry_id,
            startedEvent: entry.started_event,
          })),
          previousResultEvidence: resultRows.map((row) => ({
            entryId: row.entry_id,
            eventId: row.event_id,
            sourceResultId: row.source_result_id,
            eventNetPoints: row.event_net_points,
            richSyncedAt: row.rich_synced_at ? new Date(row.rich_synced_at) : null,
            updatedAt: new Date(row.updated_at),
          })),
        },
      });
      if (!projectedBatch) {
        throw new MyFplSnapshotIncompleteError(
          `Event-live projected score publication is unavailable for event ${eventId}`,
        );
      }
      const pinnedLiveSnapshot = await loadFreshEventLiveAuthoritySnapshot(season, eventId, {
        publicationId: projectedBatch.publicationId,
        generation: projectedBatch.generation,
      });
      if (!pinnedLiveSnapshot) {
        throw new MyFplSnapshotIncompleteError(
          `Event-live publication changed during capture for event ${eventId}`,
        );
      }
      for (const live of pinnedLiveSnapshot.eventLives) {
        provisionalEventPointsByElement.set(live.elementId, live.totalPoints);
      }
      overlayProjectedEventLiveStats(eventId, pickRows, pinnedLiveSnapshot.eventLives);
      const pinnedTeamIds = Array.from(
        new Set(pinnedLiveSnapshot.fixtures.flatMap((fixture) => [fixture.teamH, fixture.teamA])),
      );
      const pinnedTeamRows = await tx<{ team_id: number; short_name: string }[]>`
        SELECT team_id, short_name
        FROM fpl.teams
        WHERE season_id = ${season.seasonId}
          AND team_id = ANY(${pinnedTeamIds}::int[])
      `;
      const pinnedTeamShortNames = new Map(
        pinnedTeamRows.map((team) => [team.team_id, team.short_name] as const),
      );
      overlayPinnedEventFixtures(
        eventId,
        pickRows,
        pinnedLiveSnapshot.fixtures,
        pinnedTeamShortNames,
      );
      const startedEventByEntry = new Map(
        entries.map((entry) => [entry.entry_id, entry.started_event] as const),
      );
      for (const entryId of activeEntryIds) {
        const score = projectedBatch.scores.get(entryId);
        const entryPicks = picksByEntry.get(entryId) ?? [];
        if (
          !score ||
          score.totalPoints === null ||
          !score.effectiveLineup ||
          score.effectiveLineup.length !== 15 ||
          entryPicks.length !== 15
        ) {
          throw new MyFplSnapshotIncompleteError(
            `Entry ${entryId} has no complete projected score for event ${eventId}`,
          );
        }
        if (
          !projectedScoreUsesCaptureInputs(
            eventId,
            entryId,
            startedEventByEntry.get(entryId) ?? null,
            score,
            entryPicks,
            resultRows,
            `live-points-v2:${projectedBatch.publicationId}:${projectedBatch.generation}:${projectedBatch.scoreCoreRevision}`,
          )
        ) {
          throw new MyFplSnapshotIncompleteError(
            `Entry ${entryId} projected score input revision changed during capture`,
          );
        }
        if (score.netEventPoints !== score.eventPoints - score.transferCost) {
          throw new MyFplSnapshotIncompleteError(
            `Entry ${entryId} projected net points do not reconcile for event ${eventId}`,
          );
        }
        const finalizedPreviousTotal =
          eventId === 1
            ? 0
            : resultRows
                .filter(
                  (row) =>
                    row.entry_id === entryId &&
                    row.event_id >= Math.max(1, startedEventByEntry.get(entryId) ?? 1) &&
                    row.event_id < eventId,
                )
                .reduce((sum, row) => sum + (row.event_net_points ?? 0), 0);
        if (score.totalPoints !== finalizedPreviousTotal + score.netEventPoints) {
          throw new MyFplSnapshotIncompleteError(
            `Entry ${entryId} projected total does not reconcile for event ${eventId}`,
          );
        }
        const effectiveByElement = new Map(
          score.effectiveLineup.map((row) => [row.elementId, row] as const),
        );
        const detailPoints = entryPicks.reduce(
          (sum, pick) =>
            sum +
            integerValue(pick.total_points) *
              (effectiveByElement.get(pick.element)?.effectiveMultiplier ?? 0),
          0,
        );
        const managerChip =
          chip(entryPicks.find((pick) => pick.position === 1)?.active_chip ?? null) === 'MANAGER';
        const managerPoints = managerChip ? score.eventPoints - detailPoints : 0;
        if (
          !Number.isSafeInteger(managerPoints) ||
          managerPoints < 0 ||
          detailPoints + managerPoints !== score.eventPoints
        ) {
          throw new MyFplSnapshotIncompleteError(
            `Entry ${entryId} projected headline/detail mismatch for event ${eventId}`,
          );
        }
        projectedScoresByEntry.set(entryId, score);
      }
    }

    const transferRows = await tx<TransferRow[]>`
      SELECT transfer.entry_id, transfer.event_id,
             COALESCE(result.event_transfers, 0)::integer AS event_transfers,
             COALESCE(result.event_transfers_cost, 0)::integer AS event_transfers_cost,
             result.event_chip::text AS event_chip,
             transfer.element_in_id,
             player_in.web_name AS element_in_web_name,
             player_in.element_type AS element_in_type,
             team_in.short_name AS element_in_team_short_name,
             transfer.element_in_cost, transfer.element_in_points,
             transfer.element_in_played,
             transfer.element_out_id,
             player_out.web_name AS element_out_web_name,
             player_out.element_type AS element_out_type,
             team_out.short_name AS element_out_team_short_name,
             transfer.element_out_cost, transfer.element_out_points,
             NULL::integer AS same_gameweek_gain,
             NULL::integer AS three_gameweek_gain,
             NULL::integer AS five_gameweek_gain,
             NULL::integer AS evaluated_through_event_id,
             transfer.transfer_time
      FROM competition.entry_event_transfers transfer
      LEFT JOIN fpl.players player_in
        ON player_in.season_id = transfer.season_id
       AND player_in.element_id = transfer.element_in_id
      LEFT JOIN LATERAL (
        SELECT fixture_stats.team_id
        FROM fpl.player_fixture_stats fixture_stats
        WHERE fixture_stats.season_id = transfer.season_id
          AND fixture_stats.event_id = transfer.event_id
          AND fixture_stats.element_id = transfer.element_in_id
        ORDER BY fixture_stats.fixture_id
        LIMIT 1
      ) historical_in_team ON TRUE
      LEFT JOIN fpl.teams team_in
        ON team_in.season_id = player_in.season_id
       AND team_in.team_id = COALESCE(historical_in_team.team_id, player_in.team_id)
      LEFT JOIN fpl.players player_out
        ON player_out.season_id = transfer.season_id
       AND player_out.element_id = transfer.element_out_id
      LEFT JOIN LATERAL (
        SELECT fixture_stats.team_id
        FROM fpl.player_fixture_stats fixture_stats
        WHERE fixture_stats.season_id = transfer.season_id
          AND fixture_stats.event_id = transfer.event_id
          AND fixture_stats.element_id = transfer.element_out_id
        ORDER BY fixture_stats.fixture_id
        LIMIT 1
      ) historical_out_team ON TRUE
      LEFT JOIN fpl.teams team_out
        ON team_out.season_id = player_out.season_id
       AND team_out.team_id = COALESCE(historical_out_team.team_id, player_out.team_id)
      LEFT JOIN competition.entry_event_results result
        ON result.season_id = transfer.season_id
       AND result.entry_id = transfer.entry_id
       AND result.event_id = transfer.event_id
       AND result.event_id <= ${resultUpperBound}
       AND EXISTS (
         SELECT 1
         FROM fpl.events result_event
         WHERE result_event.season_id = result.season_id
           AND result_event.event_id = result.event_id
           AND result_event.finished = true
           AND result_event.data_checked = true
       )
      WHERE transfer.season_id = ${season.seasonId}
        AND transfer.event_id <= ${eventId}
      ORDER BY transfer.entry_id, transfer.event_id, transfer.transfer_time, transfer.transfer_id
    `;
    if (kind === 'PROVISIONAL') {
      for (const row of transferRows) {
        if (row.event_id !== eventId) continue;
        const score = projectedScoresByEntry.get(row.entry_id);
        if (!score) continue;
        const captainPick = pickRows.find(
          (pick) => pick.entry_id === row.entry_id && pick.position === 1,
        );
        row.event_chip = captainPick?.active_chip ?? row.event_chip;
        row.event_transfers = captainPick?.transfers ?? row.event_transfers;
        row.event_transfers_cost = score.transferCost;
      }
    }
    const transferElementIds = Array.from(
      new Set(
        transferRows.flatMap((row) =>
          [row.element_in_id, row.element_out_id].filter(
            (element): element is number => element !== null,
          ),
        ),
      ),
    );
    const transferPointRows =
      transferElementIds.length === 0 || resultUpperBound === 0
        ? []
        : await tx<{ element_id: number; event_id: number; total_points: number }[]>`
            SELECT stats.element_id, stats.event_id, stats.total_points
            FROM fpl.player_gameweek_stats stats
            JOIN fpl.events event
              ON event.season_id = stats.season_id
             AND event.event_id = stats.event_id
             AND event.finished = true
             AND event.data_checked = true
            WHERE stats.season_id = ${season.seasonId}
              AND stats.event_id <= ${resultUpperBound}
              AND stats.element_id = ANY(${transferElementIds}::int[])
            ORDER BY stats.element_id, stats.event_id
          `;
    const transferPointsByElementEvent = new Map(
      transferPointRows.map((row) => [`${row.element_id}:${row.event_id}`, row.total_points]),
    );
    const transferPointFor = (elementId: number, targetEventId: number): number | null => {
      if (kind === 'PROVISIONAL' && targetEventId === eventId) {
        return provisionalEventPointsByElement.get(elementId) ?? null;
      }
      const points = transferPointsByElementEvent.get(`${elementId}:${targetEventId}`);
      return points === undefined ? null : points;
    };
    const transferWindowGain = (row: TransferRow, gameweeks: number): number | null => {
      if (
        row.element_in_id === null ||
        row.element_out_id === null ||
        row.event_id + gameweeks - 1 > resultUpperBound
      ) {
        return null;
      }
      // Free Hit players are reverted after the event.  A multi-week
      // counterfactual treats the incoming player as permanently owned and
      // would therefore report a gain that never belonged to this transfer.
      if (gameweeks > 1 && chip(row.event_chip) === 'FREE_HIT') return null;
      let gain = 0;
      for (let offset = 0; offset < gameweeks; offset += 1) {
        const reviewEventId = row.event_id + offset;
        const incomingPoints = transferPointFor(row.element_in_id, reviewEventId);
        const outgoingPoints = transferPointFor(row.element_out_id, reviewEventId);
        if (incomingPoints === null || outgoingPoints === null) {
          throw new MyFplSnapshotIncompleteError(
            `Transfer point window is incomplete for entry ${row.entry_id}, event ${row.event_id}, horizon ${gameweeks}`,
          );
        }
        gain += incomingPoints - outgoingPoints;
      }
      return gain;
    };
    for (const row of transferRows) {
      const isCurrentProvisionalTransfer = kind === 'PROVISIONAL' && row.event_id === eventId;
      if (row.event_id > resultUpperBound && !isCurrentProvisionalTransfer) continue;
      row.element_in_points =
        row.element_in_id === null ? null : transferPointFor(row.element_in_id, row.event_id);
      row.element_out_points =
        row.element_out_id === null ? null : transferPointFor(row.element_out_id, row.event_id);
      if (
        isCurrentProvisionalTransfer &&
        ((row.element_in_id !== null && row.element_in_points === null) ||
          (row.element_out_id !== null && row.element_out_points === null))
      ) {
        throw new MyFplSnapshotIncompleteError(
          `Event-live publication is missing transfer points for entry ${row.entry_id}, event ${eventId}`,
        );
      }
      if (
        row.element_in_id !== null &&
        row.element_out_id !== null &&
        (row.element_in_points === null || row.element_out_points === null)
      ) {
        throw new MyFplSnapshotIncompleteError(
          `Transfer point observation is incomplete for entry ${row.entry_id}, event ${row.event_id}`,
        );
      }
      row.same_gameweek_gain =
        row.element_in_points === null || row.element_out_points === null
          ? null
          : row.element_in_points - row.element_out_points;
      row.three_gameweek_gain = transferWindowGain(row, 3);
      row.five_gameweek_gain = transferWindowGain(row, 5);
      const evaluationUpperBound = isCurrentProvisionalTransfer ? eventId : resultUpperBound;
      row.evaluated_through_event_id = Math.min(evaluationUpperBound, row.event_id + 4);
    }
    const transfersByEntry = groupBy(transferRows, (row) => row.entry_id);

    const pastSeasonRows = await tx<
      {
        entry_id: number;
        source_season_label: string;
        total_points: number;
        overall_rank: number;
      }[]
    >`
      SELECT entry_id, source_season_label, total_points, overall_rank
      FROM competition.entry_past_seasons
      WHERE entry_season_id = ${season.seasonId}
      ORDER BY entry_id, source_season_id
    `;
    const pastSeasonsByEntry = groupBy(pastSeasonRows, (row) => row.entry_id);

    const payloadEntries: Array<{
      season_id: number;
      event_id: number;
      revision: number;
      entry_id: number;
      picks_count: number;
      is_empty: boolean;
      payload: JsonRecord;
    }> = [];
    const readyEntryIds = new Set<number>();
    const scoreRevisionsByEntry = new Map<
      number,
      { inputRevision: string; scoreRevision: string } | null
    >();
    const emptyEntryCount = 0;
    for (const entry of entries) {
      const entryPicks = picksByEntry.get(entry.entry_id) ?? [];
      const isEmpty = !isEntryEligibleForEvent({
        startedEvent: entry.started_event,
        eventId,
      });
      const projectedScore = projectedScoresByEntry.get(entry.entry_id);
      const currentResult =
        kind === 'PROVISIONAL'
          ? !isEmpty && projectedScore
            ? projectedResult(entry, eventId, projectedScore, entryPicks)
            : undefined
          : currentResults.get(entry.entry_id);
      const uniquePickElements = new Set(entryPicks.map((pick) => pick.element));
      const uniquePickPositions = new Set(entryPicks.map((pick) => pick.position));
      const pastSeasons = pastSeasonsByEntry.get(entry.entry_id) ?? [];
      const pastSeasonsReady =
        entry.past_seasons_checked_at !== null &&
        entry.past_seasons_count !== null &&
        entry.past_seasons_count === pastSeasons.length;
      if (!pastSeasonsReady) {
        throw new MyFplSnapshotIncompleteError(
          `Entry ${entry.entry_id} past-season checkpoint is incomplete`,
        );
      }
      const history = mappedHistory.get(entry.entry_id) ?? [];
      const firstExpectedEvent = Math.max(1, entry.started_event ?? 1);
      const missingHistoryEvents = finalizedHistoryEvents
        .map((row) => row.event_id)
        .filter((historyEventId) => historyEventId >= firstExpectedEvent)
        .filter((historyEventId) => !history.some((row) => row.eventId === historyEventId));
      if (missingHistoryEvents.length > 0 && !isEmpty) {
        throw new MyFplSnapshotIncompleteError(
          `Entry ${entry.entry_id} history is missing finalized events ${missingHistoryEvents.join(',')}`,
        );
      }
      const complete =
        Boolean(currentResult) &&
        typeof currentResult?.input_revision === 'string' &&
        currentResult.input_revision.length > 0 &&
        typeof currentResult.score_revision === 'string' &&
        currentResult.score_revision.length > 0 &&
        entryPicks.length === 15 &&
        uniquePickElements.size === 15 &&
        uniquePickPositions.size === 15 &&
        entryPicks.every((pick) => pick.total_points !== null && pick.fixture_count !== null) &&
        (entry.transfers_synced_through_event_id ?? 0) >= eventId;
      if (isEmpty && entryPicks.length !== 0) {
        throw new MyFplSnapshotIncompleteError(
          `Entry ${entry.entry_id} is marked EMPTY but has ${entryPicks.length} picks`,
        );
      }
      if (!isEmpty && !complete) {
        throw new MyFplSnapshotIncompleteError(
          `Entry ${entry.entry_id} is incomplete for event ${eventId}: picks=${entryPicks.length}, result=${Boolean(currentResult)}, transferCheckpoint=${entry.transfers_synced_through_event_id ?? 'missing'}`,
        );
      }
      if (!isEmpty) readyEntryIds.add(entry.entry_id);
      scoreRevisionsByEntry.set(
        entry.entry_id,
        currentResult?.input_revision && currentResult.score_revision
          ? {
              inputRevision: currentResult.input_revision,
              scoreRevision: currentResult.score_revision,
            }
          : null,
      );
      const autoSubs = automaticSubElements(currentResult?.automatic_substitutions);
      const effectiveLineup = projectedScore?.effectiveLineup
        ? new Map(projectedScore.effectiveLineup.map((row) => [row.elementId, row] as const))
        : undefined;
      const picks = entryPicks.map((row) => mapPick(row, autoSubs, effectiveLineup));
      const reviewGameweeksByEvent = new Map<number, MyFplManagerReviewGameweekInput>();
      for (const reviewResult of resultsByEntry.get(entry.entry_id) ?? []) {
        if (reviewResult.event_id >= eventId) continue;
        const reviewPickRows =
          historicalReviewPicksByEntryEvent.get(`${entry.entry_id}:${reviewResult.event_id}`) ?? [];
        const reviewAutoSubs = automaticSubElements(reviewResult.automatic_substitutions);
        const reviewPicks = reviewPickRows.map((row) => mapPick(row, reviewAutoSubs));
        reviewGameweeksByEvent.set(
          reviewResult.event_id,
          managerReviewGameweekInput(reviewResult, reviewPicks, 'FINAL'),
        );
      }
      if (currentResult) {
        reviewGameweeksByEvent.set(eventId, managerReviewGameweekInput(currentResult, picks, kind));
      }
      const reviewGameweeks = [...reviewGameweeksByEvent.values()].sort(
        (left, right) => left.eventId - right.eventId,
      );
      if (
        !isEmpty &&
        reviewGameweeks.length !== history.length + (kind === 'PROVISIONAL' ? 1 : 0)
      ) {
        throw new MyFplSnapshotIncompleteError(
          `Entry ${entry.entry_id} review timeline does not reconcile through event ${eventId}`,
        );
      }
      const managerReview = buildMyFplManagerReview(eventId, reviewGameweeks);
      const gameweek = isEmpty
        ? { state: 'EMPTY', eventId, result: null }
        : {
            state: 'READY',
            eventId,
            result: resultPayload(currentResult!, picks),
          };
      payloadEntries.push({
        season_id: season.seasonId,
        event_id: eventId,
        revision: 0,
        entry_id: entry.entry_id,
        picks_count: picks.length,
        is_empty: isEmpty,
        payload: {
          contractVersion: 2,
          entry: mapIdentity(entry),
          pastSeasons: pastSeasons.map((row) => ({
            season: row.source_season_label,
            totalPoints: row.total_points,
            overallRank: row.overall_rank,
          })),
          gameweek,
          review: {
            ...managerReview,
            transfers: (transfersByEntry.get(entry.entry_id) ?? []).map(mapTransfer),
          },
        },
      });
    }

    const configuredTournaments = await tx<{ tournament_id: number; total_team_num: number }[]>`
      SELECT tournament_id, total_team_num
      FROM competition.tournaments
      WHERE season_id = ${season.seasonId}
      ORDER BY tournament_id
    `;
    const tournamentMembership = await tx<{ tournament_id: number; entry_id: number }[]>`
      SELECT tournament_id, entry_id
      FROM competition.tournament_entries
      WHERE season_id = ${season.seasonId}
      ORDER BY tournament_id, entry_id
    `;
    const tournamentIds = configuredTournaments.map((row) => row.tournament_id);
    const membershipCounts = new Map<number, number>();
    for (const membership of tournamentMembership) {
      membershipCounts.set(
        membership.tournament_id,
        (membershipCounts.get(membership.tournament_id) ?? 0) + 1,
      );
    }
    for (const tournament of configuredTournaments) {
      const membershipCount = membershipCounts.get(tournament.tournament_id) ?? 0;
      if (membershipCount !== tournament.total_team_num) {
        throw new MyFplSnapshotIncompleteError(
          `Tournament ${tournament.tournament_id} roster is incomplete: expected ${tournament.total_team_num}, got ${membershipCount}`,
        );
      }
    }
    const tournamentRows = await tx<TournamentRow[]>`
      WITH current_rows AS (
        SELECT roster.tournament_id, roster.entry_id,
               result.event_points, result.event_transfers_cost AS event_cost,
               result.event_net_points, result.event_rank, result.overall_points,
               result.overall_rank, result.event_chip::text,
               result.played_captain_element_id AS captain_id,
               group_result.event_group_rank AS current_group_rank,
               captain.web_name AS captain_web_name,
               captain_team.short_name AS captain_team_short_name,
               result.captain_points, result.team_value, result.bank,
               group_result.group_id,
               NULL::text AS input_revision,
               NULL::text AS score_revision
        FROM competition.tournament_entries roster
		LEFT JOIN competition.entry_event_results result
		  ON result.season_id = roster.season_id
		 AND result.entry_id = roster.entry_id
		 AND result.event_id = ${eventId}
         AND ${kind === 'FINAL'}
		 AND result.rich_synced_at IS NOT NULL
        LEFT JOIN fpl.players captain
          ON captain.season_id = roster.season_id
         AND captain.element_id = result.played_captain_element_id
        LEFT JOIN fpl.teams captain_team
          ON captain_team.season_id = captain.season_id
         AND captain_team.team_id = captain.team_id
        LEFT JOIN competition.tournament_points_group_results group_result
          ON group_result.season_id = roster.season_id
         AND group_result.tournament_id = roster.tournament_id
         AND group_result.event_id = ${eventId}
         AND group_result.entry_id = roster.entry_id
        WHERE roster.season_id = ${season.seasonId}
      )
      SELECT current_rows.*, entry.entry_name, entry.player_name,
             previous.event_net_points AS previous_event_net_points,
             previous_group.event_group_rank AS previous_group_rank
      FROM current_rows
      JOIN competition.entries entry
        ON entry.season_id = ${season.seasonId} AND entry.entry_id = current_rows.entry_id
      LEFT JOIN competition.entry_event_results previous
        ON previous.season_id = ${season.seasonId}
       AND previous.entry_id = current_rows.entry_id
       AND previous.event_id = ${Math.max(1, eventId - 1)}
       AND previous.rich_synced_at IS NOT NULL
       AND EXISTS (
         SELECT 1
         FROM fpl.events previous_event
         WHERE previous_event.season_id = previous.season_id
           AND previous_event.event_id = previous.event_id
           AND previous_event.finished = true
           AND previous_event.data_checked = true
       )
      LEFT JOIN competition.tournament_points_group_results previous_group
        ON previous_group.season_id = ${season.seasonId}
       AND previous_group.tournament_id = current_rows.tournament_id
       AND previous_group.event_id = ${Math.max(1, eventId - 1)}
       AND previous_group.entry_id = current_rows.entry_id
       AND EXISTS (
         SELECT 1
         FROM fpl.events previous_group_event
         WHERE previous_group_event.season_id = ${season.seasonId}
           AND previous_group_event.event_id = previous_group.event_id
           AND previous_group_event.finished = true
           AND previous_group_event.data_checked = true
       )
      ORDER BY current_rows.tournament_id, current_rows.entry_id
    `;
    if (kind === 'PROVISIONAL') {
      const entryById = new Map(entries.map((entry) => [entry.entry_id, entry] as const));
      for (const row of tournamentRows) {
        const score = projectedScoresByEntry.get(row.entry_id);
        const entry = entryById.get(row.entry_id);
        if (!score || !entry) continue;
        const projected = projectedResult(
          entry,
          eventId,
          score,
          picksByEntry.get(row.entry_id) ?? [],
        );
        const captain = (picksByEntry.get(row.entry_id) ?? []).find(
          (pick) => pick.element === projected.played_captain_element_id,
        );
        row.event_points = projected.event_points;
        row.event_cost = projected.event_transfers_cost;
        row.event_net_points = projected.event_net_points;
        row.event_rank = null;
        row.overall_points = projected.overall_points;
        row.overall_rank = null;
        row.event_chip = projected.event_chip;
        row.captain_id = projected.played_captain_element_id;
        row.captain_web_name = captain?.web_name ?? null;
        row.captain_team_short_name = captain?.team_short_name ?? null;
        row.captain_points = projected.captain_points;
        row.team_value = projected.team_value;
        row.bank = projected.bank;
        row.input_revision = projected.input_revision;
        row.score_revision = projected.score_revision;
      }
    } else {
      for (const row of tournamentRows) {
        const current = currentResults.get(row.entry_id);
        row.input_revision = current?.input_revision ?? null;
        row.score_revision = current?.score_revision ?? null;
      }
    }
    const tournamentRowsByTournament = groupBy(tournamentRows, (row) => row.tournament_id);
    const tournamentRowByMembership = new Map(
      tournamentRows.map((row) => [`${row.tournament_id}:${row.entry_id}`, row] as const),
    );
    const entryById = new Map(entries.map((entry) => [entry.entry_id, entry]));
    for (const membership of tournamentMembership) {
      const entry = entryById.get(membership.entry_id);
      if (!entry) {
        throw new MyFplSnapshotIncompleteError(
          `Tournament ${membership.tournament_id} references unknown entry ${membership.entry_id}`,
        );
      }
      const row = tournamentRowByMembership.get(
        `${membership.tournament_id}:${membership.entry_id}`,
      );
      const isEmpty = !isEntryEligibleForEvent({
        startedEvent: entry.started_event,
        eventId,
      });
      if (
        !row ||
        (!isEmpty &&
          (row.event_net_points === null ||
            row.input_revision === null ||
            row.score_revision === null))
      ) {
        throw new MyFplSnapshotIncompleteError(
          `Tournament ${membership.tournament_id} is incomplete for entry ${membership.entry_id}`,
        );
      }
    }
    const tournamentPayloadRows: Array<{
      season_id: number;
      event_id: number;
      revision: number;
      tournament_id: number;
      entry_id: number;
      payload: JsonRecord;
    }> = [];
    const tournamentAggregateRows: Array<{
      season_id: number;
      event_id: number;
      revision: number;
      tournament_id: number;
      payload: JsonRecord;
    }> = [];
    for (const tournamentId of tournamentIds) {
      const sourceRows = tournamentRowsByTournament.get(tournamentId) ?? [];
      if (sourceRows.length === 0) {
        throw new MyFplSnapshotIncompleteError(`Tournament ${tournamentId} has no roster`);
      }
      for (const sourceRow of sourceRows) {
        if (sourceRow.event_net_points === null && readyEntryIds.has(sourceRow.entry_id)) {
          throw new MyFplSnapshotIncompleteError(
            `Tournament ${tournamentId} entry ${sourceRow.entry_id} has no complete event result`,
          );
        }
        const isEmpty = !isEntryEligibleForEvent({
          startedEvent: entryById.get(sourceRow.entry_id)?.started_event,
          eventId,
        });
        const entryRevisions = scoreRevisionsByEntry.get(sourceRow.entry_id) ?? null;
        if (
          !isEmpty &&
          (!entryRevisions ||
            sourceRow.input_revision !== entryRevisions.inputRevision ||
            sourceRow.score_revision !== entryRevisions.scoreRevision)
        ) {
          throw new MyFplSnapshotIncompleteError(
            `Tournament ${tournamentId} entry ${sourceRow.entry_id} score revision does not match entry payload`,
          );
        }
      }
      const boardRows = sourceRows.map(
        (row) =>
          ({
            eventId,
            groupId: row.group_id,
            entryId: row.entry_id,
            entryName: row.entry_name,
            playerName: row.player_name,
            rank: null,
            previousRank: null,
            fieldRank: null,
            eventPoints: row.event_points,
            eventCost: row.event_cost,
            eventNetPoints: row.event_net_points,
            eventRank: row.event_rank,
            overallPoints: row.overall_points,
            overallRank: row.overall_rank,
            eventChip: chip(row.event_chip),
            captainId: row.captain_id,
            captainWebName: row.captain_web_name,
            captainTeamShortName: row.captain_team_short_name,
            captainPoints: row.captain_points,
            teamValue: row.team_value,
            bank: row.bank,
            previousEventNetPoints: row.previous_event_net_points,
            inputRevision: row.input_revision,
            scoreRevision: row.score_revision,
          }) as JsonRecord,
      );
      const currentRanks = rankForBoard(boardRows, 'eventNetPoints');
      const previousRanks = rankForBoard(boardRows, 'previousEventNetPoints');
      const sourceRowsByEntry = new Map(
        sourceRows.map((sourceRow) => [sourceRow.entry_id, sourceRow]),
      );
      for (const row of boardRows) {
        const sourceRow = sourceRowsByEntry.get(integerValue(row.entryId));
        // Points-race group ranks are authoritative for the tournament rank;
        // the raw event-net-points ordering is only the full-field fallback
        // used by tournaments without a group-result rank.
        row.rank =
          sourceRow?.current_group_rank ?? currentRanks.get(integerValue(row.entryId)) ?? null;
        row.previousRank =
          sourceRow?.previous_group_rank ?? previousRanks.get(integerValue(row.entryId)) ?? null;
        row.fieldRank = currentRanks.get(integerValue(row.entryId)) ?? null;
        tournamentPayloadRows.push({
          season_id: season.seasonId,
          event_id: eventId,
          revision: 0,
          tournament_id: tournamentId,
          entry_id: integerValue(row.entryId),
          payload: row,
        });
      }
      tournamentAggregateRows.push({
        season_id: season.seasonId,
        event_id: eventId,
        revision: 0,
        tournament_id: tournamentId,
        payload: buildAggregate(tournamentId, eventId, boardRows, mappedHistory),
      });
    }

    const sourceTimeInputs: Array<Date | string> = [
      ...resultRows.flatMap((row) => (row.rich_synced_at ? [row.rich_synced_at] : [])),
      ...pickRows.map((row) => row.source_updated_at),
      ...(kind === 'FINAL' && event.data_checked_at ? [event.data_checked_at] : []),
      ...(kind === 'PROVISIONAL' && projectedBatch ? [projectedBatch.sourceCheckedAt] : []),
    ];
    const sourceTimes = sourceTimeInputs.map((value) => new Date(value).getTime());
    if (sourceTimes.some((value) => !Number.isFinite(value))) {
      throw new MyFplSnapshotIncompleteError(
        'My FPL snapshot contains an invalid source timestamp',
      );
    }
    const sourceMinTimestamp =
      sourceTimes.length === 0
        ? now.getTime()
        : sourceTimes.reduce((earliest, value) => Math.min(earliest, value), Infinity);
    const sourceMaxTimestamp =
      sourceTimes.length === 0
        ? now.getTime()
        : sourceTimes.reduce((latest, value) => Math.max(latest, value), -Infinity);
    const sourceCheckedAt = new Date(sourceMinTimestamp);
    const sourceMaxCheckedAt = new Date(sourceMaxTimestamp);
    const sourceCheckedAtIso = sourceCheckedAt.toISOString();
    const sourceMaxCheckedAtIso = sourceMaxCheckedAt.toISOString();
    const scoreSource = kind === 'FINAL' ? 'FPL_FINAL_RESULT' : 'FPL_EVENT_LIVE';
    const livePublicationId =
      kind === 'PROVISIONAL' ? (projectedBatch?.publicationId ?? null) : null;
    const liveRevision =
      kind === 'PROVISIONAL' ? (projectedBatch?.scoreCoreRevision ?? null) : null;
    const algorithmVersion =
      kind === 'PROVISIONAL' ? (projectedBatch?.algorithmVersion ?? null) : null;
    const content = {
      seasonId: season.seasonId,
      eventId,
      kind,
      snapshotDate,
      entries: payloadEntries.map(({ payload, entry_id }) => ({ entry_id, payload })),
      tournaments: tournamentPayloadRows.map(({ tournament_id, entry_id, payload }) => ({
        tournament_id,
        entry_id,
        payload,
      })),
      aggregates: tournamentAggregateRows.map(({ tournament_id, payload }) => ({
        tournament_id,
        payload,
      })),
    };
    const contentSha256 = createHash('sha256')
      .update(postgresJsonbCanonicalJson(content), 'utf8')
      .digest('hex');

    if (
      isMatchingProvisionalMyFplPublication(active, {
        kind,
        snapshotDate,
        contentSha256,
        scoreSource,
        livePublicationId,
        liveRevision,
        algorithmVersion,
        sourceMinCheckedAt: sourceCheckedAtIso,
        sourceMaxCheckedAt: sourceMaxCheckedAtIso,
      })
    ) {
      return { status: 'noop', publication: active };
    }

    const publicationRows = await tx<{ revision: number | string; published_at: Date | string }[]>`
      INSERT INTO competition.my_fpl_snapshot_publications
        (season_id, event_id, snapshot_date, source_checked_at, source_min_checked_at,
         source_max_checked_at, score_source, live_publication_id, live_revision,
         algorithm_version, published_at, kind,
         active, expected_entry_count, ready_entry_count, empty_entry_count,
         not_applicable_entry_count, expected_tournament_count, ready_tournament_count,
         content_sha256,
         override_actor, override_reason, idempotency_key)
      VALUES
        (${season.seasonId}, ${eventId}, ${snapshotDate}::date, ${sourceCheckedAtIso}::timestamptz,
         ${sourceCheckedAtIso}::timestamptz, ${sourceMaxCheckedAtIso}::timestamptz,
         ${scoreSource}, ${livePublicationId}, ${liveRevision}, ${algorithmVersion},
         ${nowIso}::timestamptz, ${kind},
         false, ${expectedEntryCount}, ${readyEntryIds.size}, ${emptyEntryCount},
         ${notApplicableEntryCount},
         ${tournamentIds.length}, ${tournamentIds.length}, ${contentSha256},
         ${overrideActor}, ${overrideReason}, ${idempotencyKey})
      RETURNING revision, published_at
    `;
    const revision = Number(publicationRows[0]?.revision);
    if (!Number.isSafeInteger(revision) || revision <= 0) {
      throw new Error('My FPL publication revision was not allocated');
    }

    const entryInsertRows = payloadEntries.map((row) => ({ ...row, revision }));
    if (entryInsertRows.length > 0) {
      await tx`
        INSERT INTO competition.my_fpl_snapshot_entries
          (season_id, event_id, revision, entry_id, picks_count, is_empty, payload)
        SELECT (value->>'season_id')::smallint,
               (value->>'event_id')::integer,
               (value->>'revision')::bigint,
               (value->>'entry_id')::integer,
               (value->>'picks_count')::integer,
               (value->>'is_empty')::boolean,
               value->'payload'
        FROM jsonb_array_elements(${JSON.stringify(entryInsertRows)}::jsonb) value
      `;
    }
    const tournamentInsertRows = tournamentPayloadRows.map((row) => ({ ...row, revision }));
    if (tournamentInsertRows.length > 0) {
      await tx`
        INSERT INTO competition.my_fpl_snapshot_tournament_rows
          (season_id, event_id, revision, tournament_id, entry_id, payload)
        SELECT (value->>'season_id')::smallint,
               (value->>'event_id')::integer,
               (value->>'revision')::bigint,
               (value->>'tournament_id')::integer,
               (value->>'entry_id')::integer,
               value->'payload'
        FROM jsonb_array_elements(${JSON.stringify(tournamentInsertRows)}::jsonb) value
      `;
    }
    const aggregateInsertRows = tournamentAggregateRows.map((row) => ({ ...row, revision }));
    if (aggregateInsertRows.length > 0) {
      await tx`
        INSERT INTO competition.my_fpl_snapshot_tournament_aggregates
          (season_id, event_id, revision, tournament_id, payload)
        SELECT (value->>'season_id')::smallint,
               (value->>'event_id')::integer,
               (value->>'revision')::bigint,
               (value->>'tournament_id')::integer,
               value->'payload'
        FROM jsonb_array_elements(${JSON.stringify(aggregateInsertRows)}::jsonb) value
      `;
    }

    const persistedCounts = await tx<
      { entries: number; tournament_rows: number; aggregates: number }[]
    >`
      SELECT
        (SELECT count(*)::integer FROM competition.my_fpl_snapshot_entries WHERE season_id = ${season.seasonId} AND event_id = ${eventId} AND revision = ${revision}) AS entries,
        (SELECT count(*)::integer FROM competition.my_fpl_snapshot_tournament_rows WHERE season_id = ${season.seasonId} AND event_id = ${eventId} AND revision = ${revision}) AS tournament_rows,
        (SELECT count(*)::integer FROM competition.my_fpl_snapshot_tournament_aggregates WHERE season_id = ${season.seasonId} AND event_id = ${eventId} AND revision = ${revision}) AS aggregates
    `;
    const persisted = persistedCounts[0];
    if (
      !persisted ||
      persisted.entries !== entries.length ||
      persisted.tournament_rows !== tournamentMembership.length ||
      persisted.aggregates !== tournamentIds.length
    ) {
      throw new Error('My FPL snapshot child row count failed closed');
    }

    const redisManifest: MyFplSnapshotRedisManifest = {
      dataset: 'fpl:my-fpl',
      seasonCode: season.seasonCode,
      eventId,
      revision,
      snapshotDate,
      sourceCheckedAt: sourceCheckedAt.toISOString(),
      publishedAt: now.toISOString(),
      kind,
      contentSha256,
      scoreSource,
      livePublicationId,
      liveRevision,
      algorithmVersion,
      sourceMinCheckedAt: sourceCheckedAt.toISOString(),
      sourceMaxCheckedAt: sourceMaxCheckedAt.toISOString(),
    };
    // This receipt is committed in the same transaction as the immutable
    // children and active-pointer switch. Redis can therefore only receive a
    // revision that PostgreSQL has already proven complete.
    await tx`
      INSERT INTO competition.my_fpl_snapshot_publication_outbox
        (season_id, event_id, revision, manifest, status, available_at, updated_at)
      VALUES
        (${season.seasonId}, ${eventId}, ${revision}, ${JSON.stringify(redisManifest)}::jsonb,
         'PENDING', ${nowIso}::timestamptz, ${nowIso}::timestamptz)
      ON CONFLICT (season_id, event_id, revision) DO NOTHING
    `;

    await tx`
      UPDATE competition.my_fpl_snapshot_publications
      SET active = false, updated_at = ${nowIso}::timestamptz
      WHERE season_id = ${season.seasonId} AND event_id = ${eventId} AND active
    `;
    await tx`
      UPDATE competition.my_fpl_snapshot_publications
      SET active = true, updated_at = ${nowIso}::timestamptz
      WHERE season_id = ${season.seasonId} AND event_id = ${eventId} AND revision = ${revision}
    `;
    await tx`
      DELETE FROM competition.my_fpl_snapshot_publications
      WHERE season_id = ${season.seasonId} AND event_id = ${eventId}
        AND active = false AND updated_at < ${supersededBeforeIso}::timestamptz
    `;

    const publication: MyFplSnapshotPublication = {
      seasonId: season.seasonId,
      eventId,
      revision,
      snapshotDate,
      sourceCheckedAt,
      scoreSource,
      livePublicationId,
      liveRevision,
      algorithmVersion,
      sourceMinCheckedAt: sourceCheckedAt,
      sourceMaxCheckedAt,
      publishedAt: new Date(publicationRows[0].published_at),
      kind,
      expectedEntryCount,
      readyEntryCount: readyEntryIds.size,
      emptyEntryCount,
      notApplicableEntryCount,
      expectedTournamentCount: tournamentIds.length,
      readyTournamentCount: tournamentIds.length,
      contentSha256,
      overrideActor,
      overrideReason,
      idempotencyKey,
    };
    logInfo('Published My FPL snapshot', {
      season: season.seasonCode,
      eventId,
      kind,
      revision,
      snapshotDate,
      expectedEntries: expectedEntryCount,
      readyEntries: readyEntryIds.size,
      emptyEntries: emptyEntryCount,
      notApplicableEntries: notApplicableEntryCount,
      tournaments: tournamentIds.length,
    });
    return { status: 'published', publication };
  });
}

export function captureMyFplSnapshot(
  season: FplSeasonRef,
  eventId: number,
  kind: MyFplSnapshotKind,
  options: MyFplSnapshotCaptureOptions = {},
): Promise<MyFplSnapshotCaptureResult> {
  return serializeMyFplSnapshotCapture(myFplSnapshotEventLockScope(season.seasonId, eventId), () =>
    captureMyFplSnapshotOnce(season, eventId, kind, options),
  );
}

function rankForBoard(rows: JsonRecord[], key: 'eventNetPoints' | 'previousEventNetPoints') {
  const sorted = rows
    .filter((row) => row[key] !== null)
    .sort((left, right) => numberValue(right[key], -1) - numberValue(left[key], -1));
  return new Map(sorted.map((row, index) => [integerValue(row.entryId), index + 1]));
}

type SnapshotOutboxRow = {
  outbox_id: string;
  season_id: number;
  event_id: number;
  revision: number;
  source_checked_at: Date | string;
  published_at: Date | string;
  manifest: unknown;
};

const isMyFplSnapshotRedisManifest = (value: unknown): value is MyFplSnapshotRedisManifest => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.dataset === 'fpl:my-fpl' &&
    typeof candidate.seasonCode === 'string' &&
    /^\d{4}$/.test(candidate.seasonCode) &&
    typeof candidate.eventId === 'number' &&
    Number.isSafeInteger(candidate.eventId) &&
    candidate.eventId > 0 &&
    typeof candidate.revision === 'number' &&
    Number.isSafeInteger(candidate.revision) &&
    candidate.revision > 0 &&
    typeof candidate.snapshotDate === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(candidate.snapshotDate) &&
    typeof candidate.sourceCheckedAt === 'string' &&
    Number.isFinite(Date.parse(candidate.sourceCheckedAt)) &&
    typeof candidate.publishedAt === 'string' &&
    Number.isFinite(Date.parse(candidate.publishedAt)) &&
    (candidate.kind === 'PROVISIONAL' || candidate.kind === 'FINAL') &&
    typeof candidate.contentSha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(candidate.contentSha256) &&
    (candidate.kind === 'PROVISIONAL'
      ? candidate.scoreSource === 'FPL_EVENT_LIVE' &&
        typeof candidate.livePublicationId === 'string' &&
        UUID_RE.test(candidate.livePublicationId) &&
        typeof candidate.liveRevision === 'string' &&
        candidate.liveRevision.trim() !== '' &&
        typeof candidate.algorithmVersion === 'string' &&
        candidate.algorithmVersion === LIVE_POINTS_V2_ALGORITHM_VERSION
      : candidate.scoreSource === 'FPL_FINAL_RESULT' &&
        candidate.livePublicationId === null &&
        candidate.liveRevision === null &&
        candidate.algorithmVersion === null) &&
    typeof candidate.sourceMinCheckedAt === 'string' &&
    Number.isFinite(Date.parse(candidate.sourceMinCheckedAt)) &&
    typeof candidate.sourceMaxCheckedAt === 'string' &&
    Number.isFinite(Date.parse(candidate.sourceMaxCheckedAt)) &&
    Date.parse(candidate.sourceMinCheckedAt) <= Date.parse(candidate.sourceMaxCheckedAt) &&
    candidate.sourceCheckedAt === candidate.sourceMinCheckedAt
  );
};

/**
 * Read the currently active My FPL Redis pointer without treating a malformed
 * or missing value as delivery evidence.  A capture retry can legitimately
 * return `noop` after the PostgreSQL publication already exists; verifying the
 * pointer here lets that retry settle the same freshness window without
 * fabricating a new publication or replaying the provider fan-out.
 */
export async function getActiveMyFplSnapshotRedisManifest(
  seasonCode: string,
  eventId: number,
): Promise<MyFplSnapshotRedisManifest | null> {
  const redis = await redisSingleton.getClient();
  const raw = await redis.get(myFplSnapshotRedisManifestKey(seasonCode, eventId));
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    logWarn('My FPL Redis manifest is not valid JSON', { seasonCode, eventId });
    return null;
  }
  if (!isMyFplSnapshotRedisManifest(parsed)) {
    logWarn('My FPL Redis manifest failed schema validation', { seasonCode, eventId });
    return null;
  }
  return parsed;
}

async function releaseMyFplSnapshotOutbox(
  tx: postgres.TransactionSql,
  outboxId: string,
  owner: string,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await tx`
    UPDATE competition.my_fpl_snapshot_publication_outbox
    SET status = 'PENDING',
        available_at = clock_timestamp() + interval '30 minutes',
        lease_owner = NULL,
        lease_expires_at = NULL,
        last_error = ${message.slice(0, 4000)},
        updated_at = clock_timestamp()
    WHERE outbox_id = ${outboxId}::uuid AND lease_owner = ${owner}
  `;
}

/**
 * Deliver committed My FPL revisions to the Redis manifest pointer. The
 * database outbox is the authority; Redis is only promoted after the child
 * rows and active revision have committed successfully.
 */
export async function dispatchMyFplSnapshotPublicationOutbox(
  options: {
    limit?: number;
    seasonCode?: string;
    eventId?: number;
  } = {},
): Promise<MyFplSnapshotOutboxDispatchResult> {
  const limit = options.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('My FPL snapshot outbox limit must be between 1 and 100');
  }
  const owner = randomUUID();
  const db = await getDbClient();
  const claimed = await db.begin(async (tx) => {
    await tx`
      UPDATE competition.my_fpl_snapshot_publication_outbox outbox
      SET status = 'SUPERSEDED',
          delivered_at = clock_timestamp(),
          lease_owner = NULL,
          lease_expires_at = NULL,
          last_error = 'Publication is no longer the active My FPL revision',
          updated_at = clock_timestamp()
      WHERE outbox.status IN ('PENDING', 'PROCESSING')
        AND EXISTS (
          SELECT 1
          FROM competition.my_fpl_snapshot_publications publication
          WHERE publication.season_id = outbox.season_id
            AND publication.event_id = outbox.event_id
            AND publication.revision = outbox.revision
            AND publication.active = false
        )
    `;
    const rows = await tx<SnapshotOutboxRow[]>`
      SELECT outbox.outbox_id, outbox.season_id, outbox.event_id, outbox.revision,
             outbox.manifest, publication.source_checked_at, publication.published_at
      FROM competition.my_fpl_snapshot_publication_outbox outbox
      JOIN competition.my_fpl_snapshot_publications publication
        ON publication.season_id = outbox.season_id
       AND publication.event_id = outbox.event_id
       AND publication.revision = outbox.revision
       AND publication.active = true
      WHERE outbox.status IN ('PENDING', 'PROCESSING')
        AND outbox.available_at <= clock_timestamp()
        AND (
          outbox.status = 'PENDING'
          OR outbox.lease_expires_at IS NULL
          OR outbox.lease_expires_at <= clock_timestamp()
        )
        ${options.eventId ? tx`AND outbox.event_id = ${options.eventId}` : tx``}
        ${options.seasonCode ? tx`AND outbox.manifest->>'seasonCode' = ${options.seasonCode}` : tx``}
      ORDER BY outbox.available_at, outbox.outbox_id
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `;
    for (const row of rows) {
      await tx`
        UPDATE competition.my_fpl_snapshot_publication_outbox
        SET status = 'PROCESSING',
            attempts = attempts + 1,
            lease_owner = ${owner},
            lease_expires_at = clock_timestamp() + interval '2 minutes',
            updated_at = clock_timestamp()
        WHERE outbox_id = ${row.outbox_id}::uuid
      `;
    }
    return rows;
  });

  let delivered = 0;
  let superseded = 0;
  let failed = 0;
  const deliveredRevisions: number[] = [];
  const deliveredEvidence: MyFplSnapshotOutboxDeliveryEvidence[] = [];
  const redis = await redisSingleton.getClient();
  for (const row of claimed) {
    try {
      if (!isMyFplSnapshotRedisManifest(row.manifest)) {
        throw new Error(`Invalid My FPL snapshot outbox manifest ${row.outbox_id}`);
      }
      const manifest = row.manifest;
      const sourceCheckedAt = new Date(row.source_checked_at);
      const publishedAt = new Date(row.published_at);
      if (!Number.isFinite(sourceCheckedAt.getTime()) || !Number.isFinite(publishedAt.getTime())) {
        throw new Error(`Invalid My FPL publication timestamps ${row.outbox_id}`);
      }
      // Keep the publication advisory lock until the Redis activation and
      // delivery receipt commit. A capture racing after the claim either
      // waits for this transaction or is observed as inactive before Redis is
      // touched; Redis can never be left on an inactive database revision.
      const status = await db.begin(async (tx) => {
        await tx`
          SELECT pg_advisory_xact_lock(
            hashtextextended(${myFplSnapshotEventLockScope(row.season_id, row.event_id)}, 0)
          )
        `;
        const ownership = await tx<{ active: boolean }[]>`
          SELECT publication.active
          FROM competition.my_fpl_snapshot_publication_outbox outbox
          JOIN competition.my_fpl_snapshot_publications publication
            ON publication.season_id = outbox.season_id
           AND publication.event_id = outbox.event_id
           AND publication.revision = outbox.revision
          WHERE outbox.outbox_id = ${row.outbox_id}::uuid
            AND outbox.lease_owner = ${owner}
          FOR UPDATE
        `;
        if (!ownership[0]?.active) {
          await tx`
            UPDATE competition.my_fpl_snapshot_publication_outbox
            SET status = 'SUPERSEDED', delivered_at = clock_timestamp(),
                lease_owner = NULL, lease_expires_at = NULL,
                last_error = 'Publication is no longer the active My FPL revision',
                updated_at = clock_timestamp()
            WHERE outbox_id = ${row.outbox_id}::uuid AND lease_owner = ${owner}
          `;
          return 'superseded' as const;
        }

        const activation = (await redis.eval(
          MY_FPL_SNAPSHOT_REDIS_ACTIVATE_SCRIPT,
          1,
          myFplSnapshotRedisManifestKey(manifest.seasonCode, manifest.eventId),
          JSON.stringify(manifest),
        )) as [string, string?];
        if (activation[0] === 'stale') {
          await tx`
            UPDATE competition.my_fpl_snapshot_publication_outbox
            SET status = 'SUPERSEDED', delivered_at = clock_timestamp(),
                lease_owner = NULL, lease_expires_at = NULL,
                last_error = 'A newer My FPL revision already owns the Redis manifest',
                updated_at = clock_timestamp()
            WHERE outbox_id = ${row.outbox_id}::uuid AND lease_owner = ${owner}
          `;
          return 'superseded' as const;
        }
        if (activation[0] !== 'published') {
          throw new Error(`My FPL Redis manifest activation failed: ${activation[0]}`);
        }
        await tx`
          UPDATE competition.my_fpl_snapshot_publication_outbox
          SET status = 'DELIVERED', delivered_at = clock_timestamp(),
              lease_owner = NULL, lease_expires_at = NULL,
              last_error = NULL, updated_at = clock_timestamp()
          WHERE outbox_id = ${row.outbox_id}::uuid AND lease_owner = ${owner}
        `;
        return 'delivered' as const;
      });
      if (status === 'superseded') superseded += 1;
      else {
        delivered += 1;
        deliveredRevisions.push(row.revision);
        deliveredEvidence.push({
          seasonId: row.season_id,
          eventId: row.event_id,
          revision: row.revision,
          kind: manifest.kind,
          sourceCheckedAt: sourceCheckedAt.toISOString(),
          publishedAt: publishedAt.toISOString(),
        });
      }
    } catch (error) {
      failed += 1;
      logWarn('My FPL snapshot Redis manifest delivery failed', {
        error: error instanceof Error ? error.message : String(error),
        outboxId: row.outbox_id,
        revision: row.revision,
      });
      await db.begin((tx) => releaseMyFplSnapshotOutbox(tx, row.outbox_id, owner, error));
    }
  }
  const remainingRows = await db<{ count: number | string }[]>`
    SELECT count(*)::int AS count
    FROM competition.my_fpl_snapshot_publication_outbox outbox
    JOIN competition.my_fpl_snapshot_publications publication
      ON publication.season_id = outbox.season_id
     AND publication.event_id = outbox.event_id
     AND publication.revision = outbox.revision
     AND publication.active = true
    WHERE outbox.status IN ('PENDING', 'PROCESSING', 'FAILED')
      ${options.eventId ? db`AND outbox.event_id = ${options.eventId}` : db``}
      ${options.seasonCode ? db`AND outbox.manifest->>'seasonCode' = ${options.seasonCode}` : db``}
  `;
  return {
    claimed: claimed.length,
    delivered,
    superseded,
    failed,
    deliveredRevisions,
    deliveredEvidence,
    remaining: Number(remainingRows[0]?.count ?? 0),
  };
}
