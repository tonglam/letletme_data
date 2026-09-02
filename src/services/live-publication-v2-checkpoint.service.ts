import { randomUUID } from 'node:crypto';

import { and, eq, ne, or, sql, type SQL } from 'drizzle-orm';

import {
  eventsInFpl,
  liveMatchDeskCheckpointsInFpl,
  liveMatchDetailCheckpointsInFpl,
  liveLeagueCheckpointsInCompetition,
  livePointsPublicationCheckpointsInCompetition,
  livePointsPublicationSeedClaimsInCompetition,
  tournamentsInCompetition,
} from '../db/schemas/index.schema';
import { getDb } from '../db/singleton';
import type { FplSeasonRef } from '../domain/fpl-season';
import type { EventLive } from '../domain/event-lives';
import type { EventLiveExplain } from '../domain/event-live-explains';
import type { FplPlayerFixtureEvidence } from '../domain/fpl-player-fixture-stats';
import { validateSerializedFixtures } from '../domain/fixtures';
import type { Fixture } from '../types';
import { createFixtureRepository } from '../repositories/fixtures';
import { createEventLiveRepository } from '../repositories/event-lives';
import { createEventLiveExplainsRepository } from '../repositories/event-live-explains';
import { createFplPlayerFixtureStatsRepository } from '../repositories/fpl-player-fixture-stats';
import { CORE_SNAPSHOT_WRITE_LOCK_KEY } from './core-snapshot-persistence.service';
import { hasFinalLiveMatchCheckpointsV3 } from './live-match-v3-checkpoint.service';
import { refreshPlayerSeasonSummaries } from './player-season-summaries.service';
import {
  liveV2ItemKey,
  type LivePublicationRead,
  type LivePublicationV2,
  type LivePublicationState,
} from '../cache/live-publication-v2';
import { validateLiveLeaguePublicationV2Checkpoint } from '../cache/live-league-publication-v2';
import { canonicalJson, contentHash } from '../utils/content-hash';
import { logError } from '../utils/logger';

const LIVE_FINAL_CHECKPOINT_VALIDATION_CACHE_LIMIT = 128;
const LIVE_FINAL_CHECKPOINT_VALIDATION_RECHECK_MS = 5 * 60_000;

type FinalCheckpointValidationIdentity = Readonly<{
  deskPublicationId: string | null;
  deskGeneration: number | null;
  deskPayloadSha256: string | null;
  deskRowCount: number | null;
  deskPayloadBytes: number | null;
  deskCheckpointedAt: string | null;
  detailPublicationId: string | null;
  detailGeneration: number | null;
  detailObservedDeskGeneration: number | null;
  detailFixtureIdentityRevision: string | null;
  detailPayloadSha256: string | null;
  detailRowCount: number | null;
  detailPayloadBytes: number | null;
  detailCheckpointedAt: string | null;
}>;

type FinalCheckpointValidationCacheEntry = Readonly<{
  identity: FinalCheckpointValidationIdentity;
  validatedAtMs: number;
}>;

const finalCheckpointValidationCache = new Map<string, FinalCheckpointValidationCacheEntry>();

const checkpointDateIdentity = (value: Date | null): string | null => value?.toISOString() ?? null;

const sameFinalCheckpointValidationIdentity = (
  left: FinalCheckpointValidationIdentity,
  right: FinalCheckpointValidationIdentity,
): boolean =>
  left.deskPublicationId === right.deskPublicationId &&
  left.deskGeneration === right.deskGeneration &&
  left.deskPayloadSha256 === right.deskPayloadSha256 &&
  left.deskRowCount === right.deskRowCount &&
  left.deskPayloadBytes === right.deskPayloadBytes &&
  left.deskCheckpointedAt === right.deskCheckpointedAt &&
  left.detailPublicationId === right.detailPublicationId &&
  left.detailGeneration === right.detailGeneration &&
  left.detailObservedDeskGeneration === right.detailObservedDeskGeneration &&
  left.detailFixtureIdentityRevision === right.detailFixtureIdentityRevision &&
  left.detailPayloadSha256 === right.detailPayloadSha256 &&
  left.detailRowCount === right.detailRowCount &&
  left.detailPayloadBytes === right.detailPayloadBytes &&
  left.detailCheckpointedAt === right.detailCheckpointedAt;

const rememberFinalCheckpointValidation = (
  key: string,
  identity: FinalCheckpointValidationIdentity,
): void => {
  finalCheckpointValidationCache.delete(key);
  finalCheckpointValidationCache.set(key, { identity, validatedAtMs: Date.now() });
  while (finalCheckpointValidationCache.size > LIVE_FINAL_CHECKPOINT_VALIDATION_CACHE_LIMIT) {
    const oldest = finalCheckpointValidationCache.keys().next().value;
    if (typeof oldest !== 'string') break;
    finalCheckpointValidationCache.delete(oldest);
  }
};

type RequiredLiveLeagueCheckpointScope = {
  tournamentId: number;
  scopeKind: 'CLASSIC' | 'H2H_HEAD' | 'H2H_STANDINGS';
};

function h2hFinalizationPhaseActive(
  groupStartedEventId: number | null,
  groupEndedEventId: number | null,
  knockoutStartedEventId: number | null,
  knockoutEndedEventId: number | null,
  eventId: number,
): boolean {
  const phases = [
    [groupStartedEventId, groupEndedEventId],
    [knockoutStartedEventId, knockoutEndedEventId],
  ] as const;
  if (!phases.some(([start, end]) => start !== null || end !== null)) return true;
  return phases.some(
    ([start, end]) =>
      (start !== null && eventId >= start && (end === null || eventId <= end)) ||
      (start === null && end !== null && eventId <= end),
  );
}

/**
 * State columns are only a cheap fence. Validate every active tournament's
 * FINALIZED league checkpoint with the same self-contained contract used by
 * readers before treating the event as durably complete.
 */
