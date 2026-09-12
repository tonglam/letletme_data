import { fplClient } from '../clients/fpl';
import type Redis from 'ioredis';
import { readDatabaseOrderingTimestamp } from '../db/ordering-timestamp';
import type { DbEntryEventResult } from '../db/schemas/platform.types';
import {
  createEntryEventPicksRepository,
  entryEventPicksRepository,
  type EntryEventPickHeadMetadata,
  type EntryLiveInputPickRow,
} from '../repositories/entry-event-picks';
import {
  entryEventTransfersRepository,
  withEntrySeasonSyncTransaction,
} from '../repositories/entry-event-transfers';
import {
  createEntryEventResultsRepository,
  type EventPointsPayload,
} from '../repositories/entry-event-results';
import { eventRepository } from '../repositories/events';
import { entryInfoRepository } from '../repositories/entry-infos';
import { isCompleteEntryPicks, isEntryPicksPayloadForEvent } from '../domain/entry-picks';
import { isFreshnessBoundaryNewer } from '../domain/freshness';
import { assistantManagerPointsFactFromProviderObservation } from '../domain/event-live-manager-points';
import type { FplSeasonRef } from '../domain/fpl-season';
import { contentHash } from '../utils/content-hash';
import { CacheError } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';
import { withMutationScopes } from '../utils/mutation-scopes';
import type { RawFPLEntryEventPicksResponse } from '../types';
import {
  clearEntryCheckpointDesiredV2,
  entryLiveInputFromFplPicks,
  isEntryPublicationActiveAndCheckpointedV2,
  markEntryPublicationCheckpointedV2,
  publishEntryLiveFinalResultV2,
  publishEntryLiveInputV2,
  readEntryCheckpointDesiredV2,
  readEntryLiveInputV2,
  readEntryLiveInputsV2,
  validateEntryLiveInputV2,
  readLivePublicationV2,
  setEntryCheckpointDesiredV2,
  type AssistantManagerPointsFact,
  type EntryLiveInputV2,
  type EntryLivePublicationV2,
  type Exactly15Picks,
  type OfficialSubstitution,
} from '../cache/live-publication-v2';

/**
 * Source checks carry a heartbeat timestamp, but a heartbeat is not a new
 * live-points input revision.  Keep the timestamp out of content identity so
 * repeated FPL reads cannot create a new Redis generation or rewrite the same
 * fifteen PostgreSQL rows.
 */
function entryLiveInputContentHash(input: EntryLiveInputV2): string {
  return contentHash({
    picksBase: {
      revision: input.picksBase.revision,
      picks: input.picksBase.picks,
      chip: input.picksBase.chip,
      reportedEventPoints: input.picksBase.reportedEventPoints ?? null,
      assistantManagerPoints: input.picksBase.assistantManagerPoints ?? null,
      transferCount: input.picksBase.transferCount,
      transferCost: input.picksBase.transferCost,
    },
    previousTotals: input.previousTotals,
    officialAdjustment: input.officialAdjustment,
    finalResult: input.finalResult,
  });
}

function entryLivePicksBaseContentHash(input: EntryLiveInputV2): string {
  return contentHash({
    revision: input.picksBase.revision,
    picks: input.picksBase.picks,
    chip: input.picksBase.chip,
    reportedEventPoints: input.picksBase.reportedEventPoints ?? null,
    assistantManagerPoints: input.picksBase.assistantManagerPoints ?? null,
    transferCount: input.picksBase.transferCount,
    transferCost: input.picksBase.transferCost,
  });
}

/** Hash of the deadline-time picks stored by a complete semantic checkpoint. */
export function entryLivePicksBaseCheckpointHash(input: EntryLiveInputV2): string {
  return contentHash({
    picks: input.picksBase.picks.map((pick) => ({
      element: pick.element,
      position: pick.position,
      multiplier: pick.multiplier,
      isCaptain: pick.isCaptain,
      isViceCaptain: pick.isViceCaptain,
    })),
    chip: input.picksBase.chip,
    transferCount: input.picksBase.transferCount,
    transferCost: input.picksBase.transferCost,
  });
}

/** Hash of the finalized pick rows, kept separate from picksBase.revision. */
export function entryLiveFinalResultCheckpointHash(input: EntryLiveInputV2): string | null {
  if (input.finalResult === null) return null;
  return contentHash({
    picks: input.finalResult.picks.map((pick) => ({
      element: pick.element,
      position: pick.position,
      multiplier: pick.multiplier,
      isCaptain: pick.isCaptain,
      isViceCaptain: pick.isViceCaptain,
    })),
    chip: input.picksBase.chip,
    transferCount: input.picksBase.transferCount,
    transferCost: input.picksBase.transferCost,
  });
}

type LiveObservation = NonNullable<Awaited<ReturnType<typeof readLivePublicationV2>>>;

function sameLiveScoreObservation(left: LiveObservation, right: LiveObservation): boolean {
  return (
    left.publication.publicationId === right.publication.publicationId &&
    left.publication.generation === right.publication.generation &&
    left.publication.revisions.scoreCore.revision === right.publication.revisions.scoreCore.revision
  );
}

/**
 * The V2 Redis input is sufficient to rebuild the durable pick rowset.  The
 * fields not represented by the V2 contract are deliberately neutral because
 * they are not part of the live projection; no provider request is needed for
 * a PostgreSQL retry after Redis has already published the input.
 */
function rawPicksFromEntryLiveInput(input: EntryLiveInputV2): RawFPLEntryEventPicksResponse {
  return {
    active_chip: input.picksBase.chip,
    automatic_subs: [],
    entry_history: {
      event: input.eventId,
      points: input.picksBase.reportedEventPoints ?? 0,
      total_points: 0,
      rank: null,
      overall_rank: null,
      bank: 0,
      value: 0,
      event_transfers: input.picksBase.transferCount,
      event_transfers_cost: input.picksBase.transferCost,
      points_on_bench: 0,
    },
    picks: input.picksBase.picks.map((pick) => ({
      element: pick.element,
      position: pick.position,
      multiplier: pick.multiplier,
      is_captain: pick.isCaptain,
      is_vice_captain: pick.isViceCaptain,
    })),
  };
}

/**
 * Complete one Redis-first entry publication without going back to FPL.  The
 * desired checkpoint is a control-plane obligation, not a second publication;
 * a newer current publication supersedes an older desired pointer by CAS.
 */
