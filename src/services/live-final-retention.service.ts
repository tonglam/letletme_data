import type Redis from 'ioredis';
import type { DbEntryEventResult } from '../db/schemas/platform.types';

import {
  entryLiveV2ItemKey,
  entryLiveV2Key,
  liveV2Key,
  readEntryLiveInputV2,
  readLivePublicationV2Pointer,
  renewEntryLiveInputV2FinalLease,
  publishEntryLiveInputV2,
  renewLivePublicationV2FinalLease,
  restoreEntryLiveInputV2Checkpoint,
  restoreLivePublicationV2Checkpoint,
  setEntryCheckpointDesiredV2,
  validateEntryLiveInputV2,
  type EntryLiveInputV2,
  type EntryLivePublicationV2,
  type LivePublicationV2,
} from '../cache/live-publication-v2';
import {
  liveMatchDeskKey,
  liveMatchDetailKey,
  liveMatchDetailManifestKey,
  readLiveMatchDeskPointerV3,
  readLiveMatchDetailPointerV3,
  renewLiveMatchDeskFinalLeaseV3,
  renewLiveMatchDetailFinalLeaseV3,
  restoreLiveMatchDeskCheckpointV3,
  restoreLiveMatchDetailCheckpointV3,
  type MatchDeskPublication,
  type MatchDetailPublication,
} from '../cache/live-match-publication-v3';
import {
  liveLeagueV2Key,
  readLiveLeaguePublicationV2Pointer,
  renewLiveLeagueFinalLeaseV2,
  restoreLiveLeaguePublicationV2Checkpoint,
  type LeagueLiveRead,
  type LeagueLiveScope,
} from '../cache/live-league-publication-v2';
import { redisSingleton } from '../cache/singleton';
import type { FplSeasonRef } from '../domain/fpl-season';
import { eventRepository } from '../repositories/events';
import { entryEventResultsRepository } from '../repositories/entry-event-results';
import {
  entryEventPicksRepository,
  type EntryEventPickHeadMetadata,
} from '../repositories/entry-event-picks';
import {
  listRequiredLiveLeagueFinalCheckpointScopesV2,
  readLiveLeagueCheckpointV2,
} from './live-league-checkpoint-v2.service';
import { readLivePublicationV2Checkpoint } from './live-publication-v2-checkpoint.service';
import {
  readLiveMatchDeskCheckpointV3,
  readLiveMatchDetailCheckpointV3,
} from './live-match-v3-checkpoint.service';
import { syncLiveH2HLeaguePublicationsV2 } from './live-league-publication-v2.service';
import { canonicalJson, contentHash } from '../utils/content-hash';
import { mapWithConcurrency } from '../utils/async';
import { logError, logInfo } from '../utils/logger';
import {
  buildFinalEntryLiveInputFromBaseAndResult,
  checkpointEntryLiveInputV2,
  entryLiveFinalResultCheckpointHash,
  entryLivePicksBaseCheckpointHash,
} from './entries.service';

export const LIVE_FINAL_RETENTION_INTERVAL_MS = 6 * 60 * 60_000;
export const LIVE_FINAL_RETENTION_THRESHOLD_MS = 24 * 60 * 60_000;
export const LIVE_FINAL_RETENTION_TTL_MS = 48 * 60 * 60_000;
export const LIVE_FINAL_RETENTION_ENTRY_PAGE_SIZE = 250;
export const LIVE_FINAL_RETENTION_ENTRY_CONCURRENCY = 2;

export type LiveFinalRetentionFamilyStats = {
  checked: number;
  renewed: number;
  restored: number;
  failed: number;
  minRemainingTtlMs: number | null;
};

export type LiveFinalRetentionResult = {
  schemaVersion: 'live-final-retention-v1';
  eventId: number;
  checkedAt: string;
  status: 'succeeded' | 'failed';
  complete: boolean;
  requiredArtifacts: number;
  failed: number;
  minRemainingTtlMs: number | null;
  families: {
    global: LiveFinalRetentionFamilyStats;
    matchDesk: LiveFinalRetentionFamilyStats;
    matchDetail: LiveFinalRetentionFamilyStats;
    entry: LiveFinalRetentionFamilyStats;
    league: LiveFinalRetentionFamilyStats;
  };
};

/**
 * A final retention run remains a durable failed/irrecoverable scheduler
 * outcome, but its bounded completion evidence must survive the failure path
 * for `/jobs/status` and operator reconciliation.
 */
export class LiveFinalRetentionIncompleteError extends Error {
  readonly evidence: Record<string, unknown>;

  constructor(result: LiveFinalRetentionResult) {
    super(
      `Live final retention did not complete for event ${result.eventId}: failed=${result.failed} minTtlMs=${result.minRemainingTtlMs ?? 'null'}`,
    );
    this.name = 'LiveFinalRetentionIncompleteError';
    this.evidence = liveFinalRetentionCompletionEvidence(result);
  }
}