async function hasFinalLiveLeagueCheckpointsV2(
  season: FplSeasonRef,
  eventId: number,
): Promise<boolean> {
  const db = await getDb();
  const expectedTournaments = await db
    .select({
      tournamentId: tournamentsInCompetition.tournamentId,
      leagueType: tournamentsInCompetition.leagueType,
      rosterMode: tournamentsInCompetition.rosterMode,
      groupMode: tournamentsInCompetition.groupMode,
      groupStartedEventId: tournamentsInCompetition.groupStartedEventId,
      groupEndedEventId: tournamentsInCompetition.groupEndedEventId,
      knockoutStartedEventId: tournamentsInCompetition.knockoutStartedEventId,
      knockoutEndedEventId: tournamentsInCompetition.knockoutEndedEventId,
    })
    .from(tournamentsInCompetition)
    .where(
      and(
        eq(tournamentsInCompetition.seasonId, season.seasonId),
        eq(tournamentsInCompetition.state, 'active'),
        eq(tournamentsInCompetition.setupStatus, 'ready'),
      ),
    );
  const requiredScopes: RequiredLiveLeagueCheckpointScope[] = [];
  for (const tournament of expectedTournaments) {
    if (tournament.leagueType === 'classic') {
      requiredScopes.push({ tournamentId: tournament.tournamentId, scopeKind: 'CLASSIC' });
      continue;
    }
    if (
      tournament.leagueType !== 'h2h' ||
      tournament.rosterMode !== 'official_sync' ||
      tournament.groupMode !== 'battle_races' ||
      !h2hFinalizationPhaseActive(
        tournament.groupStartedEventId,
        tournament.groupEndedEventId,
        tournament.knockoutStartedEventId,
        tournament.knockoutEndedEventId,
        eventId,
      )
    ) {
      continue;
    }
    requiredScopes.push(
      { tournamentId: tournament.tournamentId, scopeKind: 'H2H_HEAD' },
      { tournamentId: tournament.tournamentId, scopeKind: 'H2H_STANDINGS' },
    );
  }
  if (requiredScopes.length === 0) return true;

  const rows = await db
    .select({
      tournamentId: liveLeagueCheckpointsInCompetition.tournamentId,
      scopeKind: liveLeagueCheckpointsInCompetition.scopeKind,
      state: liveLeagueCheckpointsInCompetition.state,
      publicationId: liveLeagueCheckpointsInCompetition.publicationId,
      generation: liveLeagueCheckpointsInCompetition.generation,
      manifest: liveLeagueCheckpointsInCompetition.manifest,
      indexPayload: liveLeagueCheckpointsInCompetition.indexPayload,
      payload: liveLeagueCheckpointsInCompetition.payload,
      rowCount: liveLeagueCheckpointsInCompetition.rowCount,
      payloadBytes: liveLeagueCheckpointsInCompetition.payloadBytes,
      payloadSha256: liveLeagueCheckpointsInCompetition.payloadSha256,
      groupStartedEventId: tournamentsInCompetition.groupStartedEventId,
      groupEndedEventId: tournamentsInCompetition.groupEndedEventId,
      knockoutStartedEventId: tournamentsInCompetition.knockoutStartedEventId,
      knockoutEndedEventId: tournamentsInCompetition.knockoutEndedEventId,
      leagueType: tournamentsInCompetition.leagueType,
    })
    .from(liveLeagueCheckpointsInCompetition)
    .innerJoin(
      tournamentsInCompetition,
      and(
        eq(tournamentsInCompetition.seasonId, liveLeagueCheckpointsInCompetition.seasonId),
        eq(tournamentsInCompetition.tournamentId, liveLeagueCheckpointsInCompetition.tournamentId),
      ),
    )
    .where(
      and(
        eq(liveLeagueCheckpointsInCompetition.seasonId, season.seasonId),
        eq(liveLeagueCheckpointsInCompetition.eventId, eventId),
        eq(liveLeagueCheckpointsInCompetition.state, 'FINALIZED'),
        eq(tournamentsInCompetition.state, 'active'),
        eq(tournamentsInCompetition.setupStatus, 'ready'),
      ),
    );
  const checkpointByScope = new Map(
    rows.map((row) => [`${row.tournamentId}:${row.scopeKind}`, row] as const),
  );
  for (const requiredScope of requiredScopes) {
    const row = checkpointByScope.get(`${requiredScope.tournamentId}:${requiredScope.scopeKind}`);
    if (!row || row.state !== 'FINALIZED') return false;
    if (
      row.scopeKind !== 'CLASSIC' &&
      row.scopeKind !== 'H2H_HEAD' &&
      row.scopeKind !== 'H2H_STANDINGS'
    ) {
      return false;
    }
    if (
      !validateLiveLeaguePublicationV2Checkpoint(
        {
          season: season.seasonCode,
          eventId,
          tournamentId: row.tournamentId,
          scope: row.scopeKind,
        },
        row.manifest,
        row.indexPayload,
        row.payload,
        {
          publicationId: row.publicationId,
          generation: row.generation,
          state: row.state,
          rowCount: row.rowCount,
          payloadBytes: row.payloadBytes,
          payloadSha256: row.payloadSha256,
        },
      )
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Final live league repair is allowed only when the durable rows needed to
 * rebuild an entry input still exist.  Redis retention is a serving policy,
 * not evidence that a final entry can be reconstructed after a cold rebuild.
 */
export function durableFinalChipMatches(activeChip: SQL, inputChip: SQL): SQL {
  return sql`
    CASE
      WHEN ${inputChip} IS NULL THEN ${activeChip} IS NULL
      WHEN ${inputChip} IN ('n/a', 'wildcard', 'freehit', 'bboost', '3xc', 'manager')
        THEN ${activeChip} IS NOT DISTINCT FROM (${inputChip})::competition.chip
      ELSE false
    END
  `;
}

function hasDurableFinalEntryInput(seasonCode: string, entryId: SQL): SQL {
  return sql`
    EXISTS (
      SELECT 1
      FROM competition.entry_event_pick_heads AS input_head
      WHERE input_head.season_id = ${eventsInFpl.seasonId}
        AND input_head.entry_id = ${entryId}
        AND input_head.event_id = ${eventsInFpl.eventId}
        AND input_head.state = 'COMPLETE'
        AND input_head.row_count = 15
        -- Final recovery is lossless only when the V2 semantic input captured
        -- at checkpoint time is still present.  A complete pick rowset alone
        -- cannot reconstruct previous totals or provider-side facts.
        AND input_head.input_payload IS NOT NULL
        AND jsonb_typeof(input_head.input_payload) = 'object'
        -- Keep the set-based target query aligned with the V2 input validator;
        -- the recovery worker still performs the complete semantic check.
        AND input_head.input_payload ?& ARRAY[
          'contractVersion', 'season', 'eventId', 'entryId', 'picksBase',
          'previousTotals', 'officialAdjustment', 'finalResult'
        ]
        AND input_head.input_payload->>'contractVersion' = 'live-points-v2'
        AND input_head.input_payload->>'season' = ${seasonCode}
        AND input_head.input_payload->>'eventId' = ${eventsInFpl.eventId}::text
        AND input_head.input_payload->>'entryId' = input_head.entry_id::text
        AND jsonb_typeof(input_head.input_payload->'picksBase') = 'object'
        AND input_head.input_payload->'picksBase' ?& ARRAY[
          'revision', 'contentUpdatedAt', 'picks', 'chip', 'transferCount', 'transferCost'
        ]
        AND input_head.input_payload->'picksBase'->>'revision' ~ '^[0-9a-f]{64}$'
        AND jsonb_typeof(input_head.input_payload->'picksBase'->'contentUpdatedAt') = 'string'
        AND input_head.input_payload->'picksBase'->>'contentUpdatedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'
        AND jsonb_typeof(input_head.input_payload->'picksBase'->'picks') = 'array'
        AND CASE
          WHEN jsonb_typeof(input_head.input_payload->'picksBase'->'picks') = 'array'
          THEN jsonb_array_length(input_head.input_payload->'picksBase'->'picks') = 15
          ELSE false
        END
        AND EXISTS (
          SELECT 1
          FROM (
            SELECT
              jsonb_typeof(raw_pick.value) = 'object' AS is_object,
              CASE
                WHEN jsonb_typeof(raw_pick.value->'element') = 'number'
                THEN (raw_pick.value->>'element')::numeric
                ELSE NULL
              END AS element,
              CASE
                WHEN jsonb_typeof(raw_pick.value->'position') = 'number'
                THEN (raw_pick.value->>'position')::numeric
                ELSE NULL
              END AS position,
              CASE
                WHEN jsonb_typeof(raw_pick.value->'multiplier') = 'number'
                THEN (raw_pick.value->>'multiplier')::numeric
                ELSE NULL
              END AS multiplier,
              CASE
                WHEN jsonb_typeof(raw_pick.value->'isCaptain') = 'boolean'
                THEN (raw_pick.value->>'isCaptain')::boolean
                ELSE NULL
              END AS is_captain,
              CASE
                WHEN jsonb_typeof(raw_pick.value->'isViceCaptain') = 'boolean'
                THEN (raw_pick.value->>'isViceCaptain')::boolean
                ELSE NULL
              END AS is_vice_captain
            FROM jsonb_array_elements(
              CASE
                WHEN jsonb_typeof(input_head.input_payload->'picksBase'->'picks') = 'array'
                THEN input_head.input_payload->'picksBase'->'picks'
                ELSE '[]'::jsonb
              END
            ) AS raw_pick(value)
          ) AS pick
          HAVING count(*) = 15
             AND count(*) FILTER (
               WHERE pick.is_object
                 AND pick.element IS NOT NULL
                 AND pick.element = trunc(pick.element)
                 AND pick.element > 0
                 AND pick.element <= 9007199254740991
                 AND pick.position IS NOT NULL
                 AND pick.position = trunc(pick.position)
                 AND pick.position BETWEEN 1 AND 15
                 AND pick.multiplier IS NOT NULL
                 AND pick.multiplier = trunc(pick.multiplier)
                 AND pick.multiplier BETWEEN 0 AND 3
                 AND pick.is_captain IS NOT NULL
                 AND pick.is_vice_captain IS NOT NULL
                 AND NOT (pick.is_captain AND pick.is_vice_captain)
             ) = 15
             AND count(DISTINCT pick.element) = 15
             AND count(DISTINCT pick.position) = 15
             AND min(pick.position) = 1
             AND max(pick.position) = 15
             AND count(*) FILTER (WHERE pick.is_captain) = 1
             AND count(*) FILTER (WHERE pick.is_vice_captain) = 1
             AND count(*) FILTER (
               WHERE pick.is_object
                 AND EXISTS (
                   SELECT 1
                   FROM competition.entry_event_picks AS stored_pick
                   WHERE stored_pick.season_id = input_head.season_id
                     AND stored_pick.entry_id = input_head.entry_id
                     AND stored_pick.event_id = input_head.event_id
                     AND stored_pick.position = pick.position
                     AND stored_pick.element_id = pick.element
                     AND stored_pick.multiplier = pick.multiplier
                     AND stored_pick.is_captain = pick.is_captain
                     AND stored_pick.is_vice_captain = pick.is_vice_captain
                     AND (
                       (pick.position = 1
                         AND ${durableFinalChipMatches(
                           sql`stored_pick.active_chip`,
                           sql`input_head.input_payload->'picksBase'->>'chip'`,
                         )}
                         AND stored_pick.transfers = CASE
                           WHEN jsonb_typeof(input_head.input_payload->'picksBase'->'transferCount') = 'number'
                           THEN (input_head.input_payload->'picksBase'->>'transferCount')::numeric
                           ELSE NULL
                         END
                         AND stored_pick.transfers_cost = CASE
                           WHEN jsonb_typeof(input_head.input_payload->'picksBase'->'transferCost') = 'number'
                           THEN (input_head.input_payload->'picksBase'->>'transferCost')::numeric
                           ELSE NULL
                         END)
                       OR
                       (pick.position <> 1
                         AND stored_pick.active_chip IS NULL
                         AND stored_pick.transfers IS NULL
                         AND stored_pick.transfers_cost IS NULL)
                     )
                 )
             ) = 15
        )
        AND jsonb_typeof(input_head.input_payload->'picksBase'->'chip') IN ('null', 'string')
        AND jsonb_typeof(input_head.input_payload->'picksBase'->'transferCount') = 'number'
        AND jsonb_typeof(input_head.input_payload->'picksBase'->'transferCost') = 'number'
        AND CASE
          WHEN jsonb_typeof(input_head.input_payload->'picksBase'->'transferCount') = 'number'
          THEN (input_head.input_payload->'picksBase'->>'transferCount')::numeric >= 0
          ELSE false
        END
        AND CASE
          WHEN jsonb_typeof(input_head.input_payload->'picksBase'->'transferCost') = 'number'
          THEN (input_head.input_payload->'picksBase'->>'transferCost')::numeric >= 0
          ELSE false
        END
        AND (
          jsonb_typeof(input_head.input_payload->'previousTotals') = 'null'
          OR (
            jsonb_typeof(input_head.input_payload->'previousTotals') = 'object'
            AND input_head.input_payload->'previousTotals'->>'revision' ~ '^[0-9a-f]{64}$'
          )
        )
        AND (
          jsonb_typeof(input_head.input_payload->'officialAdjustment') = 'null'
          OR (
            jsonb_typeof(input_head.input_payload->'officialAdjustment') = 'object'
            AND input_head.input_payload->'officialAdjustment'->>'revision' ~ '^[0-9a-f]{64}$'
          )
        )
        AND (
          jsonb_typeof(input_head.input_payload->'finalResult') = 'null'
          OR (
            jsonb_typeof(input_head.input_payload->'finalResult') = 'object'
            AND input_head.input_payload->'finalResult'->>'revision' ~ '^[0-9a-f]{64}$'
          )
        )
        AND EXISTS (
          SELECT 1
          FROM competition.entry_event_picks AS input_pick
          WHERE input_pick.season_id = input_head.season_id
            AND input_pick.entry_id = input_head.entry_id
            AND input_pick.event_id = input_head.event_id
          GROUP BY input_pick.season_id, input_pick.entry_id, input_pick.event_id
          HAVING count(*) = 15
             AND min(input_pick.position) = 1
             AND max(input_pick.position) = 15
             AND count(*) FILTER (WHERE input_pick.is_captain) = 1
             AND count(*) FILTER (WHERE input_pick.is_vice_captain) = 1
        )
    )
    AND EXISTS (
      SELECT 1
      FROM competition.entry_event_results AS final_result
      WHERE final_result.season_id = ${eventsInFpl.seasonId}
        AND final_result.entry_id = ${entryId}
        AND final_result.event_id = ${eventsInFpl.eventId}
        AND final_result.rich_synced_at IS NOT NULL
        AND final_result.rich_synced_at >= ${eventsInFpl.dataCheckedAt}
        AND CASE
          WHEN jsonb_typeof(final_result.event_picks) = 'array'
            THEN jsonb_array_length(final_result.event_picks)
          ELSE 0
        END = 15
    )
  `;
}

export type LivePublicationV2CheckpointRequest = {
  readonly season: FplSeasonRef;
  readonly eventId: number;
  readonly publication: LivePublicationV2;
  readonly eventLives: readonly EventLive[];
  readonly fixtures: readonly Fixture[];
  /** Facts captured with the same coherent FPL response. */
  readonly explains: readonly EventLiveExplain[];
  readonly fixtureEvidence: readonly FplPlayerFixtureEvidence[];
  /**
   * Fresh observation time used for the ordering fence. A recovery can
   * re-verify an immutable FINAL publication after its original source check;
   * the publication timestamp stays part of that identity, while this time
   * proves the facts were observed after the current relational authority.
   */
  readonly observationCheckedAt?: Date | string;
  /**
   * Seed recovery uses an absent durable head as part of its eligibility
   * proof. Enforce that proof only after taking the scope advisory lock so a
   * concurrent normal checkpoint cannot commit between the check and insert.
   */
  readonly requireMissingCheckpoint?: boolean;
  /** Exact durable seed claim acquired before the Redis active switch. */
  readonly seedClaimId?: string;
};

export type LivePublicationV2SeedClaim = {
  readonly claimId: string;
  readonly expectedActiveSha256: string;
  readonly candidateState: LivePublicationState;
  readonly candidateSourceCheckedAt: string;
  readonly candidateEventLiveSha256: string;
  readonly candidateFixturesSha256: string;
  readonly claimedAt: string;
};

export type LivePublicationV2SeedCandidate = Omit<
  LivePublicationV2SeedClaim,
  'claimId' | 'expectedActiveSha256' | 'claimedAt'
>;

// After the claim commits, promotion performs only bounded Redis commands
// (5-second command timeout each). One minute is therefore a conservative
// ownership lease, not a publication cadence or freshness threshold.
export const LIVE_PUBLICATION_SEED_CLAIM_LEASE_MS = 60_000;

const LIVE_PUBLICATION_STATES: readonly LivePublicationState[] = [
  'PRE_DEADLINE',
  'PICKS_WAIT',
  'PICKS_PROBE',
  'PICKS_SYNC',
  'LIVE_ACTIVE',
  'BETWEEN_FIXTURES',
  'DAY_SETTLING',
  'GW_REVIEW',
  'FINALIZED',
];

/**
 * Drizzle raw SQL fragments are bound by postgres-js without the timestamp
 * encoder used for typed table values. Bind a canonical ISO string instead of
 * a Date whenever a timestamp is interpolated into sql``.
 */
export function postgresTimestampParameter(value: Date): string {
  if (!Number.isFinite(value.getTime())) {
    throw new Error('PostgreSQL timestamp parameter is invalid');
  }
  return value.toISOString();
}

function isLivePublicationState(value: unknown): value is LivePublicationState {
  return (
    typeof value === 'string' && LIVE_PUBLICATION_STATES.includes(value as LivePublicationState)
  );
}

export function livePublicationSeedClaimAllowsCheckpoint(
  persistedClaimId: string | null,
  requestedClaimId: string | undefined,
): boolean {
  return persistedClaimId === null
    ? requestedClaimId === undefined
    : requestedClaimId === persistedClaimId;
}

export function livePublicationSeedClaimMatchesPublication(
  claim: LivePublicationV2SeedClaim,
  publication: LivePublicationV2,
): boolean {
  return (
    claim.candidateState === publication.state &&
    claim.candidateSourceCheckedAt === publication.sourceCheckedAt &&
    claim.candidateEventLiveSha256 === publication.items.eventLive.sha256 &&
    claim.candidateFixturesSha256 === publication.items.fixtures.sha256
  );
}

export function livePublicationSeedClaimMatchesCandidate(
  claim: LivePublicationV2SeedClaim,
  candidate: LivePublicationV2SeedCandidate,
): boolean {
  return (
    claim.candidateState === candidate.candidateState &&
    claim.candidateSourceCheckedAt === candidate.candidateSourceCheckedAt &&
    claim.candidateEventLiveSha256 === candidate.candidateEventLiveSha256 &&
    claim.candidateFixturesSha256 === candidate.candidateFixturesSha256
  );
}

export async function readLivePublicationV2SeedClaim(
  season: FplSeasonRef,
  eventId: number,
): Promise<LivePublicationV2SeedClaim | null> {
  const db = await getDb();
  const row = (
    await db
      .select({
        claimId: livePointsPublicationSeedClaimsInCompetition.claimId,
        expectedActiveSha256: livePointsPublicationSeedClaimsInCompetition.expectedActiveSha256,
        candidateState: livePointsPublicationSeedClaimsInCompetition.candidateState,
        candidateSourceCheckedAt:
          livePointsPublicationSeedClaimsInCompetition.candidateSourceCheckedAt,
        candidateEventLiveSha256:
          livePointsPublicationSeedClaimsInCompetition.candidateEventLiveSha256,
        candidateFixturesSha256:
          livePointsPublicationSeedClaimsInCompetition.candidateFixturesSha256,
        claimedAt: livePointsPublicationSeedClaimsInCompetition.claimedAt,
      })
      .from(livePointsPublicationSeedClaimsInCompetition)
      .where(
        and(
          eq(livePointsPublicationSeedClaimsInCompetition.seasonId, season.seasonId),
          eq(livePointsPublicationSeedClaimsInCompetition.eventId, eventId),
        ),
      )
      .limit(1)
  )[0];
  return row
    ? {
        ...row,
        candidateState: row.candidateState as LivePublicationState,
        candidateSourceCheckedAt: row.candidateSourceCheckedAt.toISOString(),
        claimedAt: row.claimedAt.toISOString(),
      }
    : null;
}

/** Commit the seed's absence claim before any Redis pointer can change. */
export async function acquireLivePublicationV2SeedClaim(
  season: FplSeasonRef,
  eventId: number,
  expectedActiveSha256: string,
  candidate: LivePublicationV2SeedCandidate,
): Promise<
  | { readonly status: 'claimed'; readonly claim: LivePublicationV2SeedClaim }
  | { readonly status: 'durable'; readonly claim: null }
  | { readonly status: 'blocked'; readonly claim: null }
> {
  if (!/^[0-9a-f]{64}$/.test(expectedActiveSha256)) {
    throw new Error('Live Points V2 seed claim active hash is invalid');
  }
  if (
    !LIVE_PUBLICATION_STATES.includes(candidate.candidateState) ||
    !Number.isFinite(Date.parse(candidate.candidateSourceCheckedAt)) ||
    !/^[0-9a-f]{64}$/.test(candidate.candidateEventLiveSha256) ||
    !/^[0-9a-f]{64}$/.test(candidate.candidateFixturesSha256)
  ) {
    throw new Error('Live Points V2 seed claim candidate is invalid');
  }
  const db = await getDb();
  return db.transaction(async (tx) => {
    const scopeLock = `${season.seasonCode}:${eventId}`;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${scopeLock}, 0))`);
    const durable = await tx
      .select({ publicationId: livePointsPublicationCheckpointsInCompetition.publicationId })
      .from(livePointsPublicationCheckpointsInCompetition)
      .where(
        and(
          eq(livePointsPublicationCheckpointsInCompetition.seasonId, season.seasonId),
          eq(livePointsPublicationCheckpointsInCompetition.eventId, eventId),
        ),
      )
      .for('update')
      .limit(1);
    if (durable[0]) return { status: 'durable', claim: null } as const;

    const existing = await tx
      .select({
        claimId: livePointsPublicationSeedClaimsInCompetition.claimId,
        expectedActiveSha256: livePointsPublicationSeedClaimsInCompetition.expectedActiveSha256,
        candidateState: livePointsPublicationSeedClaimsInCompetition.candidateState,
        candidateSourceCheckedAt:
          livePointsPublicationSeedClaimsInCompetition.candidateSourceCheckedAt,
        candidateEventLiveSha256:
          livePointsPublicationSeedClaimsInCompetition.candidateEventLiveSha256,
        candidateFixturesSha256:
          livePointsPublicationSeedClaimsInCompetition.candidateFixturesSha256,
        claimedAt: livePointsPublicationSeedClaimsInCompetition.claimedAt,
      })
      .from(livePointsPublicationSeedClaimsInCompetition)
      .where(
        and(
          eq(livePointsPublicationSeedClaimsInCompetition.seasonId, season.seasonId),
          eq(livePointsPublicationSeedClaimsInCompetition.eventId, eventId),
        ),
      )
      .for('update')
      .limit(1);
    const prior = existing[0];
    if (prior) {
      const normalizedPrior: LivePublicationV2SeedClaim = {
        ...prior,
        candidateState: prior.candidateState as LivePublicationState,
        candidateSourceCheckedAt: prior.candidateSourceCheckedAt.toISOString(),
        claimedAt: prior.claimedAt.toISOString(),
      };
      if (
        prior.expectedActiveSha256 !== expectedActiveSha256 ||
        !livePublicationSeedClaimMatchesCandidate(normalizedPrior, candidate)
      ) {
        return { status: 'blocked', claim: null } as const;
      }

      // A retry may arrive after the previous owner abandoned the same claim.
      // Rotate the ownership token and renew the lease using PostgreSQL time;
      // an old owner can no longer checkpoint after this transaction commits.
      // Never share an unexpired token between executions: otherwise one
      // retry can release it after a failed Redis CAS while the original owner
      // is concurrently promoting the claimed candidate.
      const renewedClaimId = randomUUID();
      const renewed = (
        await tx
          .update(livePointsPublicationSeedClaimsInCompetition)
          .set({
            claimId: renewedClaimId,
            claimedAt: sql`clock_timestamp()`,
          })
          .where(
            and(
              eq(livePointsPublicationSeedClaimsInCompetition.seasonId, season.seasonId),
              eq(livePointsPublicationSeedClaimsInCompetition.eventId, eventId),
              eq(livePointsPublicationSeedClaimsInCompetition.claimId, prior.claimId),
              sql`${livePointsPublicationSeedClaimsInCompetition.claimedAt} <= clock_timestamp() - (${LIVE_PUBLICATION_SEED_CLAIM_LEASE_MS} * interval '1 millisecond')`,
            ),
          )
          .returning({ claimedAt: livePointsPublicationSeedClaimsInCompetition.claimedAt })
      )[0];
      if (!renewed) return { status: 'blocked', claim: null } as const;
      return {
        status: 'claimed',
        claim: {
          ...normalizedPrior,
          claimId: renewedClaimId,
          claimedAt: renewed.claimedAt.toISOString(),
        },
      } as const;
    }

    const claimId = randomUUID();
    const inserted = (
      await tx
        .insert(livePointsPublicationSeedClaimsInCompetition)
        .values({
          seasonId: season.seasonId,
          eventId,
          claimId,
          expectedActiveSha256,
          candidateState: candidate.candidateState,
          candidateSourceCheckedAt: new Date(candidate.candidateSourceCheckedAt),
          candidateEventLiveSha256: candidate.candidateEventLiveSha256,
          candidateFixturesSha256: candidate.candidateFixturesSha256,
        })
        .returning({ claimedAt: livePointsPublicationSeedClaimsInCompetition.claimedAt })
    )[0];
    if (!inserted) throw new Error('Live Points V2 seed claim insert returned no row');
    const claim: LivePublicationV2SeedClaim = {
      claimId,
      expectedActiveSha256,
      ...candidate,
      claimedAt: inserted.claimedAt.toISOString(),
    };
    return { status: 'claimed', claim } as const;
  });
}

export async function releaseLivePublicationV2SeedClaim(
  season: FplSeasonRef,
  eventId: number,
  claimId: string,
): Promise<boolean> {
  const db = await getDb();
  return db.transaction(async (tx) => {
    const scopeLock = `${season.seasonCode}:${eventId}`;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${scopeLock}, 0))`);
    const removed = await tx
      .delete(livePointsPublicationSeedClaimsInCompetition)
      .where(
        and(
          eq(livePointsPublicationSeedClaimsInCompetition.seasonId, season.seasonId),
          eq(livePointsPublicationSeedClaimsInCompetition.eventId, eventId),
          eq(livePointsPublicationSeedClaimsInCompetition.claimId, claimId),
        ),
      )
      .returning({ claimId: livePointsPublicationSeedClaimsInCompetition.claimId });
    return removed.length === 1;
  });
}