export async function checkpointEntryLiveInputV2(
  season: FplSeasonRef,
  eventId: number,
  entryId: number,
  redisClient?: Redis,
): Promise<'checkpointed' | 'missing'> {
  const scope = { season: season.seasonCode, eventId, entryId } as const;
  let desired = await readEntryCheckpointDesiredV2(scope, redisClient);
  const candidate = await readEntryLiveInputV2(scope, redisClient);
  if (!candidate) return 'missing';

  // The reader may fall back to the previous publication for serving a
  // coherent read, but a checkpoint is a write obligation for the active
  // generation only. Never reconstruct or persist an older fallback.
  if (candidate.servedFrom !== 'REDIS_CURRENT') return 'missing';

  // A successful checkpoint clears the desired pointer after the Redis
  // manifest has been fenced to the exact durable head.  Audits can therefore
  // legitimately observe an active publication with no pending obligation.
  // Treat that marker as an idempotent success instead of re-writing every
  // already durable entry (or reporting a false missing input).
  if (!desired && candidate.publication.checkpointedAt !== null) {
    return (await isEntryPublicationActiveAndCheckpointedV2(candidate.publication, redisClient))
      ? 'checkpointed'
      : 'missing';
  }
  // A provider write can publish before its asynchronous durable checkpoint
  // obligation is visible to this worker. Re-create the obligation from the
  // one active candidate so the normal generation/identity checks and
  // PostgreSQL fence below can complete the exact publication.
  if (!desired)
    desired = await setEntryCheckpointDesiredV2(candidate.publication, new Date(), redisClient);

  if (candidate.publication.generation < desired.generation) return 'missing';
  if (
    candidate.publication.generation === desired.generation &&
    candidate.publication.publicationId !== desired.publicationId
  ) {
    return 'missing';
  }
  if (candidate.publication.generation > desired.generation) {
    desired = await setEntryCheckpointDesiredV2(candidate.publication, new Date(), redisClient);
  }

  const sourceCheckedAt = candidate.publication.sourceCheckedAt;
  if (!Number.isFinite(new Date(sourceCheckedAt).getTime())) return 'missing';
  const checkpointedAt = new Date();
  const picks = rawPicksFromEntryLiveInput(candidate.input);
  await withMutationScopes(
    {
      queueName: 'entry-sync',
      jobName: 'entry-picks',
      eventId,
      scopes: [`entry-event-picks:event:${eventId}`],
    },
    () =>
      withEntrySeasonSyncTransaction(season, entryId, async (tx) => {
        await createEntryEventPicksRepository(tx).upsertFromPicks(
          season,
          entryId,
          eventId,
          picks,
          sourceCheckedAt,
          {
            publicationId: candidate.publication.publicationId,
            generation: candidate.publication.generation,
            picksBaseRevision: candidate.input.picksBase.revision,
            inputPayload: candidate.input,
            contentUpdatedAt: candidate.input.picksBase.contentUpdatedAt,
            checkpointedAt,
          },
        );
      }),
  );
  // The repository deliberately reports no-op writes as successful at the
  // transaction boundary. Re-read the durable head after commit and fence the
  // Redis checkpoint marker on the exact publication identity; otherwise a
  // rejected stale/conflicting write could be advertised as checkpointed.
  const durableHead = await entryEventPicksRepository.findHead(season, entryId, eventId);
  if (
    durableHead === null ||
    durableHead.rowCount !== 15 ||
    durableHead.state !== 'COMPLETE' ||
    durableHead.publicationId !== candidate.publication.publicationId ||
    durableHead.generation !== candidate.publication.generation ||
    durableHead.picksBaseRevision !== candidate.input.picksBase.revision
  ) {
    return 'missing';
  }
  const marked = await markEntryPublicationCheckpointedV2(
    candidate.publication,
    checkpointedAt,
    redisClient,
  );
  if (marked === null) return 'missing';
  await clearEntryCheckpointDesiredV2(desired, redisClient);
  return 'checkpointed';
}

async function ensureEntryLiveCheckpoint(
  season: FplSeasonRef,
  eventId: number,
  entryId: number,
  publication: EntryLivePublicationV2,
  existingDesired: Awaited<ReturnType<typeof readEntryCheckpointDesiredV2>>,
): Promise<void> {
  try {
    // Redis publication is the serving boundary. Do not synchronously wait
    // for PostgreSQL in the provider lane; the scheduler/reconciler consumes
    // this one exact obligation and checkpoints the latest visible input.
    if (
      existingDesired === null ||
      existingDesired.publicationId !== publication.publicationId ||
      existingDesired.generation !== publication.generation
    ) {
      await setEntryCheckpointDesiredV2(publication);
    }
  } catch (error) {
    // Redis publication is already authoritative. A failed obligation write
    // is recoverable from the current publication on the next scheduler pass;
    // it must not erase the live input or force the provider lane to refetch it.
    logError('Entry live V2 checkpoint obligation deferred after Redis publication', error, {
      season: season.seasonCode,
      eventId,
      entryId,
      publicationId: publication.publicationId,
      generation: publication.generation,
    });
  }
}