/** Keep scheduler completion evidence small and free of publication payloads. */
export function liveFinalRetentionCompletionEvidence(
  result: LiveFinalRetentionResult,
): Record<string, unknown> {
  return {
    schemaVersion: result.schemaVersion,
    eventId: result.eventId,
    checkedAt: result.checkedAt,
    status: result.status,
    complete: result.complete,
    requiredArtifacts: result.requiredArtifacts,
    failed: result.failed,
    minRemainingTtlMs: result.minRemainingTtlMs,
    families: result.families,
  };
}

type MutableFamilyStats = LiveFinalRetentionFamilyStats;

const emptyFamily = (): MutableFamilyStats => ({
  checked: 0,
  renewed: 0,
  restored: 0,
  failed: 0,
  minRemainingTtlMs: null,
});

function updateMinimum(family: MutableFamilyStats, ttlMs: number | null): void {
  if (ttlMs === null || !Number.isFinite(ttlMs)) return;
  family.minRemainingTtlMs =
    family.minRemainingTtlMs === null ? ttlMs : Math.min(family.minRemainingTtlMs, ttlMs);
}

async function minimumTtl(redis: Redis, keys: readonly string[]): Promise<number | null> {
  if (keys.length === 0) return null;
  const values = await Promise.all(keys.map((key) => redis.pttl(key)));
  return values.length === 0 ? null : Math.min(...values);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pointerIdentity(
  raw: string,
  scope: {
    season: string;
    eventId: number;
    entryId?: number;
    tournamentId?: number;
    scope?: string;
    matchId?: number;
  },
): {
  contractVersion: unknown;
  publicationId: string;
  generation: number;
  state: unknown;
  finalized: unknown;
  scopeMatches: boolean;
} | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value)) return null;
    if (
      typeof value.publicationId !== 'string' ||
      typeof value.generation !== 'number' ||
      !Number.isSafeInteger(value.generation) ||
      value.generation <= 0
    ) {
      return null;
    }
    return {
      contractVersion: value.contractVersion,
      publicationId: value.publicationId,
      generation: value.generation,
      state: value.state,
      finalized: value.finalized,
      scopeMatches:
        value.season === scope.season &&
        value.eventId === scope.eventId &&
        (scope.entryId === undefined || value.entryId === scope.entryId) &&
        (scope.tournamentId === undefined || value.tournamentId === scope.tournamentId) &&
        (scope.scope === undefined || value.scope === scope.scope) &&
        (scope.matchId === undefined || value.matchId === scope.matchId),
    };
  } catch {
    return null;
  }
}

function validFinalEntryInput(
  value: unknown,
  season: string,
  eventId: number,
  entryId: number,
): value is EntryLiveInputV2 {
  if (
    !validateEntryLiveInputV2(value, { season, eventId, entryId }) ||
    value.finalResult === null ||
    !isRecord(value.finalResult) ||
    !isRecord(value.finalResult.score) ||
    !Number.isSafeInteger(value.finalResult.score.eventPoints) ||
    (value.finalResult.score.totalPoints !== null &&
      !Number.isSafeInteger(value.finalResult.score.totalPoints)) ||
    !Array.isArray(value.finalResult.picks) ||
    value.finalResult.picks.length !== 15 ||
    !Array.isArray(value.finalResult.automaticSubs)
  ) {
    return false;
  }
  return true;
}

function entryPublicationFromHead(
  season: FplSeasonRef,
  eventId: number,
  head: EntryEventPickHeadMetadata,
  input: EntryLiveInputV2,
  existing: EntryLivePublicationV2 | null,
): EntryLivePublicationV2 | null {
  const entryId = head.entryId;
  if (
    !Number.isSafeInteger(entryId) ||
    entryId <= 0 ||
    !/^[0-9a-f-]{36}$/i.test(head.publicationId) ||
    !Number.isSafeInteger(head.generation) ||
    head.generation <= 0 ||
    head.state !== 'COMPLETE'
  ) {
    return null;
  }
  const payload = canonicalJson(input);
  return {
    contractVersion: 'live-points-v2',
    publicationId: head.publicationId,
    generation: head.generation,
    season: season.seasonCode,
    eventId,
    entryId,
    state: 'FINAL',
    sourceCheckedAt: head.sourceCheckedAt.toISOString(),
    // entry_event_pick_heads predates the publication-time column. Preserve a
    // surviving Redis timestamp when available; a cold head uses its durable
    // checkpoint clock as the only available publication boundary.
    publishedAt: existing?.publishedAt ?? head.checkpointedAt.toISOString(),
    checkpointedAt: head.checkpointedAt.toISOString(),
    expectedNextCheckAt: existing?.expectedNextCheckAt ?? null,
    item: {
      name: 'input',
      key: entryLiveV2ItemKey({ season: season.seasonCode, eventId, entryId }, head.generation),
      type: 'string',
      count: input.picksBase.picks.length,
      bytes: Buffer.byteLength(payload, 'utf8'),
      sha256: contentHash(input),
    },
  };
}