/**
 * Reclaim only an expired claim that still describes the exact active bytes
 * observed before its abandoned promotion and whose candidate no longer
 * matches this seed. The claim id is the ownership token; a delayed old owner
 * cannot checkpoint after this exact row is deleted.
 */
export async function reclaimAbandonedLivePublicationV2SeedClaim(
  season: FplSeasonRef,
  eventId: number,
  claimId: string,
  observedActiveSha256: string,
  candidate: LivePublicationV2SeedCandidate,
): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(observedActiveSha256)) {
    throw new Error('Live Points V2 abandoned claim active hash is invalid');
  }
  const candidateSourceCheckedAt = new Date(candidate.candidateSourceCheckedAt);
  if (!Number.isFinite(candidateSourceCheckedAt.getTime())) {
    throw new Error('Live Points V2 abandoned claim candidate timestamp is invalid');
  }
  const db = await getDb();
  return db.transaction(async (tx) => {
    const scopeLock = `${season.seasonCode}:${eventId}`;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${scopeLock}, 0))`);
    const removed = await tx
      .delete(livePointsPublicationSeedClaimsInCompetition)
      .where(
        and(
          eq(livePointsPublicationSeedClaimsInCompetition.seasonId, season.seasonId),
          eq(livePointsPublicationSeedClaimsInCompetition.eventId, eventId),
          eq(livePointsPublicationSeedClaimsInCompetition.claimId, claimId),
          eq(
            livePointsPublicationSeedClaimsInCompetition.expectedActiveSha256,
            observedActiveSha256,
          ),
          sql`${livePointsPublicationSeedClaimsInCompetition.claimedAt} <= clock_timestamp() - (${LIVE_PUBLICATION_SEED_CLAIM_LEASE_MS} * interval '1 millisecond')`,
          sql`${livePointsPublicationSeedClaimsInCompetition.candidateSourceCheckedAt} <= ${candidateSourceCheckedAt.toISOString()}::timestamptz`,
          sql`(${livePointsPublicationSeedClaimsInCompetition.candidateState} <> 'FINALIZED' OR ${candidate.candidateState} = 'FINALIZED')`,
          or(
            ne(
              livePointsPublicationSeedClaimsInCompetition.candidateState,
              candidate.candidateState,
            ),
            ne(
              livePointsPublicationSeedClaimsInCompetition.candidateSourceCheckedAt,
              candidateSourceCheckedAt,
            ),
            ne(
              livePointsPublicationSeedClaimsInCompetition.candidateEventLiveSha256,
              candidate.candidateEventLiveSha256,
            ),
            ne(
              livePointsPublicationSeedClaimsInCompetition.candidateFixturesSha256,
              candidate.candidateFixturesSha256,
            ),
          ),
        ),
      )
      .returning({ claimId: livePointsPublicationSeedClaimsInCompetition.claimId });
    return removed.length === 1;
  });
}

/**
 * Reclaim a claim whose candidate is already the Redis active publication but
 * whose owner abandoned the durable checkpoint, including a retry of the
 * same candidate.  The checkpoint transaction
 * takes this same scope lock before it can wait on the shared Core lock, so an
 * in-flight owner retains its exact claim even after the wall-clock lease has
 * elapsed.  PostgreSQL owns both the lease clock and the compare/delete.
 */
export async function reclaimAbandonedPromotedLivePublicationV2SeedClaim(
  season: FplSeasonRef,
  eventId: number,
  claimId: string,
  candidate: LivePublicationV2SeedCandidate,
): Promise<boolean> {
  const candidateSourceCheckedAt = new Date(candidate.candidateSourceCheckedAt);
  if (
    !LIVE_PUBLICATION_STATES.includes(candidate.candidateState) ||
    !Number.isFinite(candidateSourceCheckedAt.getTime()) ||
    !/^[0-9a-f]{64}$/.test(candidate.candidateEventLiveSha256) ||
    !/^[0-9a-f]{64}$/.test(candidate.candidateFixturesSha256)
  ) {
    throw new Error('Live Points V2 abandoned promoted claim candidate is invalid');
  }
  const db = await getDb();
  return db.transaction(async (tx) => {
    const scopeLock = `${season.seasonCode}:${eventId}`;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${scopeLock}, 0))`);
    const removed = await tx
      .delete(livePointsPublicationSeedClaimsInCompetition)
      .where(
        and(
          eq(livePointsPublicationSeedClaimsInCompetition.seasonId, season.seasonId),
          eq(livePointsPublicationSeedClaimsInCompetition.eventId, eventId),
          eq(livePointsPublicationSeedClaimsInCompetition.claimId, claimId),
          sql`${livePointsPublicationSeedClaimsInCompetition.claimedAt} <= clock_timestamp() - (${LIVE_PUBLICATION_SEED_CLAIM_LEASE_MS} * interval '1 millisecond')`,
          sql`${livePointsPublicationSeedClaimsInCompetition.candidateSourceCheckedAt} <= ${candidateSourceCheckedAt.toISOString()}::timestamptz`,
          sql`(${livePointsPublicationSeedClaimsInCompetition.candidateState} <> 'FINALIZED' OR ${candidate.candidateState} = 'FINALIZED')`,
        ),
      )
      .returning({ claimId: livePointsPublicationSeedClaimsInCompetition.claimId });
    return removed.length === 1;
  });
}