export async function persistEntryEventPicksResponse(
  season: FplSeasonRef,
  entryId: number,
  eventId: number,
  picks: RawFPLEntryEventPicksResponse,
  syncedAt?: Date | string,
  options?: {
    readonly liveObservation?: LiveObservation | null;
    /** Provider event-live response sharing the picks capture boundary. */
    readonly providerEventLive?: EventPointsPayload | null;
    /** Historical FINAL recovery may use a verified durable global observation. */
    readonly historicalFinalBoundary?: Date | string;
    /** Preserve canonical deadline picks while taking reported facts from this provider response. */
    readonly preservedPicksBase?: RawFPLEntryEventPicksResponse;
  },
) {
  // The live provider lane must not wait for PostgreSQL merely to obtain a
  // timestamp. When the caller has no source boundary, capture completion
  // time locally; the durable checkpoint records its own completion time.
  const sourceCheckedAt = syncedAt ? new Date(syncedAt) : new Date();
  if (!Number.isFinite(sourceCheckedAt.getTime())) {
    throw new Error('A valid entry picks source timestamp is required');
  }
  if (!isEntryPicksPayloadForEvent(picks, eventId)) {
    throw new Error(
      `Refusing entry picks for an unexpected event for entry ${entryId}, event ${eventId}`,
    );
  }
  let assistantManagerPoints: AssistantManagerPointsFact | undefined;
  const managerChip = picks.active_chip === 'manager' || picks.active_chip === 'MANAGER';
  if (managerChip) {
    let currentObservation = await readLivePublicationV2({
      season: season.seasonCode,
      eventId,
    });
    if (
      options?.historicalFinalBoundary &&
      (currentObservation?.servedFrom !== 'REDIS_CURRENT' ||
        currentObservation.publication.state !== 'FINALIZED' ||
        isFreshnessBoundaryNewer(
          currentObservation.publication.sourceCheckedAt,
          options.historicalFinalBoundary,
        ))
    ) {
      currentObservation = null;
      const { readLivePublicationV2Checkpoint } = await import(
        './live-publication-v2-checkpoint.service'
      );
      const durable = await readLivePublicationV2Checkpoint(season, eventId);
      if (
        durable?.publication.state === 'FINALIZED' &&
        !isFreshnessBoundaryNewer(
          durable.publication.sourceCheckedAt,
          options.historicalFinalBoundary,
        )
      ) {
        currentObservation = durable;
      }
    }
    if (
      !currentObservation ||
      (options?.liveObservation &&
        !sameLiveScoreObservation(options.liveObservation, currentObservation))
    ) {
      throw new Error(
        `Live observation changed while reading manager entry ${entryId}, event ${eventId}`,
      );
    }
    if (!options?.providerEventLive) {
      throw new Error(
        `Manager points require a provider event-live observation for entry ${entryId}, event ${eventId}`,
      );
    }
    const fact = assistantManagerPointsFactFromProviderObservation(
      picks,
      options.providerEventLive,
      currentObservation,
    );
    if (!fact) {
      throw new Error(
        `Manager points cannot be reconciled to the live observation for entry ${entryId}, event ${eventId}`,
      );
    }
    assistantManagerPoints = fact;
  }
  const baseInput = entryLiveInputFromFplPicks(
    season,
    eventId,
    entryId,
    options?.preservedPicksBase ?? picks,
    sourceCheckedAt,
    assistantManagerPoints,
  );
  const existing = await readEntryLiveInputV2({ season: season.seasonCode, eventId, entryId });
  // Previous totals are independent immutable evidence. Read them only for a
  // first publication; repeated source probes reuse the published value and
  // do not add a PostgreSQL read to the live provider lane.
  let previousTotals = existing?.input.previousTotals ?? null;
  let firstScoringEvent = 1;
  if (eventId > 1) {
    try {
      const entryInfo = (await entryInfoRepository.findByIds(season, [entryId]))[0] ?? null;
      firstScoringEvent = Math.max(1, entryInfo?.startedEvent ?? 1);
    } catch (error) {
      // Previous totals are enrichment, not the serving boundary. If the
      // database is unavailable, publish the complete picks base and let the
      // checkpoint/reconciliation lane fill the aggregate later.
      logError('Entry start event unavailable during live picks publication', error, {
        season: season.seasonCode,
        entryId,
        eventId,
      });
    }
  }
  const previousTotalsComplete =
    firstScoringEvent >= eventId
      ? previousTotals === null
      : previousTotals?.throughEventId === eventId - 1;
  if (!previousTotalsComplete) {
    try {
      const previousTotalsRow =
        (
          await createEntryEventResultsRepository().aggregateTotalsByEntry(
            season,
            [entryId],
            firstScoringEvent,
            eventId - 1,
            { finalizedOnly: true },
          )
        )[0] ?? null;
      if (
        previousTotalsRow &&
        previousTotalsRow.eventCount === eventId - firstScoringEvent &&
        previousTotalsRow.firstEventId === firstScoringEvent &&
        previousTotalsRow.lastEventId === eventId - 1
      ) {
        previousTotals = {
          revision: contentHash({
            throughEventId: eventId - 1,
            totalPoints: previousTotalsRow.totalNetPoints,
          }),
          throughEventId: eventId - 1,
          totalPoints: previousTotalsRow.totalNetPoints,
          overallRank: null,
        };
      }
    } catch (error) {
      logError('Previous totals unavailable during live picks publication', error, {
        season: season.seasonCode,
        entryId,
        eventId,
      });
    }
  }
  const inputWithCurrentTotals = { ...baseInput, previousTotals };
  const samePicksBase =
    existing !== null &&
    entryLivePicksBaseContentHash(existing.input) ===
      entryLivePicksBaseContentHash(inputWithCurrentTotals);
  const input: EntryLiveInputV2 = samePicksBase
    ? {
        ...inputWithCurrentTotals,
        picksBase: {
          ...inputWithCurrentTotals.picksBase,
          contentUpdatedAt: existing.input.picksBase.contentUpdatedAt,
        },
      }
    : inputWithCurrentTotals;
  const desired = await readEntryCheckpointDesiredV2({
    season: season.seasonCode,
    eventId,
    entryId,
  });
  // A complete picks publication is immutable for the live event.  Rechecking
  // the provider must not turn into a periodic delete/insert or head rewrite;
  // confirmed repair/final milestones are the only paths that may publish a
  // new input revision.  An outstanding desired checkpoint is the one
  // exception: it records a Redis-first publish whose PostgreSQL write did
  // not complete, so this pass is a repair of the same publication.
  const sameInput =
    existing !== null &&
    entryLiveInputContentHash(existing.input) === entryLiveInputContentHash(input);
  const sameBaseWithFinalResult =
    existing !== null &&
    existing.input.finalResult !== null &&
    entryLivePicksBaseContentHash(existing.input) === entryLivePicksBaseContentHash(input);
  let generationFloor: number | undefined;
  let generationNeedsRepair = false;
  if (existing !== null && (sameBaseWithFinalResult || sameInput)) {
    try {
      const durableHead = await entryEventPicksRepository.findHead(season, entryId, eventId);
      if (durableHead) {
        generationNeedsRepair =
          durableHead.generation > existing.publication.generation ||
          (durableHead.generation === existing.publication.generation &&
            durableHead.publicationId !== existing.publication.publicationId);
        generationFloor = durableHead.generation;
      }
    } catch (error) {
      // Redis remains the serving boundary. A later sync retries this lookup
      // before accepting an unchanged input as fully repaired.
      logError('Entry V2 durable generation repair lookup unavailable', error, {
        season: season.seasonCode,
        entryId,
        eventId,
      });
    }
  }
  if (sameBaseWithFinalResult && !generationNeedsRepair) {
    if (desired || existing!.publication.checkpointedAt === null) {
      await ensureEntryLiveCheckpoint(season, eventId, entryId, existing!.publication, desired);
    }
    return { entryId, eventId, changed: false };
  }
  if (sameInput && !generationNeedsRepair) {
    if (desired === null && existing!.publication.checkpointedAt !== null) {
      return { entryId, eventId, changed: false };
    }
    await ensureEntryLiveCheckpoint(season, eventId, entryId, existing!.publication, desired);
    return { entryId, eventId, changed: false };
  }
  if (generationFloor === undefined) {
    try {
      // Redis can lose both the pointer and sequence during a rebuild while
      // the durable V2 head remains authoritative. Seed a replacement above
      // that head so the checkpoint fence can make progress instead of
      // retrying an equal/older generation forever.
      generationFloor =
        (await entryEventPicksRepository.findHead(season, entryId, eventId))?.generation ?? 0;
    } catch (error) {
      // Redis remains the serving boundary. If PostgreSQL is unavailable, let
      // the publication proceed and let the checkpoint/reconciler retry with a
      // durable generation floor once the database is reachable.
      logError('Entry V2 durable generation floor unavailable', error, {
        season: season.seasonCode,
        entryId,
        eventId,
      });
    }
  }
  if (generationFloor === undefined) {
    throw new CacheError(
      'Entry V2 publication requires a durable generation floor before cache rebuild',
      'LIVE_V2_ENTRY_GENERATION_FLOOR_UNAVAILABLE',
    );
  }
  const publication = await publishEntryLiveInputV2({
    season: season.seasonCode,
    eventId,
    entryId,
    input,
    sourceCheckedAt,
    generationFloor,
  });
  if (!publication.published) {
    // A FINAL publication is fenced in Redis. Never checkpoint the provisional
    // response that lost that race; repair only the publication actually
    // retained by the V2 reader.
    if (publication.publication.checkpointedAt === null || desired !== null) {
      await ensureEntryLiveCheckpoint(season, eventId, entryId, publication.publication, desired);
    }
    return { entryId, eventId, changed: false };
  }
  await ensureEntryLiveCheckpoint(season, eventId, entryId, publication.publication, desired);
  return { entryId, eventId, changed: true };
}