export function finalPublicationConflict(
  raw: string,
  expected: { publicationId: string; generation: number },
  scope: {
    season: string;
    eventId: number;
    entryId?: number;
    tournamentId?: number;
    scope?: string;
    matchId?: number;
  },
  marker: {
    contractVersion: string;
    state?: string;
    finalized?: boolean;
    /**
     * Entry FINAL retention may promote an exact same-generation provisional
     * pointer.  The Lua CAS still fences any identity change or FINAL conflict.
     */
    allowProvisionalSameIdentity?: boolean;
  },
): boolean {
  const identity = pointerIdentity(raw, scope);
  if (!identity) return false;
  if (identity.contractVersion !== marker.contractVersion || !identity.scopeMatches) return true;
  const sameIdentity =
    identity.publicationId === expected.publicationId &&
    identity.generation === expected.generation;
  if (
    marker.allowProvisionalSameIdentity &&
    marker.state === 'FINAL' &&
    identity.state === 'PROVISIONAL' &&
    sameIdentity
  ) {
    return false;
  }
  const isFinal =
    marker.state !== undefined
      ? identity.state === marker.state
      : identity.finalized === marker.finalized;
  return !isFinal || !sameIdentity;
}

async function processGlobal(
  season: FplSeasonRef,
  eventId: number,
  redis: Redis,
  family: MutableFamilyStats,
): Promise<LivePublicationV2 | null> {
  family.checked += 1;
  const checkpoint = await readLivePublicationV2Checkpoint(season, eventId);
  if (!checkpoint || checkpoint.publication.state !== 'FINALIZED') {
    family.failed += 1;
    return null;
  }
  const scope = { season: season.seasonCode, eventId } as const;
  const activeRaw = (await redis.get(liveV2Key(scope, 'active'))) ?? '';
  const active = await readLivePublicationV2Pointer(scope, 'active', redis);
  if (
    finalPublicationConflict(activeRaw, checkpoint.publication, scope, {
      contractVersion: 'live-points-v2',
      state: 'FINALIZED',
    }) ||
    (active &&
      (active.publication.publicationId !== checkpoint.publication.publicationId ||
        active.publication.generation !== checkpoint.publication.generation))
  ) {
    family.failed += 1;
    return null;
  }
  if (
    active?.publication.publicationId === checkpoint.publication.publicationId &&
    active.publication.generation === checkpoint.publication.generation &&
    active.publication.state === 'FINALIZED'
  ) {
    const ttl = await minimumTtl(redis, [
      liveV2Key(scope, 'active'),
      active.publication.items.eventLive.key,
      `${active.publication.items.eventLive.key}:meta`,
      active.publication.items.fixtures.key,
      `${active.publication.items.fixtures.key}:meta`,
    ]);
    if (ttl !== null && ttl > LIVE_FINAL_RETENTION_THRESHOLD_MS) {
      updateMinimum(family, ttl);
      return active.publication;
    }
    const renewed = await renewLivePublicationV2FinalLease({
      publication: active.publication,
      observedRaw: activeRaw,
      redis,
    });
    if (renewed.status !== 'renewed') {
      updateMinimum(family, ttl);
      family.failed += 1;
      return null;
    }
    family.renewed += 1;
    updateMinimum(family, renewed.ttlMs);
    return active.publication;
  }
  try {
    await restoreLivePublicationV2Checkpoint({ checkpoint, redis });
    family.restored += 1;
    const restored = await readLivePublicationV2Pointer(scope, 'active', redis);
    if (
      !restored ||
      restored.publication.publicationId !== checkpoint.publication.publicationId ||
      restored.publication.generation !== checkpoint.publication.generation ||
      restored.publication.state !== 'FINALIZED'
    ) {
      family.failed += 1;
      return null;
    }
    updateMinimum(
      family,
      await minimumTtl(redis, [
        liveV2Key(scope, 'active'),
        restored.publication.items.eventLive.key,
        `${restored.publication.items.eventLive.key}:meta`,
        restored.publication.items.fixtures.key,
        `${restored.publication.items.fixtures.key}:meta`,
      ]),
    );
    return restored.publication;
  } catch (error) {
    family.failed += 1;
    logError('Live final retention global restore failed', error, {
      season: season.seasonCode,
      eventId,
    });
    return null;
  }
}