/**
 * PostgreSQL is the cold fallback only.  It returns the same complete
 * publication shape as Redis and validates the stored byte/hash/count proof
 * before exposing it to a caller.
 */
export async function readLivePublicationV2Checkpoint(
  season: FplSeasonRef,
  eventId: number,
): Promise<LivePublicationRead | null> {
  const db = await getDb();
  const row = (
    await db
      .select()
      .from(livePointsPublicationCheckpointsInCompetition)
      .where(
        and(
          eq(livePointsPublicationCheckpointsInCompetition.seasonId, season.seasonId),
          eq(livePointsPublicationCheckpointsInCompetition.eventId, eventId),
        ),
      )
      .limit(1)
  )[0];
  if (!row || !isLivePublicationState(row.state) || !Number.isSafeInteger(row.generation))
    return null;
  if (!Array.isArray(row.eventLive) || !Array.isArray(row.fixtures)) return null;

  const eventLivePayload = canonicalJson(row.eventLive);
  const fixturePayload = canonicalJson(row.fixtures);
  if (
    row.eventLiveCount !== row.eventLive.length ||
    row.fixturesCount !== row.fixtures.length ||
    row.eventLiveBytes !== Buffer.byteLength(eventLivePayload, 'utf8') ||
    row.fixturesBytes !== Buffer.byteLength(fixturePayload, 'utf8') ||
    row.eventLiveSha256 !== contentHash(row.eventLive) ||
    row.fixturesSha256 !== contentHash(row.fixtures)
  )
    return null;

  let fixtures: Fixture[];
  try {
    // PostgreSQL JSONB has the same wire shape as Redis JSON. Rehydrate the
    // date-bearing fixture fields before a checkpoint is handed to writers or
    // projection code.
    fixtures = validateSerializedFixtures(row.fixtures);
  } catch {
    return null;
  }

  const publication: LivePublicationV2 = {
    contractVersion: 'live-points-v2',
    publicationId: row.publicationId,
    generation: row.generation,
    season: season.seasonCode,
    eventId,
    state: row.state,
    sourceCheckedAt: row.sourceCheckedAt.toISOString(),
    publishedAt: row.publishedAt.toISOString(),
    checkpointedAt: row.checkpointedAt.toISOString(),
    expectedNextCheckAt: row.expectedNextCheckAt?.toISOString() ?? null,
    revisions: row.revisions as LivePublicationV2['revisions'],
    items: {
      eventLive: {
        name: 'eventLive',
        key: liveV2ItemKey({ season: season.seasonCode, eventId }, row.generation, 'eventLive'),
        type: 'string',
        count: row.eventLiveCount,
        bytes: row.eventLiveBytes,
        sha256: row.eventLiveSha256,
      },
      fixtures: {
        name: 'fixtures',
        key: liveV2ItemKey({ season: season.seasonCode, eventId }, row.generation, 'fixtures'),
        type: 'string',
        count: row.fixturesCount,
        bytes: row.fixturesBytes,
        sha256: row.fixturesSha256,
      },
    },
  };
  return {
    publication,
    eventLives: row.eventLive as LivePublicationRead['eventLives'],
    fixtures,
    servedFrom: 'POSTGRES_CHECKPOINT',
  };
}