export async function syncEntryEventPicks(season: FplSeasonRef, entryId: number, eventId: number) {
  try {
    logInfo('Starting entry event picks sync', { entryId, eventId });
    // Capture the current live revision before the provider request. When the
    // response carries Assistant Manager, the provider event-live response
    // below is fetched after the picks response and is compared with the
    // current Redis authority before persist() binds a manager-only fact. The
    // cached publication is therefore a revision fence, never the source of
    // the player subtotal.
    const liveObservation = await readLivePublicationV2({
      season: season.seasonCode,
      eventId,
    });
    const picks = await fplClient.getEntryEventPicks(entryId, eventId);
    const managerChip = picks.active_chip === 'manager' || picks.active_chip === 'MANAGER';
    const providerEventLive = managerChip ? await fplClient.getEventLive(eventId) : undefined;
    await persistEntryEventPicksResponse(season, entryId, eventId, picks, new Date(), {
      liveObservation,
      providerEventLive,
    });
    logInfo('Entry event picks sync completed', { entryId, eventId });
    return { entryId, eventId };
  } catch (error) {
    logError('Sync entry event picks failed', error, { entryId, eventId });
    throw error;
  }
}

const EVENT_LIVE_POINTS_CACHE_TTL_MS = 5 * 60_000;
const eventLivePointsCache = new Map<string, { expiresAt: number; points: Map<number, number> }>();

async function getPointsByElement(
  seasonCode: string,
  eventId: number,
): Promise<Map<number, number>> {
  const key = `${seasonCode}:${eventId}`;
  const cached = eventLivePointsCache.get(key);
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.points;
  }

  const live = await fplClient.getEventLive(eventId);
  const pointsByElement = new Map<number, number>();
  for (const el of live.elements) {
    pointsByElement.set(el.id, el.stats.total_points);
  }

  eventLivePointsCache.set(key, {
    points: pointsByElement,
    expiresAt: now + EVENT_LIVE_POINTS_CACHE_TTL_MS,
  });

  return pointsByElement;
}

interface EntryTransferSyncOptions {
  pointsByElement?: Map<number, number>;
}

export async function syncEntryEventTransfers(
  season: FplSeasonRef,
  entryId: number,
  eventId: number,
  options?: EntryTransferSyncOptions,
) {
  try {
    logInfo('Starting entry event transfers sync', { entryId, eventId });
    const transferSyncStartedAt = await readDatabaseOrderingTimestamp();
    const transfers = await fplClient.getEntryTransfers(entryId);
    const pointsByElement =
      options?.pointsByElement ?? (await getPointsByElement(season.seasonCode, eventId));
    await withMutationScopes(
      {
        queueName: 'entry-sync',
        jobName: 'entry-transfers',
        eventId,
        scopes: [`entry-event-transfers:event:${eventId}`],
      },
      () =>
        entryEventTransfersRepository.replaceForEvent(
          season,
          entryId,
          eventId,
          transfers,
          pointsByElement,
          { sourceCheckedAt: transferSyncStartedAt.exact },
        ),
    );
    logInfo('Entry event transfers sync completed', { entryId, eventId });
    return { entryId, eventId };
  } catch (error) {
    logError('Sync entry event transfers failed', error, { entryId, eventId });
    throw error;
  }
}

export async function syncEntryEventResults(
  season: FplSeasonRef,
  entryId: number,
  eventId: number,
) {
  try {
    logInfo('Starting entry event results sync', { entryId, eventId });
    // This timestamp describes the evidence window, not database completion.
    // If the GW finalizes while either request is in flight, the persisted
    // marker remains before data_checked_at and the finalized scan refetches it.
    const richSyncStartedAt = await readDatabaseOrderingTimestamp();
    const [picks, live] = await Promise.all([
      fplClient.getEntryEventPicks(entryId, eventId),
      fplClient.getEventLive(eventId),
    ]);
    const accepted = await withMutationScopes(
      {
        queueName: 'entry-sync',
        jobName: 'entry-results',
        eventId,
        scopes: [`entry-event-results:event:${eventId}`],
      },
      () =>
        withEntrySeasonSyncTransaction(season, entryId, async (tx) => {
          return createEntryEventResultsRepository(tx).upsertFromPicksAndLive(
            season,
            entryId,
            eventId,
            picks,
            live,
            richSyncStartedAt.exact,
          );
        }),
    );
    // A newer canonical result can win while this provider request is in
    // flight. Its rejected picks must never create a fresh publication.
    if (!accepted) return { entryId, eventId };
    const event = await eventRepository.findById(season, eventId);
    if (event?.finished && event.dataChecked && event.dataCheckedAt) {
      const exactDataCheckedAt =
        (await eventRepository.findDataCheckedAtExact(season, eventId)) ?? event.dataCheckedAt;
      await checkpointFinalEntryFromProviderResponse(
        season,
        entryId,
        eventId,
        picks,
        richSyncStartedAt.exact,
        exactDataCheckedAt,
        live,
      );
    }
    logInfo('Entry event results sync completed', { entryId, eventId });
    return { entryId, eventId };
  } catch (error) {
    logError('Sync entry event results failed', error, { entryId, eventId });
    throw error;
  }
}