async function processMatchDesk(
  season: FplSeasonRef,
  eventId: number,
  redis: Redis,
  family: MutableFamilyStats,
): Promise<MatchDeskPublication | null> {
  family.checked += 1;
  const checkpoint = await readLiveMatchDeskCheckpointV3(season, eventId);
  if (!checkpoint || checkpoint.publication.state !== 'FINALIZED') {
    family.failed += 1;
    return null;
  }
  const scope = { season: season.seasonCode, eventId } as const;
  const activeRaw = (await redis.get(liveMatchDeskKey(scope, 'active'))) ?? '';
  const active = await readLiveMatchDeskPointerV3({ ...scope, redis }, 'active');
  if (
    finalPublicationConflict(activeRaw, checkpoint.publication, scope, {
      contractVersion: 'live-matches-v3',
      state: 'FINALIZED',
    }) ||
    (active &&
      (active.publication.publicationId !== checkpoint.publication.publicationId ||
        active.publication.generation !== checkpoint.publication.generation))
  ) {
    family.failed += 1;
    return null;
  }
  const keys = (publication: MatchDeskPublication) => [
    liveMatchDeskKey(scope, 'active'),
    publication.desk.key,
    `${publication.desk.key}:meta`,
  ];
  if (
    active?.publication.publicationId === checkpoint.publication.publicationId &&
    active.publication.generation === checkpoint.publication.generation &&
    active.publication.state === 'FINALIZED'
  ) {
    const ttl = await minimumTtl(redis, keys(active.publication));
    if (ttl !== null && ttl > LIVE_FINAL_RETENTION_THRESHOLD_MS) {
      updateMinimum(family, ttl);
      return active.publication;
    }
    const renewed = await renewLiveMatchDeskFinalLeaseV3({
      publication: active.publication,
      observedRaw: activeRaw,
      redis,
    });
    if (renewed.status !== 'renewed') {
      updateMinimum(family, ttl);
      family.failed += 1;
      return null;
    }
    family.renewed += 1;
    updateMinimum(family, renewed.ttlMs);
    return active.publication;
  }
  try {
    const restored = await restoreLiveMatchDeskCheckpointV3({
      checkpoint,
      redis,
      promoteActiveEvent: true,
    });
    family.restored += 1;
    updateMinimum(family, await minimumTtl(redis, keys(restored.publication)));
    return restored.publication;
  } catch (error) {
    family.failed += 1;
    logError('Live final retention Match desk restore failed', error, {
      season: season.seasonCode,
      eventId,
    });
    return null;
  }
}

async function processMatchDetail(
  season: FplSeasonRef,
  eventId: number,
  redis: Redis,
  desk: MatchDeskPublication | null,
  family: MutableFamilyStats,
): Promise<MatchDetailPublication | null> {
  family.checked += 1;
  const checkpoint = await readLiveMatchDetailCheckpointV3(season, eventId);
  if (!checkpoint || !checkpoint.publication.finalized || !desk) {
    family.failed += 1;
    return null;
  }
  if (checkpoint.publication.observedDeskGeneration !== desk.generation) {
    family.failed += 1;
    return null;
  }
  const scope = { season: season.seasonCode, eventId } as const;
  const activeRaw = (await redis.get(liveMatchDetailKey(scope, 'active'))) ?? '';
  const active = await readLiveMatchDetailPointerV3({ ...scope, redis }, 'active');
  if (
    finalPublicationConflict(activeRaw, checkpoint.publication, scope, {
      contractVersion: 'live-matches-v3',
      finalized: true,
    }) ||
    (active &&
      (active.publication.publicationId !== checkpoint.publication.publicationId ||
        active.publication.generation !== checkpoint.publication.generation))
  ) {
    family.failed += 1;
    return null;
  }
  const keys = (publication: MatchDetailPublication) => [
    liveMatchDetailKey(scope, 'active'),
    liveMatchDetailManifestKey(scope, publication.generation),
    ...publication.fixtures.flatMap((item) => [item.key, `${item.key}:meta`]),
  ];
  if (
    active?.publication.publicationId === checkpoint.publication.publicationId &&
    active.publication.generation === checkpoint.publication.generation &&
    active.publication.finalized
  ) {
    const ttl = await minimumTtl(redis, keys(active.publication));
    if (ttl !== null && ttl > LIVE_FINAL_RETENTION_THRESHOLD_MS) {
      updateMinimum(family, ttl);
      return active.publication;
    }
    const renewed = await renewLiveMatchDetailFinalLeaseV3({
      publication: active.publication,
      observedRaw: activeRaw,
      redis,
    });
    if (renewed.status !== 'renewed') {
      updateMinimum(family, ttl);
      family.failed += 1;
      return null;
    }
    family.renewed += 1;
    updateMinimum(family, renewed.ttlMs);
    return active.publication;
  }
  try {
    const restored = await restoreLiveMatchDetailCheckpointV3({ checkpoint, redis });
    family.restored += 1;
    updateMinimum(family, await minimumTtl(redis, keys(restored.publication)));
    return restored.publication;
  } catch (error) {
    family.failed += 1;
    logError('Live final retention Match detail restore failed', error, {
      season: season.seasonCode,
      eventId,
    });
    return null;
  }
}