/**
 * Return every terminal event whose Live Points, Match desk, Match detail, or
 * in-window league checkpoint is absent or not FINALIZED.
 *
 * The initial query is set-based and supplies the cheap state fence for every
 * terminal event. A row that looks FINALIZED at the column level still needs
 * the self-contained Match manifest/payload validation before it can be
 * excluded: database constraints protect shape, not the publication
 * checksum relationship used by the serving path.
 */
export async function findLivePublicationV2FinalizationTargets(
  season: FplSeasonRef,
): Promise<number[]> {
  const db = await getDb();
  const leagueFinalizationPending = sql<boolean>`
    EXISTS (
      SELECT 1
      FROM competition.tournaments AS league_tournament
      WHERE league_tournament.season_id = ${eventsInFpl.seasonId}
        AND league_tournament.state = 'active'
        AND league_tournament.setup_status = 'ready'
        AND (
          (
            league_tournament.league_type = 'classic'
            AND NOT EXISTS (
              SELECT 1
              FROM competition.live_league_checkpoints AS league_checkpoint
              WHERE league_checkpoint.season_id = ${eventsInFpl.seasonId}
                AND league_checkpoint.event_id = ${eventsInFpl.eventId}
                AND league_checkpoint.tournament_id = league_tournament.tournament_id
                AND league_checkpoint.scope_kind = 'CLASSIC'
                AND league_checkpoint.state = 'FINALIZED'
            )
            AND NOT EXISTS (
              SELECT 1
              FROM competition.tournament_entries AS final_roster
              WHERE final_roster.season_id = league_tournament.season_id
                AND final_roster.tournament_id = league_tournament.tournament_id
                AND EXISTS (
                  SELECT 1
                  FROM competition.entries AS final_entry
                  WHERE final_entry.season_id = final_roster.season_id
                    AND final_entry.entry_id = final_roster.entry_id
                    AND (final_entry.started_event IS NULL OR final_entry.started_event <= ${eventsInFpl.eventId})
                )
                AND NOT (
                  ${hasDurableFinalEntryInput(season.seasonCode, sql.raw('final_roster.entry_id'))}
                )
            )
          )
          OR (
            league_tournament.league_type = 'h2h'
            AND league_tournament.roster_mode = 'official_sync'
            AND league_tournament.group_mode = 'battle_races'
            AND (
              (
                league_tournament.group_started_event_id IS NULL
                AND league_tournament.group_ended_event_id IS NULL
                AND league_tournament.knockout_started_event_id IS NULL
                AND league_tournament.knockout_ended_event_id IS NULL
              )
              OR (
                league_tournament.group_started_event_id IS NOT NULL
                AND ${eventsInFpl.eventId} >= league_tournament.group_started_event_id
                AND (
                  league_tournament.group_ended_event_id IS NULL
                  OR ${eventsInFpl.eventId} <= league_tournament.group_ended_event_id
                )
              )
              OR (
                league_tournament.group_started_event_id IS NULL
                AND league_tournament.group_ended_event_id IS NOT NULL
                AND ${eventsInFpl.eventId} <= league_tournament.group_ended_event_id
              )
              OR (
                league_tournament.knockout_started_event_id IS NOT NULL
                AND ${eventsInFpl.eventId} >= league_tournament.knockout_started_event_id
                AND (
                  league_tournament.knockout_ended_event_id IS NULL
                  OR ${eventsInFpl.eventId} <= league_tournament.knockout_ended_event_id
                )
              )
              OR (
                league_tournament.knockout_started_event_id IS NULL
                AND league_tournament.knockout_ended_event_id IS NOT NULL
                AND ${eventsInFpl.eventId} <= league_tournament.knockout_ended_event_id
              )
            )
            AND (
              NOT EXISTS (
                SELECT 1
                FROM competition.live_league_checkpoints AS league_head_checkpoint
                WHERE league_head_checkpoint.season_id = ${eventsInFpl.seasonId}
                  AND league_head_checkpoint.event_id = ${eventsInFpl.eventId}
                  AND league_head_checkpoint.tournament_id = league_tournament.tournament_id
                  AND league_head_checkpoint.scope_kind = 'H2H_HEAD'
                  AND league_head_checkpoint.state = 'FINALIZED'
              )
              OR NOT EXISTS (
                SELECT 1
                FROM competition.live_league_checkpoints AS league_standings_checkpoint
                WHERE league_standings_checkpoint.season_id = ${eventsInFpl.seasonId}
                  AND league_standings_checkpoint.event_id = ${eventsInFpl.eventId}
                  AND league_standings_checkpoint.tournament_id = league_tournament.tournament_id
                AND league_standings_checkpoint.scope_kind = 'H2H_STANDINGS'
                AND league_standings_checkpoint.state = 'FINALIZED'
              )
            )
            AND NOT EXISTS (
              SELECT 1
              FROM (
                SELECT battle.home_entry_id AS entry_id
                FROM competition.tournament_battle_group_results AS battle
                WHERE battle.season_id = league_tournament.season_id
                  AND battle.tournament_id = league_tournament.tournament_id
                  AND battle.event_id = ${eventsInFpl.eventId}
                  AND battle.official_match_id IS NOT NULL
                UNION
                SELECT battle.away_entry_id AS entry_id
                FROM competition.tournament_battle_group_results AS battle
                WHERE battle.season_id = league_tournament.season_id
                  AND battle.tournament_id = league_tournament.tournament_id
                  AND battle.event_id = ${eventsInFpl.eventId}
                  AND battle.official_match_id IS NOT NULL
                UNION
                SELECT knockout.home_entry_id AS entry_id
                FROM competition.tournament_knockout_results AS knockout
                WHERE knockout.season_id = league_tournament.season_id
                  AND knockout.tournament_id = league_tournament.tournament_id
                  AND knockout.event_id = ${eventsInFpl.eventId}
                  AND knockout.official_match_id IS NOT NULL
                UNION
                SELECT knockout.away_entry_id AS entry_id
                FROM competition.tournament_knockout_results AS knockout
                WHERE knockout.season_id = league_tournament.season_id
                  AND knockout.tournament_id = league_tournament.tournament_id
                  AND knockout.event_id = ${eventsInFpl.eventId}
                  AND knockout.official_match_id IS NOT NULL
              ) AS final_h2h_entry
              WHERE final_h2h_entry.entry_id IS NOT NULL
                AND NOT (
                  ${hasDurableFinalEntryInput(season.seasonCode, sql.raw('final_h2h_entry.entry_id'))}
                )
            )
          )
        )
    )
  `.as('leagueFinalizationPending');
  const rows = await db
    .select({
      eventId: eventsInFpl.eventId,
      leagueFinalizationPending,
      livePointsState: livePointsPublicationCheckpointsInCompetition.state,
      deskState: liveMatchDeskCheckpointsInFpl.state,
      deskPublicationId: liveMatchDeskCheckpointsInFpl.publicationId,
      deskGeneration: liveMatchDeskCheckpointsInFpl.generation,
      deskPayloadSha256: liveMatchDeskCheckpointsInFpl.payloadSha256,
      deskRowCount: liveMatchDeskCheckpointsInFpl.rowCount,
      deskPayloadBytes: liveMatchDeskCheckpointsInFpl.payloadBytes,
      deskCheckpointedAt: liveMatchDeskCheckpointsInFpl.checkpointedAt,
      detailState: liveMatchDetailCheckpointsInFpl.state,
      detailPublicationId: liveMatchDetailCheckpointsInFpl.publicationId,
      detailGeneration: liveMatchDetailCheckpointsInFpl.generation,
      detailObservedDeskGeneration: liveMatchDetailCheckpointsInFpl.observedDeskGeneration,
      detailFixtureIdentityRevision: liveMatchDetailCheckpointsInFpl.fixtureIdentityRevision,
      detailPayloadSha256: liveMatchDetailCheckpointsInFpl.payloadSha256,
      detailRowCount: liveMatchDetailCheckpointsInFpl.rowCount,
      detailPayloadBytes: liveMatchDetailCheckpointsInFpl.payloadBytes,
      detailCheckpointedAt: liveMatchDetailCheckpointsInFpl.checkpointedAt,
    })
    .from(eventsInFpl)
    .leftJoin(
      livePointsPublicationCheckpointsInCompetition,
      and(
        eq(livePointsPublicationCheckpointsInCompetition.seasonId, eventsInFpl.seasonId),
        eq(livePointsPublicationCheckpointsInCompetition.eventId, eventsInFpl.eventId),
      ),
    )
    .leftJoin(
      liveMatchDeskCheckpointsInFpl,
      and(
        eq(liveMatchDeskCheckpointsInFpl.seasonId, eventsInFpl.seasonId),
        eq(liveMatchDeskCheckpointsInFpl.eventId, eventsInFpl.eventId),
      ),
    )
    .leftJoin(
      liveMatchDetailCheckpointsInFpl,
      and(
        eq(liveMatchDetailCheckpointsInFpl.seasonId, eventsInFpl.seasonId),
        eq(liveMatchDetailCheckpointsInFpl.eventId, eventsInFpl.eventId),
      ),
    )
    .where(
      and(
        eq(eventsInFpl.seasonId, season.seasonId),
        eq(eventsInFpl.finished, true),
        eq(eventsInFpl.dataChecked, true),
      ),
    )
    .orderBy(eventsInFpl.eventId);
  const targets: number[] = [];
  for (const row of rows) {
    if (
      row.leagueFinalizationPending ||
      row.livePointsState !== 'FINALIZED' ||
      row.deskState !== 'FINALIZED' ||
      row.detailState !== 'FINALIZED'
    ) {
      finalCheckpointValidationCache.delete(`${season.seasonId}:${row.eventId}`);
      targets.push(row.eventId);
      continue;
    }
    const key = `${season.seasonId}:${row.eventId}`;
    const identity: FinalCheckpointValidationIdentity = {
      deskPublicationId: row.deskPublicationId ?? null,
      deskGeneration: row.deskGeneration ?? null,
      deskPayloadSha256: row.deskPayloadSha256 ?? null,
      deskRowCount: row.deskRowCount ?? null,
      deskPayloadBytes: row.deskPayloadBytes ?? null,
      deskCheckpointedAt: checkpointDateIdentity(row.deskCheckpointedAt ?? null),
      detailPublicationId: row.detailPublicationId ?? null,
      detailGeneration: row.detailGeneration ?? null,
      detailObservedDeskGeneration: row.detailObservedDeskGeneration ?? null,
      detailFixtureIdentityRevision: row.detailFixtureIdentityRevision ?? null,
      detailPayloadSha256: row.detailPayloadSha256 ?? null,
      detailRowCount: row.detailRowCount ?? null,
      detailPayloadBytes: row.detailPayloadBytes ?? null,
      detailCheckpointedAt: checkpointDateIdentity(row.detailCheckpointedAt ?? null),
    };
    const cachedValidation = finalCheckpointValidationCache.get(key);
    if (
      cachedValidation &&
      sameFinalCheckpointValidationIdentity(cachedValidation.identity, identity) &&
      Date.now() - cachedValidation.validatedAtMs < LIVE_FINAL_CHECKPOINT_VALIDATION_RECHECK_MS
    ) {
      continue;
    }
    if (!(await hasFinalLiveMatchCheckpointsV3(season, row.eventId))) {
      finalCheckpointValidationCache.delete(key);
      targets.push(row.eventId);
      continue;
    }
    if (!(await hasFinalLiveLeagueCheckpointsV2(season, row.eventId))) {
      finalCheckpointValidationCache.delete(key);
      targets.push(row.eventId);
      continue;
    }
    rememberFinalCheckpointValidation(key, identity);
  }
  return targets;
}