/** Complete a historical FINAL publication using observed provider facts and an accepted result. */
export async function checkpointFinalEntryFromProviderResponse(
  season: FplSeasonRef,
  entryId: number,
  eventId: number,
  picks: RawFPLEntryEventPicksResponse,
  sourceCheckedAt: Date | string,
  dataCheckedAt: Date | string,
  providerEventLive?: EventPointsPayload,
): Promise<void> {
  const dataCheckedAtDate = new Date(dataCheckedAt);
  if (!Number.isFinite(dataCheckedAtDate.getTime())) {
    throw new Error('Historical FINAL recovery requires a valid finalization boundary');
  }
  const head = await entryEventPicksRepository.findHead(season, entryId, eventId);
  const [result] = await createEntryEventResultsRepository().findByEventAndEntryIds(
    season,
    eventId,
    [entryId],
  );
  if (head && hasFinalEntryCheckpoint(season, eventId, head, dataCheckedAt)) {
    await assertCurrentFinalizationBoundary(season, eventId, dataCheckedAt);
    if (!result || !finalEntryMatchesResult(head.inputPayload as EntryLiveInputV2, result)) {
      throw new Error(
        'Accepted result differs from immutable FINAL; explicit correction is required',
      );
    }
    let current = await readEntryLiveInputV2({ season: season.seasonCode, eventId, entryId });
    if (
      current?.servedFrom !== 'REDIS_CURRENT' ||
      current.publication.state !== 'FINAL' ||
      current.publication.publicationId !== head.publicationId ||
      current.publication.generation !== head.generation
    ) {
      await rebuildFinalEntryLiveInputsV2(season, eventId, [entryId], dataCheckedAt);
      current = await readEntryLiveInputV2({ season: season.seasonCode, eventId, entryId });
    }
    if (
      current?.servedFrom !== 'REDIS_CURRENT' ||
      current.publication.state !== 'FINAL' ||
      !finalEntryMatchesResult(current.input, result)
    ) {
      throw new Error('Historical FINAL reconstruction remains incomplete');
    }
    // A previous attempt may have committed PostgreSQL and then failed to mark Redis.
    if ((await checkpointEntryLiveInputV2(season, eventId, entryId)) !== 'checkpointed') {
      throw new Error('Historical FINAL checkpoint marker remains incomplete');
    }
    return;
  }

  const finalPicks = normalizeFinalPicks(result?.eventPicks, entryId, eventId);
  const automaticSubs = finalPicks
    ? normalizeFinalAutomaticSubs(
        result?.eventAutoSub,
        new Set(finalPicks.map((pick) => pick.element)),
      )
    : null;
  if (
    !result ||
    !finalPicks ||
    !automaticSubs ||
    !result.richSyncedAt ||
    isFreshnessBoundaryNewer(result.richSyncedAt, dataCheckedAt) ||
    result.richSyncedAt.getTime() !== new Date(sourceCheckedAt).getTime()
  ) {
    throw new Error('Historical FINAL publication requires the accepted source result');
  }
  if (!head?.inputPayload) {
    const managerChip = picks.active_chip === 'manager' || picks.active_chip === 'MANAGER';
    let preservedPicksBase: RawFPLEntryEventPicksResponse | undefined;
    if (head) {
      const rows = await entryEventPicksRepository.findLiveInputPickRowsByEventAndEntryIds(
        season,
        eventId,
        [entryId],
      );
      const first = rows.find((row) => row.position === 1);
      if (
        rows.length !== 15 ||
        !first ||
        first.transfers === null ||
        first.transfersCost === null ||
        durableLiveInputContentHash(rows) !== head.contentSha256
      ) {
        throw new Error('Historical FINAL recovery requires intact canonical base picks');
      }
      preservedPicksBase = {
        ...picks,
        active_chip: first.activeChip,
        entry_history: {
          ...picks.entry_history,
          event_transfers: first.transfers,
          event_transfers_cost: first.transfersCost,
        },
        picks: rows.map((row) => ({
          element: row.elementId,
          position: row.position,
          multiplier: row.multiplier,
          is_captain: row.isCaptain,
          is_vice_captain: row.isViceCaptain,
        })),
      };
    }
    await persistEntryEventPicksResponse(season, entryId, eventId, picks, sourceCheckedAt, {
      historicalFinalBoundary: dataCheckedAt,
      preservedPicksBase,
      providerEventLive:
        providerEventLive ?? (managerChip ? await fplClient.getEventLive(eventId) : undefined),
    });
  } else {
    // Recover the original base from its durable payload, preserving deadline facts.
    const current = await readEntryLiveInputV2({ season: season.seasonCode, eventId, entryId });
    if (
      current?.servedFrom !== 'REDIS_CURRENT' ||
      current.publication.publicationId !== head.publicationId ||
      current.publication.generation !== head.generation ||
      current.input.picksBase.revision !== head.picksBaseRevision ||
      isFreshnessBoundaryNewer(head.sourceCheckedAtExact ?? head.sourceCheckedAt, dataCheckedAt)
    ) {
      const currentEvent = await eventRepository.findById(season, eventId);
      const currentEventBoundary = currentEvent
        ? ((await eventRepository.findDataCheckedAtExact(season, eventId)) ??
          currentEvent.dataCheckedAt)
        : null;
      if (
        !currentEvent?.finished ||
        !currentEvent.dataChecked ||
        !currentEventBoundary ||
        isFreshnessBoundaryNewer(dataCheckedAt, currentEventBoundary) ||
        isFreshnessBoundaryNewer(currentEventBoundary, dataCheckedAt)
      ) {
        throw new Error('Historical FINAL canonical boundary changed');
      }
      if (
        (await rebuildFinalEntryLiveInputsV2(
          season,
          eventId,
          [entryId],
          dataCheckedAt,
          undefined,
          dataCheckedAt,
        )) !== 1
      ) {
        throw new Error('Historical FINAL durable base reconstruction failed');
      }
    }
  }
  // The event can be reopened while the provider response and durable writes
  // are in flight. Revalidate the canonical finalization boundary immediately
  // before publishing FINAL so a vanished or changed boundary cannot become a
  // terminal Redis publication.
  await assertCurrentFinalizationBoundary(season, eventId, dataCheckedAt);
  const finalPublication = await publishEntryLiveFinalResultV2({
    season: season.seasonCode,
    eventId,
    entryId,
    // Keep the caller's exact database ordering timestamp.  The mapped Date
    // on result.richSyncedAt has only millisecond precision and can fall below
    // a microsecond finalization fence even when the accepted source is valid.
    sourceCheckedAt,
    dataCheckedAt,
    finalResult: {
      score: { eventPoints: result.eventPoints, totalPoints: result.overallPoints },
      picks: finalPicks,
      automaticSubs,
    },
    finalizationCorrectionBoundary: dataCheckedAt,
  });
  if (isFreshnessBoundaryNewer(finalPublication.publication.sourceCheckedAt, dataCheckedAt)) {
    throw new Error('Historical FINAL publication still predates canonical boundary');
  }
  if (finalPublication.publication.checkpointedAt === null) {
    await setEntryCheckpointDesiredV2(finalPublication.publication);
  }
  if ((await checkpointEntryLiveInputV2(season, eventId, entryId)) !== 'checkpointed') {
    throw new Error('Historical FINAL publication was not durably checkpointed');
  }
}