async function processEntryHead(
  season: FplSeasonRef,
  eventId: number,
  dataCheckedAt: Date,
  head: EntryEventPickHeadMetadata,
  durableResult: DbEntryEventResult | undefined,
  redis: Redis,
  family: MutableFamilyStats,
): Promise<void> {
  family.checked += 1;
  const entryId = head.entryId;
  if (
    !Number.isSafeInteger(entryId) ||
    entryId <= 0 ||
    head.state !== 'COMPLETE' ||
    head.rowCount !== 15 ||
    !/^[0-9a-f]{64}$/.test(head.picksBaseRevision) ||
    !/^[0-9a-f]{64}$/.test(head.contentSha256) ||
    !Number.isFinite(head.sourceCheckedAt.getTime()) ||
    !Number.isFinite(head.contentUpdatedAt.getTime()) ||
    !Number.isFinite(head.checkpointedAt.getTime()) ||
    (head.inputPayload !== null &&
      !validFinalEntryInput(head.inputPayload, season.seasonCode, eventId, entryId))
  ) {
    family.failed += 1;
    return;
  }
  const scope = { season: season.seasonCode, eventId, entryId } as const;
  const existing = await readEntryLiveInputV2(scope, redis);

  // A null durable input payload is recoverable only from the exact active
  // Redis provisional publication and a complete persisted final result.  No
  // provider request or guessed previous totals are allowed on this path.
  if (head.inputPayload === null) {
    const current = existing;
    if (
      !current ||
      !durableResult ||
      durableResult.entryId !== entryId ||
      durableResult.eventId !== eventId ||
      current.servedFrom !== 'REDIS_CURRENT' ||
      current.publication.publicationId !== head.publicationId ||
      current.publication.generation !== head.generation ||
      current.publication.state !== 'PROVISIONAL' ||
      current.input.finalResult !== null ||
      current.input.picksBase.revision !== head.picksBaseRevision ||
      current.input.picksBase.picks.length !== 15
    ) {
      family.failed += 1;
      return;
    }
    const durableHeadBeforeRecovery = await entryEventPicksRepository.findHead(
      season,
      entryId,
      eventId,
    );
    if (
      !durableHeadBeforeRecovery ||
      durableHeadBeforeRecovery.publicationId !== head.publicationId ||
      durableHeadBeforeRecovery.generation !== head.generation ||
      durableHeadBeforeRecovery.picksBaseRevision !== head.picksBaseRevision ||
      durableHeadBeforeRecovery.contentSha256 !== head.contentSha256 ||
      durableHeadBeforeRecovery.rowCount !== 15 ||
      durableHeadBeforeRecovery.sourceCheckedAt.getTime() !== head.sourceCheckedAt.getTime() ||
      durableHeadBeforeRecovery.contentUpdatedAt.getTime() !== head.contentUpdatedAt.getTime() ||
      durableHeadBeforeRecovery.checkpointedAt.getTime() !== head.checkpointedAt.getTime() ||
      durableHeadBeforeRecovery.inputPayload !== null ||
      durableHeadBeforeRecovery.state !== 'COMPLETE'
    ) {
      family.failed += 1;
      return;
    }
    const finalInput = buildFinalEntryLiveInputFromBaseAndResult(
      current.input,
      durableResult,
      dataCheckedAt,
    );
    // picksBase.revision identifies the deadline-time input. contentSha256
    // independently identifies the durable rows, whose multipliers may have
    // changed at finalization. Never compare those two granular identities.
    if (
      !finalInput ||
      entryLiveFinalResultCheckpointHash(finalInput) !== head.contentSha256 ||
      !durableResult.richSyncedAt
    ) {
      family.failed += 1;
      return;
    }
    try {
      const published = await publishEntryLiveInputV2({
        season: season.seasonCode,
        eventId,
        entryId,
        input: finalInput,
        sourceCheckedAt: durableResult.richSyncedAt,
        generationFloor: head.generation,
        redis,
      });
      if (!published.published || published.publication.state !== 'FINAL') {
        family.failed += 1;
        return;
      }
      await setEntryCheckpointDesiredV2(published.publication, new Date(), redis);
      if ((await checkpointEntryLiveInputV2(season, eventId, entryId, redis)) !== 'checkpointed') {
        family.failed += 1;
        return;
      }
      const durableAfter = await entryEventPicksRepository.findHead(season, entryId, eventId);
      if (
        !durableAfter ||
        durableAfter.publicationId !== published.publication.publicationId ||
        durableAfter.generation !== published.publication.generation ||
        durableAfter.picksBaseRevision !== finalInput.picksBase.revision ||
        durableAfter.inputPayload === null ||
        durableAfter.contentSha256 !== entryLivePicksBaseCheckpointHash(finalInput) ||
        !validFinalEntryInput(durableAfter.inputPayload, season.seasonCode, eventId, entryId) ||
        contentHash(durableAfter.inputPayload) !== contentHash(finalInput)
      ) {
        family.failed += 1;
        return;
      }
      family.restored += 1;
      updateMinimum(
        family,
        await minimumTtl(redis, [
          entryLiveV2Key(scope, 'active'),
          published.publication.item.key,
          `${published.publication.item.key}:meta`,
        ]),
      );
    } catch (error) {
      family.failed += 1;
      logError('Live final retention entry final recovery failed', error, {
        season: season.seasonCode,
        eventId,
        entryId,
      });
    }
    return;
  }

  // Re-read the durable head immediately before any TTL/renewal decision.  A
  // newer generation or changed payload must fence this pass rather than
  // allowing a stale page read to renew an unrelated publication.
  const durableHead = await entryEventPicksRepository.findHead(season, entryId, eventId);
  if (
    !durableHead ||
    durableHead.publicationId !== head.publicationId ||
    durableHead.generation !== head.generation ||
    durableHead.picksBaseRevision !== head.picksBaseRevision ||
    durableHead.contentSha256 !== head.contentSha256 ||
    durableHead.sourceCheckedAt.getTime() !== head.sourceCheckedAt.getTime() ||
    durableHead.contentUpdatedAt.getTime() !== head.contentUpdatedAt.getTime() ||
    durableHead.checkpointedAt.getTime() !== head.checkpointedAt.getTime() ||
    durableHead.state !== 'COMPLETE' ||
    durableHead.inputPayload === null ||
    !validFinalEntryInput(durableHead.inputPayload, season.seasonCode, eventId, entryId) ||
    entryLivePicksBaseCheckpointHash(durableHead.inputPayload) !== durableHead.contentSha256
  ) {
    family.failed += 1;
    return;
  }
  const durableInput = durableHead.inputPayload;
  const publication = entryPublicationFromHead(
    season,
    eventId,
    durableHead,
    durableInput,
    existing?.publication.publicationId === head.publicationId &&
      existing.publication.generation === head.generation
      ? existing.publication
      : null,
  );
  if (!publication) {
    family.failed += 1;
    return;
  }
  const activeRaw = (await redis.get(entryLiveV2Key(scope, 'active'))) ?? '';
  const active = existing?.servedFrom === 'REDIS_CURRENT' ? existing : null;
  if (
    finalPublicationConflict(activeRaw, publication, scope, {
      contractVersion: 'live-points-v2',
      state: 'FINAL',
      allowProvisionalSameIdentity: true,
    }) ||
    (active &&
      (active.publication.publicationId !== publication.publicationId ||
        active.publication.generation !== publication.generation))
  ) {
    family.failed += 1;
    return;
  }
  const keys = (candidate: EntryLivePublicationV2) => [
    entryLiveV2Key(scope, 'active'),
    candidate.item.key,
    `${candidate.item.key}:meta`,
  ];
  if (
    active &&
    active.publication.publicationId === publication.publicationId &&
    active.publication.generation === publication.generation &&
    active.publication.state === 'FINAL' &&
    validFinalEntryInput(active.input, season.seasonCode, eventId, entryId)
  ) {
    const ttl = await minimumTtl(redis, keys(active.publication));
    if (ttl !== null && ttl > LIVE_FINAL_RETENTION_THRESHOLD_MS) {
      updateMinimum(family, ttl);
      return;
    }
    const renewed = await renewEntryLiveInputV2FinalLease({
      publication: active.publication,
      observedRaw: activeRaw,
      redis,
    });
    if (renewed.status !== 'renewed') {
      updateMinimum(family, ttl);
      family.failed += 1;
      return;
    }
    family.renewed += 1;
    updateMinimum(family, renewed.ttlMs);
    return;
  }
  try {
    await restoreEntryLiveInputV2Checkpoint({
      publication,
      liveInput: durableInput,
      redis,
    });
    family.restored += 1;
    updateMinimum(family, await minimumTtl(redis, keys(publication)));
  } catch (error) {
    family.failed += 1;
    logError('Live final retention entry restore failed', error, {
      season: season.seasonCode,
      eventId,
      entryId,
    });
  }
}