/**
 * Checkpoint one complete Redis publication without making PostgreSQL part of
 * the serving path.  Upstream fetches and Redis promotion must already have
 * completed before this short transaction starts.
 */
export async function checkpointLivePublicationV2(
  request: LivePublicationV2CheckpointRequest,
): Promise<boolean> {
  const { season, eventId, publication, eventLives, fixtures, explains, fixtureEvidence } = request;
  if (
    publication.season !== season.seasonCode ||
    publication.eventId !== eventId ||
    publication.state === undefined
  ) {
    throw new Error('Live Points V2 checkpoint scope does not match publication');
  }
  if (publication.items.eventLive.count !== eventLives.length) {
    throw new Error('Live Points V2 event-live checkpoint count does not match manifest');
  }
  if (publication.items.fixtures.count !== fixtures.length) {
    throw new Error('Live Points V2 fixture checkpoint count does not match manifest');
  }
  if (
    explains.some((row) => row.eventId !== eventId) ||
    fixtureEvidence.some((row) => row.eventId !== eventId)
  ) {
    throw new Error('Live Points V2 checkpoint facts contain another event');
  }

  const eventLivePayload = canonicalJson(eventLives);
  const fixturePayload = canonicalJson(fixtures);
  const eventLiveBytes = Buffer.byteLength(eventLivePayload, 'utf8');
  const fixtureBytes = Buffer.byteLength(fixturePayload, 'utf8');
  if (
    eventLiveBytes !== publication.items.eventLive.bytes ||
    fixtureBytes !== publication.items.fixtures.bytes ||
    contentHash(eventLives) !== publication.items.eventLive.sha256 ||
    contentHash(fixtures) !== publication.items.fixtures.sha256
  ) {
    throw new Error('Live Points V2 checkpoint payload failed manifest validation');
  }

  const sourceCheckedAt = new Date(publication.sourceCheckedAt);
  const observationCheckedAt =
    request.observationCheckedAt instanceof Date
      ? new Date(request.observationCheckedAt.getTime())
      : request.observationCheckedAt === undefined
        ? new Date(sourceCheckedAt.getTime())
        : new Date(request.observationCheckedAt);
  if (
    !Number.isFinite(sourceCheckedAt.getTime()) ||
    !Number.isFinite(observationCheckedAt.getTime())
  ) {
    throw new Error('Live Points V2 checkpoint source timestamp is invalid');
  }
  const db = await getDb();
  return db
    .transaction(async (tx) => {
      const scopeLock = `${season.seasonCode}:${eventId}`;
      // Claim ownership and generation/final ordering are scope-local. Take
      // this lock first so an already-started checkpoint cannot lose its claim
      // merely because it waits on the shared Core publication lock.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${scopeLock}, 0))`);
      // Core publication writes use this same lock before touching events or
      // fixtures. Scope -> Core is safe because Core-only writers never wait
      // for a live scope lock, and it keeps the source fence and mutations in
      // one ordering domain.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${CORE_SNAPSHOT_WRITE_LOCK_KEY})`);
      // publishedAt comes from Redis TIME. checkpointedAt is deliberately
      // obtained from the same PostgreSQL clock that owns the durable row;
      // never compare or synthesize the durable timestamp from an app host.
      const clockRows = await tx.execute<{ checkpointed_at: Date | string }>(
        sql`SELECT clock_timestamp() AS checkpointed_at`,
      );
      const checkpointedAt = new Date(String(clockRows[0]?.checkpointed_at ?? ''));
      if (!Number.isFinite(checkpointedAt.getTime())) {
        throw new Error('PostgreSQL did not return a valid checkpoint clock timestamp');
      }
      const observationCheckedAtParameter = postgresTimestampParameter(observationCheckedAt);
      const checkpointedAtParameter = postgresTimestampParameter(checkpointedAt);
      const seedClaims = await tx
        .select({
          claimId: livePointsPublicationSeedClaimsInCompetition.claimId,
          expectedActiveSha256: livePointsPublicationSeedClaimsInCompetition.expectedActiveSha256,
          candidateState: livePointsPublicationSeedClaimsInCompetition.candidateState,
          candidateSourceCheckedAt:
            livePointsPublicationSeedClaimsInCompetition.candidateSourceCheckedAt,
          candidateEventLiveSha256:
            livePointsPublicationSeedClaimsInCompetition.candidateEventLiveSha256,
          candidateFixturesSha256:
            livePointsPublicationSeedClaimsInCompetition.candidateFixturesSha256,
          claimedAt: livePointsPublicationSeedClaimsInCompetition.claimedAt,
        })
        .from(livePointsPublicationSeedClaimsInCompetition)
        .where(
          and(
            eq(livePointsPublicationSeedClaimsInCompetition.seasonId, season.seasonId),
            eq(livePointsPublicationSeedClaimsInCompetition.eventId, eventId),
          ),
        )
        .for('update')
        .limit(1);
      const seedClaimId = seedClaims[0]?.claimId ?? null;
      const seedClaim = seedClaims[0]
        ? ({
            ...seedClaims[0],
            candidateState: seedClaims[0].candidateState as LivePublicationState,
            candidateSourceCheckedAt: seedClaims[0].candidateSourceCheckedAt.toISOString(),
            claimedAt: seedClaims[0].claimedAt.toISOString(),
          } satisfies LivePublicationV2SeedClaim)
        : null;
      if (
        !livePublicationSeedClaimAllowsCheckpoint(seedClaimId, request.seedClaimId) ||
        (seedClaim !== null && !livePublicationSeedClaimMatchesPublication(seedClaim, publication))
      ) {
        return false;
      }
      const [eventAuthority] = await tx
        .select({ liveSnapshotCheckedAt: eventsInFpl.liveSnapshotCheckedAt })
        .from(eventsInFpl)
        .where(and(eq(eventsInFpl.seasonId, season.seasonId), eq(eventsInFpl.eventId, eventId)))
        .for('update')
        .limit(1);
      if (
        eventAuthority?.liveSnapshotCheckedAt &&
        eventAuthority.liveSnapshotCheckedAt.getTime() > observationCheckedAt.getTime()
      ) {
        // A newer Core transaction already owns the canonical fixture state.
        // Reject the older live publication as a whole; otherwise its fixture
        // upsert could move a finished fixture back to started even though the
        // event freshness marker remains newer.
        return false;
      }
      const existing = await tx
        .select({
          publicationId: livePointsPublicationCheckpointsInCompetition.publicationId,
          generation: livePointsPublicationCheckpointsInCompetition.generation,
          state: livePointsPublicationCheckpointsInCompetition.state,
        })
        .from(livePointsPublicationCheckpointsInCompetition)
        .where(
          and(
            eq(livePointsPublicationCheckpointsInCompetition.seasonId, season.seasonId),
            eq(livePointsPublicationCheckpointsInCompetition.eventId, eventId),
          ),
        )
        .for('update')
        .limit(1);
      const winner = existing[0];
      if (request.requireMissingCheckpoint && winner) {
        return false;
      }
      if (
        winner &&
        winner.publicationId !== publication.publicationId &&
        (winner.state === 'FINALIZED' || winner.generation >= publication.generation)
      ) {
        return false;
      }

      await tx
        .insert(livePointsPublicationCheckpointsInCompetition)
        .values({
          seasonId: season.seasonId,
          eventId,
          publicationId: publication.publicationId,
          generation: publication.generation,
          state: publication.state,
          sourceCheckedAt,
          publishedAt: new Date(publication.publishedAt),
          checkpointedAt,
          expectedNextCheckAt: publication.expectedNextCheckAt
            ? new Date(publication.expectedNextCheckAt)
            : null,
          revisions: publication.revisions,
          eventLive: eventLives,
          fixtures,
          eventLiveBytes,
          fixturesBytes: fixtureBytes,
          eventLiveSha256: publication.items.eventLive.sha256,
          fixturesSha256: publication.items.fixtures.sha256,
          eventLiveCount: eventLives.length,
          fixturesCount: fixtures.length,
        })
        .onConflictDoUpdate({
          target: [
            livePointsPublicationCheckpointsInCompetition.seasonId,
            livePointsPublicationCheckpointsInCompetition.eventId,
          ],
          set: {
            publicationId: sql`excluded.publication_id`,
            generation: sql`excluded.generation`,
            state: sql`excluded.state`,
            sourceCheckedAt: sql`excluded.source_checked_at`,
            publishedAt: sql`excluded.published_at`,
            checkpointedAt: sql`excluded.checkpointed_at`,
            expectedNextCheckAt: sql`excluded.expected_next_check_at`,
            revisions: sql`excluded.revisions`,
            eventLive: sql`excluded.event_live`,
            fixtures: sql`excluded.fixtures`,
            eventLiveBytes: sql`excluded.event_live_bytes`,
            fixturesBytes: sql`excluded.fixtures_bytes`,
            eventLiveSha256: sql`excluded.event_live_sha256`,
            fixturesSha256: sql`excluded.fixtures_sha256`,
            eventLiveCount: sql`excluded.event_live_count`,
            fixturesCount: sql`excluded.fixtures_count`,
          },
        });

      // A V2 checkpoint is also the successful coherent-source observation for
      // the canonical FPL tables. Keep event lives, explains, fixture evidence,
      // fixture rows, and freshness markers in the same short transaction as the
      // checkpoint head so recovery cannot expose a durable publication while
      // core reconciliation still points at an older fact set.
      const savedLives = await createEventLiveRepository(tx).upsertBatch(season, [...eventLives]);
      if (savedLives.length !== eventLives.length) {
        throw new Error(
          `Incomplete event live checkpoint: expected ${eventLives.length}, persisted ${savedLives.length}`,
        );
      }
      await createEventLiveExplainsRepository(tx).replaceEvent(season, [...explains]);
      await createFplPlayerFixtureStatsRepository(tx).upsertEvidence(season, [...fixtureEvidence]);
      await createFixtureRepository(tx).upsertBatch(season, [...fixtures]);
      // Keep the checked/finalized timestamps in one UPDATE. A finalized event
      // may already have a historical finalized timestamp that is older than a
      // late source observation. Updating checked first would violate
      // events_finalization_order and roll back the otherwise complete
      // checkpoint before the finalization repair can run.
      const checkedAt =
        publication.state === 'FINALIZED'
          ? sql`
              GREATEST(
                COALESCE(${eventsInFpl.liveSnapshotCheckedAt}, ${observationCheckedAtParameter}::timestamptz),
                ${observationCheckedAtParameter}::timestamptz
              )
            `
          : sql`
              CASE
                WHEN ${eventsInFpl.liveSnapshotFinalizedAt} IS NOT NULL
                  THEN ${eventsInFpl.liveSnapshotCheckedAt}
                ELSE GREATEST(
                  COALESCE(${eventsInFpl.liveSnapshotCheckedAt}, ${observationCheckedAtParameter}::timestamptz),
                  ${observationCheckedAtParameter}::timestamptz
                )
              END
            `;
      await tx
        .update(eventsInFpl)
        .set({
          liveSnapshotCheckedAt: checkedAt,
          liveFactsPersistedAt: checkpointedAt,
          updatedAt: checkpointedAt,
          ...(publication.state === 'FINALIZED'
            ? {
                liveSnapshotFinalizedAt: sql`
                  GREATEST(
                    COALESCE(${eventsInFpl.liveSnapshotFinalizedAt}, ${checkpointedAtParameter}::timestamptz),
                    COALESCE(${eventsInFpl.liveSnapshotCheckedAt}, ${observationCheckedAtParameter}::timestamptz),
                    ${observationCheckedAtParameter}::timestamptz
                  )
                `,
              }
            : {}),
        })
        .where(and(eq(eventsInFpl.seasonId, season.seasonId), eq(eventsInFpl.eventId, eventId)));
      if (request.seedClaimId) {
        const removedClaims = await tx
          .delete(livePointsPublicationSeedClaimsInCompetition)
          .where(
            and(
              eq(livePointsPublicationSeedClaimsInCompetition.seasonId, season.seasonId),
              eq(livePointsPublicationSeedClaimsInCompetition.eventId, eventId),
              eq(livePointsPublicationSeedClaimsInCompetition.claimId, request.seedClaimId),
            ),
          )
          .returning({ claimId: livePointsPublicationSeedClaimsInCompetition.claimId });
        if (removedClaims.length !== 1) {
          throw new Error('Live Points V2 seed claim disappeared before checkpoint commit');
        }
      }
      return true;
    })
    .then(async (committed) => {
      if (committed) {
        // The reporting projection is deliberately refreshed only after the
        // authoritative transaction commits. Its failure must not invalidate a
        // Redis-first publication; the bounded repair lane can retry it.
        try {
          await refreshPlayerSeasonSummaries(season);
        } catch (error) {
          logError('Player season summary refresh failed after V2 checkpoint', error, {
            season: season.seasonCode,
            eventId,
          });
        }
      }
      return committed;
    });
}