async function assertCurrentFinalizationBoundary(
  season: FplSeasonRef,
  eventId: number,
  expectedBoundary: Date | string,
): Promise<void> {
  const event = await eventRepository.findById(season, eventId);
  const currentBoundary =
    event?.finished && event.dataChecked
      ? ((await eventRepository.findDataCheckedAtExact(season, eventId)) ?? event.dataCheckedAt)
      : null;
  if (
    !currentBoundary ||
    isFreshnessBoundaryNewer(expectedBoundary, currentBoundary) ||
    isFreshnessBoundaryNewer(currentBoundary, expectedBoundary)
  ) {
    throw new Error('Historical FINAL canonical boundary changed before publication');
  }
}

function finalEntryMatchesResult(input: EntryLiveInputV2, result: DbEntryEventResult): boolean {
  const expectedPicks = normalizeFinalPicks(result.eventPicks, result.entryId, result.eventId);
  const actualPicks = normalizeFinalPicks(input.finalResult?.picks, result.entryId, result.eventId);
  if (!expectedPicks || !actualPicks || !input.finalResult) return false;
  const elements = new Set(expectedPicks.map((pick) => pick.element));
  const expectedSubs = normalizeFinalAutomaticSubs(result.eventAutoSub, elements);
  const actualSubs = normalizeFinalAutomaticSubs(input.finalResult.automaticSubs, elements);
  const compareSubs = (
    a: { inElement: number; outElement: number },
    b: { inElement: number; outElement: number },
  ) => a.inElement - b.inElement || a.outElement - b.outElement;
  expectedSubs?.sort(compareSubs);
  actualSubs?.sort(compareSubs);
  return (
    expectedSubs !== null &&
    actualSubs !== null &&
    contentHash({ score: input.finalResult.score, picks: actualPicks, subs: actualSubs }) ===
      contentHash({
        score: { eventPoints: result.eventPoints, totalPoints: result.overallPoints },
        picks: expectedPicks,
        subs: expectedSubs,
      })
  );
}

/** The backfill boundary requires both durable facts and the exact active checkpoint marker. */
export async function completedFinalEntryIds(
  season: FplSeasonRef,
  eventId: number,
  heads: readonly EntryEventPickHeadMetadata[],
  dataCheckedAt: Date | string,
): Promise<Set<number>> {
  const complete = heads.filter((head) =>
    hasFinalEntryCheckpoint(season, eventId, head, dataCheckedAt),
  );
  const active = await readEntryLiveInputsV2(
    complete.map((head) => ({ season: season.seasonCode, eventId, entryId: head.entryId })),
  );
  const results = await createEntryEventResultsRepository().findByEventAndEntryIds(
    season,
    eventId,
    complete.map((head) => head.entryId),
  );
  const resultsByEntry = new Map(results.map((result) => [result.entryId, result]));
  return new Set(
    complete
      .filter((head) => {
        const result = resultsByEntry.get(head.entryId);
        if (!result || !finalEntryMatchesResult(head.inputPayload as EntryLiveInputV2, result))
          return false;
        const read = active.get(head.entryId);
        return (
          read?.servedFrom === 'REDIS_CURRENT' &&
          read.publication.state === 'FINAL' &&
          read.publication.checkpointedAt !== null &&
          read.publication.publicationId === head.publicationId &&
          read.publication.generation === head.generation
        );
      })
      .map((head) => head.entryId),
  );
}

export function hasFinalEntryCheckpoint(
  season: FplSeasonRef,
  eventId: number,
  head: EntryEventPickHeadMetadata,
  dataCheckedAt: Date | string,
): boolean {
  const input = head.inputPayload;
  const sourceCheckedAt = head.sourceCheckedAtExact ?? head.sourceCheckedAt;
  if (
    head.state !== 'COMPLETE' ||
    head.rowCount !== 15 ||
    !Number.isSafeInteger(head.generation) ||
    head.generation < 1 ||
    !Number.isFinite(new Date(sourceCheckedAt).getTime()) ||
    isFreshnessBoundaryNewer(sourceCheckedAt, dataCheckedAt) ||
    !validateEntryLiveInputV2(input, {
      season: season.seasonCode,
      eventId,
      entryId: head.entryId,
    }) ||
    !input.finalResult ||
    !input.finalResult.score ||
    !Number.isSafeInteger(input.finalResult.score.eventPoints) ||
    (input.finalResult.score.totalPoints !== null &&
      !Number.isSafeInteger(input.finalResult.score.totalPoints)) ||
    input.picksBase.revision !== head.picksBaseRevision
  )
    return false;
  const finalPicks = normalizeFinalPicks(input.finalResult.picks, head.entryId, eventId);
  return (
    finalPicks !== null &&
    normalizeFinalAutomaticSubs(
      input.finalResult.automaticSubs,
      new Set(finalPicks.map((pick) => pick.element)),
    ) !== null &&
    (head.contentSha256 === entryLivePicksBaseCheckpointHash(input) ||
      head.contentSha256 === entryLiveFinalResultCheckpointHash(input))
  );
}

export function normalizeFinalPicks(
  raw: unknown,
  entryId: number,
  eventId: number,
): Exactly15Picks | null {
  if (!Array.isArray(raw) || raw.length !== 15) return null;
  const picks = raw.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    const element = Number(row.element);
    const position = Number(row.position);
    const multiplier = Number(row.multiplier);
    const isCaptain = row.is_captain ?? row.isCaptain;
    const isViceCaptain = row.is_vice_captain ?? row.isViceCaptain;
    if (
      !Number.isSafeInteger(element) ||
      element <= 0 ||
      !Number.isSafeInteger(position) ||
      position < 1 ||
      position > 15 ||
      !Number.isSafeInteger(multiplier) ||
      multiplier < 0 ||
      multiplier > 3 ||
      typeof isCaptain !== 'boolean' ||
      typeof isViceCaptain !== 'boolean'
    ) {
      return null;
    }
    return {
      element,
      position,
      multiplier,
      isCaptain,
      isViceCaptain,
    };
  });
  if (picks.some((pick) => pick === null)) return null;
  const normalized = picks as Exclude<(typeof picks)[number], null>[];
  const positions = new Set(normalized.map((pick) => pick.position));
  const elements = new Set(normalized.map((pick) => pick.element));
  if (
    positions.size !== 15 ||
    elements.size !== 15 ||
    normalized.filter((pick) => pick.isCaptain).length !== 1 ||
    normalized.filter((pick) => pick.isViceCaptain).length !== 1 ||
    normalized.some((pick) => pick.isCaptain && pick.isViceCaptain)
  ) {
    return null;
  }
  const eventScoped = normalized.map((pick) => ({
    ...pick,
    entry: entryId,
    event: eventId,
    is_captain: pick.isCaptain,
    is_vice_captain: pick.isViceCaptain,
  }));
  if (!isCompleteEntryPicks(eventScoped)) return null;
  return [...normalized].sort(
    (left, right) => left.position - right.position,
  ) as unknown as Exactly15Picks;
}