async function scanH2HMatchScopes(
  season: string,
  eventId: number,
  redis: Redis,
): Promise<LeagueLiveScope[]> {
  const pattern = `llm:data:v2:fpl:league-live:${season}:${eventId}:*:h2h-match-*:active`;
  const scopes = new Map<string, LeagueLiveScope>();
  let cursor = '0';
  do {
    const result = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', '200');
    cursor = result[0];
    for (const key of result[1]) {
      const match = new RegExp(
        `^llm:data:v2:fpl:league-live:${season}:${eventId}:([1-9][0-9]*):h2h-match-([1-9][0-9]*):active$`,
      ).exec(key);
      if (!match) continue;
      const tournamentId = Number(match[1]);
      const matchId = Number(match[2]);
      if (!Number.isSafeInteger(tournamentId) || !Number.isSafeInteger(matchId)) continue;
      const scope = { season, eventId, tournamentId, scope: 'H2H_MATCH' as const, matchId };
      scopes.set(`${tournamentId}:${matchId}`, scope);
    }
  } while (cursor !== '0');
  return [...scopes.values()].sort(
    (left, right) =>
      left.tournamentId - right.tournamentId || (left.matchId ?? 0) - (right.matchId ?? 0),
  );
}

async function processLeagueScope(
  scope: LeagueLiveScope,
  checkpoint: LeagueLiveRead,
  global: LivePublicationV2 | null,
  redis: Redis,
  family: MutableFamilyStats,
): Promise<boolean> {
  family.checked += 1;
  if (
    !global ||
    checkpoint.publication.state !== 'FINALIZED' ||
    checkpoint.publication.globalRef.publicationId !== global.publicationId ||
    checkpoint.publication.globalRef.generation !== global.generation
  ) {
    family.failed += 1;
    return false;
  }
  const activeRaw = (await redis.get(liveLeagueV2Key(scope, 'active'))) ?? '';
  const active = await readLiveLeaguePublicationV2Pointer(scope, 'active', redis);
  if (
    finalPublicationConflict(activeRaw, checkpoint.publication, scope, {
      contractVersion: 'live-points-v2',
      state: 'FINALIZED',
    }) ||
    (active &&
      (active.publication.publicationId !== checkpoint.publication.publicationId ||
        active.publication.generation !== checkpoint.publication.generation))
  ) {
    family.failed += 1;
    return false;
  }
  const keys = (candidate: LeagueLiveRead) => [
    liveLeagueV2Key(scope, 'active'),
    candidate.publication.items.index.key,
    `${candidate.publication.items.index.key}:meta`,
    candidate.publication.items.payload.key,
    `${candidate.publication.items.payload.key}:meta`,
  ];
  if (
    active &&
    active.publication.publicationId === checkpoint.publication.publicationId &&
    active.publication.generation === checkpoint.publication.generation &&
    active.publication.state === 'FINALIZED'
  ) {
    const ttl = await minimumTtl(redis, keys(active));
    if (ttl !== null && ttl > LIVE_FINAL_RETENTION_THRESHOLD_MS) {
      updateMinimum(family, ttl);
      return true;
    }
    const renewed = await renewLiveLeagueFinalLeaseV2({
      publication: active.publication,
      observedRaw: activeRaw,
      redis,
    });
    if (renewed.status !== 'renewed') {
      updateMinimum(family, ttl);
      family.failed += 1;
      return false;
    }
    family.renewed += 1;
    updateMinimum(family, renewed.ttlMs);
    return true;
  }
  try {
    await restoreLiveLeaguePublicationV2Checkpoint({ checkpoint, redis });
    family.restored += 1;
    updateMinimum(family, await minimumTtl(redis, keys(checkpoint)));
    return true;
  } catch (error) {
    family.failed += 1;
    logError('Live final retention league restore failed', error, {
      season: scope.season,
      eventId: scope.eventId,
      tournamentId: scope.tournamentId,
      scope: scope.scope,
    });
    return false;
  }
}