export function normalizeFinalAutomaticSubs(
  raw: unknown,
  allowedElements: ReadonlySet<number>,
): OfficialSubstitution[] | null {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const substitutions: OfficialSubstitution[] = [];
  const incoming = new Set<number>();
  const outgoing = new Set<number>();
  for (const value of raw) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    const inElement = Number(row.element_in ?? row.elementIn ?? row.inElement);
    const outElement = Number(row.element_out ?? row.elementOut ?? row.outElement);
    if (
      !Number.isSafeInteger(inElement) ||
      inElement <= 0 ||
      !Number.isSafeInteger(outElement) ||
      outElement <= 0 ||
      inElement === outElement ||
      !allowedElements.has(inElement) ||
      !allowedElements.has(outElement) ||
      incoming.has(inElement) ||
      outgoing.has(outElement) ||
      incoming.has(outElement) ||
      outgoing.has(inElement)
    ) {
      return null;
    }
    incoming.add(inElement);
    outgoing.add(outElement);
    substitutions.push({ inElement, outElement });
  }
  return substitutions;
}

function durableLiveInputContentHash(rows: readonly EntryLiveInputPickRow[]): string {
  const first = rows.find((row) => row.position === 1);
  return contentHash({
    picks: rows
      .map((row) => ({
        element: row.elementId,
        position: row.position,
        multiplier: row.multiplier,
        isCaptain: row.isCaptain,
        isViceCaptain: row.isViceCaptain,
      }))
      .sort((left, right) => left.position - right.position),
    chip: first?.activeChip ?? null,
    transferCount: first?.transfers,
    transferCost: first?.transfersCost,
  });
}

/**
 * Build the FINAL semantic input from a validated Redis provisional input and
 * the durable finalized result.  No provider fields are inferred here: the
 * result must contain the persisted 15-pick payload, valid substitutions, a
 * rich-sync timestamp at/after data_checked, and integer score totals.
 */
export function buildFinalEntryLiveInputFromBaseAndResult(
  baseInput: EntryLiveInputV2,
  result: DbEntryEventResult,
  dataCheckedAt: Date,
): EntryLiveInputV2 | null {
  if (
    baseInput.finalResult !== null ||
    !Number.isSafeInteger(result.eventPoints) ||
    !Number.isSafeInteger(result.overallPoints) ||
    !result.richSyncedAt ||
    !Number.isFinite(result.richSyncedAt.getTime()) ||
    result.richSyncedAt.getTime() < dataCheckedAt.getTime()
  ) {
    return null;
  }
  const finalPicks = normalizeFinalPicks(result.eventPicks, result.entryId, result.eventId);
  const automaticSubs = finalPicks
    ? normalizeFinalAutomaticSubs(
        result.eventAutoSub,
        new Set(finalPicks.map((pick) => pick.element)),
      )
    : null;
  if (!finalPicks || !automaticSubs) return null;
  const dataCheckedAtIso = dataCheckedAt.toISOString();
  const multipliers = finalPicks.map((pick) => ({
    element: pick.element,
    multiplier: pick.multiplier,
  }));
  const score = {
    eventPoints: result.eventPoints,
    totalPoints: result.overallPoints,
  };
  const officialAdjustmentRevision = contentHash({
    dataCheckedAt: dataCheckedAtIso,
    multipliers,
    automaticSubs,
  });
  const finalResultRevision = contentHash({
    dataCheckedAt: dataCheckedAtIso,
    score,
    picks: finalPicks,
    automaticSubs,
  });
  const input: EntryLiveInputV2 = {
    ...baseInput,
    officialAdjustment: {
      revision: officialAdjustmentRevision,
      multipliers,
      automaticSubs,
    },
    finalResult: {
      revision: finalResultRevision,
      score,
      picks: finalPicks,
      automaticSubs,
    },
  };
  return validateEntryLiveInputV2(input, {
    season: baseInput.season,
    eventId: baseInput.eventId,
    entryId: baseInput.entryId,
  })
    ? input
    : null;
}

function durableRowsMatchEntryLiveInput(
  rows: readonly EntryLiveInputPickRow[],
  input: EntryLiveInputV2,
): boolean {
  if (rows.length !== 15) return false;
  const picksByPosition = new Map(input.picksBase.picks.map((pick) => [pick.position, pick]));
  const first = rows.find((row) => row.position === 1);
  return Boolean(
    first &&
      rows.every((row) => {
        const pick = picksByPosition.get(row.position);
        return (
          pick !== undefined &&
          pick.element === row.elementId &&
          pick.multiplier === row.multiplier &&
          pick.isCaptain === row.isCaptain &&
          pick.isViceCaptain === row.isViceCaptain &&
          (row.position === 1
            ? row.activeChip === input.picksBase.chip &&
              row.transfers === input.picksBase.transferCount &&
              row.transfersCost === input.picksBase.transferCost
            : row.activeChip === null && row.transfers === null && row.transfersCost === null)
        );
      }),
  );
}