async function processH2HMatchScope(
  scope: LeagueLiveScope,
  global: LivePublicationV2 | null,
  redis: Redis,
  family: MutableFamilyStats,
): Promise<'ready' | 'missing' | 'failed'> {
  family.checked += 1;
  if (!global) {
    family.failed += 1;
    return 'failed';
  }
  const activeRaw = (await redis.get(liveLeagueV2Key(scope, 'active'))) ?? '';
  const active = await readLiveLeaguePublicationV2Pointer(scope, 'active', redis);
  if (!active) return 'missing';
  if (
    active.publication.state !== 'FINALIZED' ||
    active.publication.globalRef.publicationId !== global.publicationId ||
    active.publication.globalRef.generation !== global.generation
  ) {
    family.failed += 1;
    return 'failed';
  }
  const keys = [
    liveLeagueV2Key(scope, 'active'),
    active.publication.items.index.key,
    `${active.publication.items.index.key}:meta`,
    active.publication.items.payload.key,
    `${active.publication.items.payload.key}:meta`,
  ];
  const ttl = await minimumTtl(redis, keys);
  if (ttl !== null && ttl > LIVE_FINAL_RETENTION_THRESHOLD_MS) {
    updateMinimum(family, ttl);
    return 'ready';
  }
  const renewed = await renewLiveLeagueFinalLeaseV2({
    publication: active.publication,
    observedRaw: activeRaw,
    redis,
  });
  if (renewed.status !== 'renewed') {
    updateMinimum(family, ttl);
    family.failed += 1;
    return 'failed';
  }
  family.renewed += 1;
  updateMinimum(family, renewed.ttlMs);
  return 'ready';
}

function h2hMatchScopesFromCheckpoint(
  checkpoint: LeagueLiveRead,
  existing: readonly LeagueLiveScope[],
): LeagueLiveScope[] {
  if (checkpoint.publication.scope !== 'H2H_HEAD') return [...existing];
  const discovered = new Map(
    existing.map((scope) => [`${scope.tournamentId}:${scope.matchId}`, scope]),
  );
  for (const row of checkpoint.index) {
    if (!isRecord(row)) continue;
    const candidate = row as Record<string, unknown>;
    if (typeof candidate.matchId !== 'number' || !Number.isSafeInteger(candidate.matchId)) {
      continue;
    }
    const scope = {
      season: checkpoint.publication.season,
      eventId: checkpoint.publication.eventId,
      tournamentId: checkpoint.publication.tournamentId,
      scope: 'H2H_MATCH' as const,
      matchId: candidate.matchId,
    };
    discovered.set(`${scope.tournamentId}:${scope.matchId}`, scope);
  }
  return [...discovered.values()];
}