function buildFinalEntryLiveInputFromCheckpoint(
  season: FplSeasonRef,
  eventId: number,
  entryId: number,
  rows: readonly EntryLiveInputPickRow[],
  head: EntryEventPickHeadMetadata,
  result: DbEntryEventResult | undefined,
  dataCheckedAt: Date,
): EntryLiveInputV2 | null {
  if (!result) return null;
  if (
    head.entryId !== entryId ||
    head.state !== 'COMPLETE' ||
    head.rowCount !== 15 ||
    !Number.isSafeInteger(head.generation) ||
    head.generation <= 0 ||
    !/^[0-9a-f]{64}$/.test(head.picksBaseRevision) ||
    !/^[0-9a-f]{64}$/.test(head.contentSha256) ||
    !Number.isFinite(new Date(head.sourceCheckedAtExact ?? head.sourceCheckedAt).getTime()) ||
    !Number.isFinite(head.contentUpdatedAt.getTime()) ||
    !Number.isFinite(head.checkpointedAt.getTime()) ||
    durableLiveInputContentHash(rows) !== head.contentSha256
  ) {
    return null;
  }
  const first = rows.find((row) => row.position === 1);
  if (
    rows.length !== 15 ||
    !first ||
    first.transfers === null ||
    first.transfersCost === null ||
    !Number.isSafeInteger(first.transfers) ||
    first.transfers < 0 ||
    !Number.isSafeInteger(first.transfersCost) ||
    first.transfersCost < 0
  ) {
    return null;
  }
  if (head.inputPayload === null) return null;
  if (
    !validateEntryLiveInputV2(head.inputPayload, {
      season: season.seasonCode,
      eventId,
      entryId,
    }) ||
    head.inputPayload.picksBase.revision !== head.picksBaseRevision ||
    !durableRowsMatchEntryLiveInput(rows, head.inputPayload)
  ) {
    // A pick head without the complete V2 payload cannot prove the original
    // reported points, previous totals, or Assistant Manager fact.  Keep
    // final recovery pending instead of manufacturing a new input revision.
    return null;
  }
  const baseInput = head.inputPayload;
  const finalPicks = normalizeFinalPicks(result.eventPicks, entryId, eventId);
  const automaticSubs = finalPicks
    ? normalizeFinalAutomaticSubs(
        result.automaticSubstitutions,
        new Set(finalPicks.map((pick) => pick.element)),
      )
    : null;
  const richSyncedAt = result.richSyncedAt;
  if (
    !finalPicks ||
    !automaticSubs ||
    !richSyncedAt ||
    !Number.isFinite(richSyncedAt.getTime()) ||
    richSyncedAt.getTime() < dataCheckedAt.getTime()
  ) {
    return null;
  }
  const dataCheckedAtIso = dataCheckedAt.toISOString();
  const multipliers = finalPicks.map((pick) => ({
    element: pick.element,
    multiplier: pick.multiplier,
  }));
  const score = {
    eventPoints: result.eventPoints,
    totalPoints: result.overallPoints,
  };
  const officialAdjustmentRevision = contentHash({
    dataCheckedAt: dataCheckedAtIso,
    multipliers,
    automaticSubs,
  });
  const finalResultRevision = contentHash({
    dataCheckedAt: dataCheckedAtIso,
    score,
    picks: finalPicks,
    automaticSubs,
  });
  const input: EntryLiveInputV2 = {
    ...baseInput,
    officialAdjustment: {
      revision: officialAdjustmentRevision,
      multipliers,
      automaticSubs,
    },
    finalResult: {
      revision: finalResultRevision,
      score,
      picks: finalPicks,
      automaticSubs,
    },
  };
  return validateEntryLiveInputV2(input, { season: season.seasonCode, eventId, entryId })
    ? input
    : null;
}

/**
 * Rebuild only missing FINAL entry inputs from the durable V2 pick head and
 * finalized entry result. This is a finalization recovery path; the live
 * provider lane continues to read and publish Redis without a database read.
 */
export async function rebuildFinalEntryLiveInputsV2(
  season: FplSeasonRef,
  eventId: number,
  entryIds: readonly number[],
  dataCheckedAt: Date | string,
  redis?: Redis,
  finalizationCorrectionBoundary?: Date | string,
): Promise<number> {
  const uniqueEntryIds = [...new Set(entryIds)].filter(
    (entryId) => Number.isSafeInteger(entryId) && entryId > 0,
  );
  if (uniqueEntryIds.length === 0) return 0;
  const boundary =
    dataCheckedAt instanceof Date ? new Date(dataCheckedAt) : new Date(dataCheckedAt);
  if (!Number.isFinite(boundary.getTime())) return 0;
  const resultsRepository = createEntryEventResultsRepository();
  const [pickRows, heads, results] = await Promise.all([
    entryEventPicksRepository.findLiveInputPickRowsByEventAndEntryIds(
      season,
      eventId,
      uniqueEntryIds,
    ),
    entryEventPicksRepository.findHeadsByEventAndEntryIds(season, eventId, uniqueEntryIds),
    resultsRepository.findByEventAndEntryIds(season, eventId, uniqueEntryIds),
  ]);
  const rowsByEntry = new Map<number, EntryLiveInputPickRow[]>();
  for (const row of pickRows) {
    const bucket = rowsByEntry.get(row.entryId) ?? [];
    bucket.push(row);
    rowsByEntry.set(row.entryId, bucket);
  }
  const headsByEntry = new Map<number, EntryEventPickHeadMetadata>();
  for (const head of heads) {
    headsByEntry.set(head.entryId, head);
  }
  const resultsByEntry = new Map(results.map((result) => [result.entryId, result]));
  let rebuilt = 0;
  for (const entryId of uniqueEntryIds) {
    const head = headsByEntry.get(entryId);
    const result = resultsByEntry.get(entryId);
    if (!head || !result) continue;
    const input = buildFinalEntryLiveInputFromCheckpoint(
      season,
      eventId,
      entryId,
      rowsByEntry.get(entryId) ?? [],
      head,
      result,
      boundary,
    );
    if (!input) continue;
    try {
      if (finalizationCorrectionBoundary !== undefined) {
        await assertCurrentFinalizationBoundary(season, eventId, finalizationCorrectionBoundary);
      }
      const publication = await publishEntryLiveInputV2({
        season: season.seasonCode,
        eventId,
        entryId,
        input,
        sourceCheckedAt: result.richSyncedAt!,
        generationFloor: head.generation,
        finalizationCorrectionBoundary,
        redis,
      });
      if (
        publication.publication.state !== 'FINAL' ||
        publication.publication.entryId !== entryId
      ) {
        continue;
      }
      if (publication.published) {
        rebuilt += 1;
        continue;
      }
      // A prior attempt may have promoted this exact FINAL and crashed before
      // checkpointing it. The CAS returns the immutable current publication
      // as `published: false`; accept it only after reading the current item
      // and proving that its complete input is the same candidate.
      const current = await readEntryLiveInputV2(
        { season: season.seasonCode, eventId, entryId },
        redis,
      );
      if (
        current?.servedFrom === 'REDIS_CURRENT' &&
        current.publication.state === 'FINAL' &&
        current.publication.publicationId === publication.publication.publicationId &&
        current.publication.generation === publication.publication.generation &&
        contentHash(current.input) === contentHash(input)
      ) {
        rebuilt += 1;
      }
    } catch (error) {
      logError('Failed to rebuild final V2 entry input from checkpoint', error, {
        season: season.seasonCode,
        eventId,
        entryId,
      });
    }
  }
  return rebuilt;
}