/** Execute the bounded current-event final publication retention pass. */
export async function runLiveFinalRetentionV2(
  season: FplSeasonRef,
  eventId: number,
  redisClient?: Redis,
): Promise<LiveFinalRetentionResult> {
  const event = await eventRepository.findById(season, eventId);
  const current = await eventRepository.findCurrent(season);
  if (!event || !current || current.id !== eventId) {
    throw new Error(`Live final retention event ${eventId} is no longer current`);
  }
  if (!event.finished || !event.dataChecked) {
    throw new Error(`Live final retention event ${eventId} is not finished and data checked`);
  }
  if (!event.dataCheckedAt || !Number.isFinite(event.dataCheckedAt.getTime())) {
    throw new Error(`Live final retention event ${eventId} has no valid data_checked timestamp`);
  }
  const redis = redisClient ?? (await redisSingleton.getClient());
  const families = {
    global: emptyFamily(),
    matchDesk: emptyFamily(),
    matchDetail: emptyFamily(),
    entry: emptyFamily(),
    league: emptyFamily(),
  };

  const global = await processGlobal(season, eventId, redis, families.global);
  const desk = await processMatchDesk(season, eventId, redis, families.matchDesk);
  await processMatchDetail(season, eventId, redis, desk, families.matchDetail);

  let cursor = 0;
  while (true) {
    const page = await entryEventPicksRepository.listHeadsByEvent(
      season,
      eventId,
      cursor,
      LIVE_FINAL_RETENTION_ENTRY_PAGE_SIZE,
    );
    if (page.length === 0) break;
    const durableResults = await entryEventResultsRepository.findByEventAndEntryIds(
      season,
      eventId,
      page.map((head) => head.entryId),
    );
    const resultByEntry = new Map(
      durableResults.map((result) => [result.entryId, result] as const),
    );
    await mapWithConcurrency(page, LIVE_FINAL_RETENTION_ENTRY_CONCURRENCY, async (head) =>
      processEntryHead(
        season,
        eventId,
        event.dataCheckedAt!,
        head,
        resultByEntry.get(head.entryId),
        redis,
        families.entry,
      ),
    );
    const nextCursor = Math.max(...page.map((head) => head.entryId));
    if (!Number.isSafeInteger(nextCursor) || nextCursor <= cursor) {
      throw new Error(`Live final retention entry cursor stalled at ${cursor}`);
    }
    cursor = nextCursor;
    if (page.length < LIVE_FINAL_RETENTION_ENTRY_PAGE_SIZE) break;
  }

  const requiredScopes = await listRequiredLiveLeagueFinalCheckpointScopesV2(season, eventId);
  const leagueCheckpoints = await mapWithConcurrency(requiredScopes, 8, async (scope) => ({
    scope,
    checkpoint: await readLiveLeagueCheckpointV2(scope),
  }));
  let h2hMatchScopes = await scanH2HMatchScopes(season.seasonCode, eventId, redis);
  for (const item of leagueCheckpoints) {
    if (item.checkpoint) {
      h2hMatchScopes = h2hMatchScopesFromCheckpoint(item.checkpoint, h2hMatchScopes);
    }
  }
  for (const item of leagueCheckpoints) {
    if (!item.checkpoint) {
      families.league.checked += 1;
      families.league.failed += 1;
      continue;
    }
    await processLeagueScope(item.scope, item.checkpoint, global, redis, families.league);
  }

  const missingH2HMatches: LeagueLiveScope[] = [];
  await mapWithConcurrency(h2hMatchScopes, 8, async (scope) => {
    const result = await processH2HMatchScope(scope, global, redis, families.league);
    if (result === 'missing') missingH2HMatches.push(scope);
  });
  if (missingH2HMatches.length > 0) {
    // H2H_MATCH deliberately has no database checkpoint. Recompute only when
    // the canonical head proves that a match scope should exist; unchanged
    // existing scopes use the TTL-only path above.
    try {
      await syncLiveH2HLeaguePublicationsV2(season, eventId);
      for (const scope of missingH2HMatches) {
        const read = await readLiveLeaguePublicationV2Pointer(scope, 'active', redis);
        if (
          read?.publication.state === 'FINALIZED' &&
          global &&
          read.publication.globalRef.publicationId === global.publicationId &&
          read.publication.globalRef.generation === global.generation
        ) {
          families.league.restored += 1;
          updateMinimum(
            families.league,
            await minimumTtl(redis, [
              liveLeagueV2Key(scope, 'active'),
              read.publication.items.index.key,
              `${read.publication.items.index.key}:meta`,
              read.publication.items.payload.key,
              `${read.publication.items.payload.key}:meta`,
            ]),
          );
        } else {
          families.league.failed += 1;
        }
      }
    } catch (error) {
      families.league.failed += missingH2HMatches.length;
      logError('Live final retention H2H match recompute failed', error, {
        season: season.seasonCode,
        eventId,
        scopes: missingH2HMatches.length,
      });
    }
  }

  const familyValues = Object.values(families);
  const requiredArtifacts = familyValues.reduce((total, family) => total + family.checked, 0);
  const failed = familyValues.reduce((total, family) => total + family.failed, 0);
  const ttlValues = familyValues
    .map((family) => family.minRemainingTtlMs)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  const minRemainingTtlMs = ttlValues.length > 0 ? Math.min(...ttlValues) : null;
  const complete =
    requiredArtifacts > 0 &&
    failed === 0 &&
    minRemainingTtlMs !== null &&
    minRemainingTtlMs > LIVE_FINAL_RETENTION_THRESHOLD_MS;
  const result: LiveFinalRetentionResult = {
    schemaVersion: 'live-final-retention-v1',
    eventId,
    checkedAt: new Date().toISOString(),
    status: complete ? 'succeeded' : 'failed',
    complete,
    requiredArtifacts,
    failed,
    minRemainingTtlMs,
    families,
  };
  logInfo('Live final retention pass completed', {
    season: season.seasonCode,
    eventId,
    status: result.status,
    requiredArtifacts,
    failed,
    minRemainingTtlMs,
  });
  return result;
}
