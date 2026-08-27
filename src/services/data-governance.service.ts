import { and, asc, count, desc, eq, gte, inArray, isNull, lt, lte, sql } from 'drizzle-orm';

import {
  dataGovernanceCasesInOps,
  freshnessSloWindowsInOps,
  queueHealthWindowsInOps,
  seasonsInFpl,
  schedulerObligationsInOps,
} from '../db/schemas/index.schema';
import { getDb, type DbHandle, type DbOrTransaction } from '../db/singleton';
import type { DataPublicationManifest } from '../cache/data-publication';
import {
  applyFreshnessObservation,
  type FreshnessCompletenessStatus,
  type FreshnessSloStatus,
} from '../domain/freshness-slo';
import { dataContractRegistry } from '../domain/data-contracts';
import { getConfig } from '../utils/config';
import { logInfo } from '../utils/logger';
import {
  dataRepairQueueName,
  dataSyncQueueName,
  fplCriticalSyncQueueName,
  liveDataQueueName,
  livePicksQueueName,
  myFplOrchestrationQueueName,
  officialH2hLiveQueueName,
  publicationOutboxQueueName,
  entrySyncQueueName,
  leagueSyncQueueName,
} from '../queues/names';
import { mapWithConcurrency } from '../utils/async';
import {
  QUEUE_HEALTH_RETENTION_BATCH_SIZE,
  QUEUE_HEALTH_RETENTION_MAX_BATCHES,
  queueHealthRetentionCutoff,
} from './queue-governance.service';

export type GovernanceCaseStatus =
  | 'OPEN'
  | 'AUTO_REPAIRING'
  | 'REQUIRES_REVIEW'
  | 'RECOVERED'
  | 'DISMISSED';

/**
 * Resolve the same concrete queue that the repair dispatcher will use.  A
 * contract's primary lane is not always the lane of a particular period
 * (market price-change latest-wins is the important example), so persist this
 * result on the governance case for operators and admission decisions.
 */
export function freshnessRepairLaneForWindow(contractKey: string, periodKey: string): string {
  switch (contractKey) {
    case 'core-fixtures':
      return dataSyncQueueName;
    case 'market-price':
      if (periodKey.startsWith('price-change-')) {
        return getConfig().PRICE_CHANGE_SINGLE_FLIGHT_ENABLED
          ? fplCriticalSyncQueueName
          : dataSyncQueueName;
      }
      return periodKey.startsWith('maintenance-') ? dataRepairQueueName : dataSyncQueueName;
    case 'live-snapshot':
      return liveDataQueueName;
    case 'live-picks':
      return livePicksQueueName;
    case 'entry-data':
      return entrySyncQueueName;
    case 'league-tournament':
      return leagueSyncQueueName;
    case 'my-fpl':
      return periodKey.includes('outbox')
        ? publicationOutboxQueueName
        : myFplOrchestrationQueueName;
    case 'official-h2h':
      return officialH2hLiveQueueName;
    case 'player-stats':
      return dataSyncQueueName;
    default:
      return (
        dataContractRegistry.find((item) => item.contractKey === contractKey)?.queueLane ??
        contractKey
      );
  }
}

function asJsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function upsertFreshnessWindow(input: {
  sloKey: string;
  contractKey: string;
  seasonId?: number;
  scopeKey: string;
  periodKey: string;
  eventId?: number;
  sourceDay?: string;
  eligibleAt: Date;
  dueAt: Date;
  obligationDueAt?: Date;
  evidence?: Record<string, unknown>;
  db?: DbHandle;
}): Promise<number> {
  const db = input.db ?? (await getDb());
  const [row] = await db
    .insert(freshnessSloWindowsInOps)
    .values({
      sloKey: input.sloKey,
      contractKey: input.contractKey,
      seasonId: input.seasonId,
      scopeKey: input.scopeKey,
      periodKey: input.periodKey,
      eventId: input.eventId,
      sourceDay: input.sourceDay,
      eligibleAt: input.eligibleAt,
      dueAt: input.dueAt,
      obligationDueAt: input.obligationDueAt,
      evidence: asJsonObject(input.evidence),
    })
    .onConflictDoUpdate({
      target: [
        freshnessSloWindowsInOps.sloKey,
        freshnessSloWindowsInOps.scopeKey,
        freshnessSloWindowsInOps.periodKey,
      ],
      set: {
        eligibleAt: sql`LEAST(${freshnessSloWindowsInOps.eligibleAt}, excluded.eligible_at)`,
        dueAt: sql`LEAST(${freshnessSloWindowsInOps.dueAt}, excluded.due_at)`,
        obligationDueAt: sql`COALESCE(${freshnessSloWindowsInOps.obligationDueAt}, excluded.obligation_due_at)`,
        evidence: sql`${freshnessSloWindowsInOps.evidence} || excluded.evidence`,
        updatedAt: sql`clock_timestamp()`,
      },
    })
    .returning({ windowId: freshnessSloWindowsInOps.windowId });
  if (!row) throw new Error('Freshness window upsert did not return a window id');
  return row.windowId;
}

const PUBLICATION_CONTRACT_BY_DATASET = {
  'fpl:core': 'core-fixtures',
  'fpl:live': 'live-snapshot',
  'fpl:market': 'market-price',
  'fpl:price-changes': 'market-price',
} as const;

function finiteNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

type PublicationEvidenceCounts = Readonly<{
  expectedCount: number | null;
  observedCount: number | null;
  completenessStatus: FreshnessCompletenessStatus;
}>;

function publicationEvidenceCounts(
  manifest: DataPublicationManifest,
  payloads?: Readonly<Record<string, unknown>>,
): PublicationEvidenceCounts {
  const context = payloads?.context;
  const contextRecord =
    context && typeof context === 'object' && !Array.isArray(context)
      ? (context as Record<string, unknown>)
      : null;
  const expectedFromContext = finiteNonNegativeInteger(contextRecord?.expectedRowCount);
  const observedFromContext = finiteNonNegativeInteger(contextRecord?.rowCount);
  if (expectedFromContext !== undefined && observedFromContext !== undefined) {
    return {
      expectedCount: expectedFromContext,
      observedCount: observedFromContext,
      completenessStatus: expectedFromContext === observedFromContext ? 'COMPLETE' : 'INCOMPLETE',
    };
  }
  if (manifest.dataset === 'fpl:market' || manifest.dataset === 'fpl:price-changes') {
    const playerPayload = payloads?.players;
    const observed = Array.isArray(playerPayload)
      ? playerPayload.length
      : manifest.items.find((item) => item.name === 'players')?.count;
    if (observed !== undefined) {
      return {
        expectedCount: observed,
        observedCount: observed,
        completenessStatus: 'COMPLETE',
      };
    }
    return { expectedCount: null, observedCount: null, completenessStatus: 'INCOMPLETE' };
  }
  const count = manifest.items.reduce((total, item) => total + item.count, 0);
  return { expectedCount: count, observedCount: count, completenessStatus: 'COMPLETE' };
}

/**
 * Attach the immutable publication proof to the exact scheduler/SLO window
 * that produced it.  Repairs carry the window identity in the publication
 * manifest because they intentionally receive a new source run/generation;
 * ordinary scheduler jobs continue to use the source-run join as a fallback.
 * This function is deliberately best-effort at call sites; losing telemetry
 * must never roll back an already committed data publication.
 */
export async function recordDataPublicationEvidence(input: {
  manifest: DataPublicationManifest;
  sourceRunId?: string | null;
  payloads?: Readonly<Record<string, unknown>>;
  pgPublishedAt?: Date | null;
  redisSeenAt?: Date | null;
  db?: DbHandle;
}): Promise<number> {
  const contractKey = PUBLICATION_CONTRACT_BY_DATASET[input.manifest.dataset];
  const freshnessWindowIds = [
    ...(Array.isArray(input.manifest.freshnessWindowIds) ? input.manifest.freshnessWindowIds : []),
    input.manifest.freshnessWindowId,
  ].filter(
    (value, index, values): value is number =>
      typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value > 0 &&
      values.indexOf(value) === index,
  );
  const sourceRunId = input.sourceRunId;
  if (!contractKey || (!input.sourceRunId && freshnessWindowIds.length === 0)) return 0;
  const db = input.db ?? (await getDb());
  const windows =
    freshnessWindowIds.length > 0
      ? await db
          .select({
            windowId: freshnessSloWindowsInOps.windowId,
            scopeKey: freshnessSloWindowsInOps.scopeKey,
            eventId: freshnessSloWindowsInOps.eventId,
            seasonCode: seasonsInFpl.seasonCode,
          })
          .from(freshnessSloWindowsInOps)
          .innerJoin(seasonsInFpl, eq(seasonsInFpl.seasonId, freshnessSloWindowsInOps.seasonId))
          .where(
            and(
              inArray(freshnessSloWindowsInOps.windowId, freshnessWindowIds),
              eq(freshnessSloWindowsInOps.contractKey, contractKey),
              eq(seasonsInFpl.seasonCode, input.manifest.seasonCode),
              inArray(freshnessSloWindowsInOps.status, ['PENDING', 'BREACHED', 'INVALID']),
            ),
          )
          .limit(Math.max(1, freshnessWindowIds.length))
      : await db
          .select({
            windowId: freshnessSloWindowsInOps.windowId,
            scopeKey: freshnessSloWindowsInOps.scopeKey,
            eventId: freshnessSloWindowsInOps.eventId,
            seasonCode: seasonsInFpl.seasonCode,
          })
          .from(freshnessSloWindowsInOps)
          .innerJoin(seasonsInFpl, eq(seasonsInFpl.seasonId, freshnessSloWindowsInOps.seasonId))
          .innerJoin(
            schedulerObligationsInOps,
            and(
              eq(schedulerObligationsInOps.scopeKey, freshnessSloWindowsInOps.scopeKey),
              eq(schedulerObligationsInOps.periodKey, freshnessSloWindowsInOps.periodKey),
            ),
          )
          .where(
            and(
              eq(schedulerObligationsInOps.runId, sourceRunId as string),
              eq(freshnessSloWindowsInOps.contractKey, contractKey),
              eq(seasonsInFpl.seasonCode, input.manifest.seasonCode),
              inArray(freshnessSloWindowsInOps.status, ['PENDING', 'BREACHED', 'INVALID']),
            ),
          )
          .limit(20);
  const eligibleWindows = windows.filter((window) => {
    if (window.seasonCode !== input.manifest.seasonCode) return false;
    if (contractKey === 'live-snapshot' && window.eventId !== input.manifest.eventId) {
      return false;
    }
    const scopeSeason = window.scopeKey.match(/^(\d{4})(?::|$)/)?.[1];
    return scopeSeason === input.manifest.seasonCode;
  });
  if (eligibleWindows.length === 0) return 0;

  const sourceCheckedAt = new Date(input.manifest.sourceCheckedAt);
  const publishedAt = new Date(input.manifest.publishedAt);
  const counts = publicationEvidenceCounts(input.manifest, input.payloads);
  const observation = {
    sourceCheckedAt: Number.isFinite(sourceCheckedAt.getTime()) ? sourceCheckedAt : undefined,
    pgPublishedAt:
      input.pgPublishedAt ?? (Number.isFinite(publishedAt.getTime()) ? publishedAt : undefined),
    redisSeenAt: input.redisSeenAt ?? undefined,
    producerRevision: String(input.manifest.revision),
    redisRevision: input.redisSeenAt ? String(input.manifest.revision) : undefined,
    expectedCount: counts.expectedCount,
    observedCount: counts.observedCount,
    completenessStatus: counts.completenessStatus,
  } as const;
  let updated = 0;
  for (const window of eligibleWindows) {
    const status = await recordFreshnessObservation({
      windowId: window.windowId,
      ...observation,
      db,
    });
    if (status !== null) updated += 1;
  }
  return updated;
}

// The Web consumer evidence writer is the POST variant of the protected
// contract route. Keep the contract key in the path so a response for one
// business envelope can never be accidentally recorded against another
// window. This must stay in lockstep with the Web route
// `/api/ops/data-contracts/[contractKey]`.
const CONSUMER_PROBE_PATH = '/api/ops/data-contracts';
const CONSUMER_PROBE_TIMEOUT_MS = 5_000;

/**
 * Keep the probe route construction testable and encode the contract key as
 * a path segment.  The Web endpoint is scoped by this segment, so putting the
 * key only in the JSON body would permit an accidental cross-window write.
 */
export function consumerProbeUrl(baseUrl: string, contractKey: string): string {
  return `${baseUrl.replace(/\/$/, '')}${CONSUMER_PROBE_PATH}/${encodeURIComponent(contractKey)}`;
}

type ConsumerProbePayload = Readonly<{
  success?: boolean;
  contractKey?: unknown;
  scopeKey?: unknown;
  graphqlSeenAt?: unknown;
  webSeenAt?: unknown;
  graphqlRevision?: unknown;
  webRevision?: unknown;
  expectedCount?: unknown;
  observedCount?: unknown;
  complete?: unknown;
}>;

function probeTimestamp(value: unknown): Date | undefined {
  if (typeof value !== 'string' && !(value instanceof Date)) return undefined;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : undefined;
}

function probeRevision(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const revision = String(value).trim();
  return revision.length > 0 ? revision : undefined;
}

function probeCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Ask the Web server to execute the same GraphQL operation and server loader
 * used by its public page, then persist both consumer milestones.  The route
 * is deliberately authenticated with a separate probe token and returns only
 * aggregate metadata; a missing/invalid response is evidence of a stale
 * consumer, never a reason to mark the producer complete.
 */
export async function observeFreshnessConsumerEvidence(
  input: { limit?: number; db?: DbHandle } = {},
): Promise<{ scanned: number; observed: number; failed: number; disabled: boolean }> {
  const config = getConfig();
  if (!config.FRESHNESS_CONSUMER_PROBES_ENABLED) {
    return { scanned: 0, observed: 0, failed: 0, disabled: true };
  }
  const baseUrl = config.DATA_GOVERNANCE_WEB_URL?.replace(/\/$/, '');
  const token = config.DATA_GOVERNANCE_PROBE_TOKEN;
  if (!baseUrl || !token) {
    // Production configuration validation normally catches this before the
    // worker starts. Keep the runtime guard for tests and hot environment
    // reloads so an absent writer remains a visible failure.
    throw new Error('FRESHNESS_CONSUMER_PROBE_CONFIG_MISSING');
  }
  // Always give never-observed PENDING windows the first slice. Recovered
  // breaches remain BREACHED for historical SLO accounting; including them
  // in this cursor would let an old incident starve new consumer probes.
  const limit = Math.min(100, Math.max(1, input.limit ?? 100));
  const pending = await listFreshnessWindows({
    status: 'PENDING',
    limit,
    db: input.db,
  });
  const breached =
    pending.length >= limit
      ? []
      : await listFreshnessWindows({
          status: 'BREACHED',
          recovered: 'unrecovered',
          limit: limit - pending.length,
          db: input.db,
        });
  const windows = [...pending, ...breached];
  const candidates = windows.filter((window) => {
    const contract = dataContractRegistry.find((item) => item.contractKey === window.contractKey);
    const evidence = contract?.consumerEvidence;
    return Boolean(
      evidence &&
        'graphql' in evidence &&
        'web' in evidence &&
        typeof evidence.graphql === 'string' &&
        typeof evidence.web === 'string',
    );
  });
  let observed = 0;
  let failed = 0;
  await mapWithConcurrency(candidates, 4, async (window) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONSUMER_PROBE_TIMEOUT_MS);
    try {
      const response = await fetch(consumerProbeUrl(baseUrl, window.contractKey), {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-data-governance-probe-token': token,
        },
        body: JSON.stringify({
          contractKey: window.contractKey,
          scopeKey: window.scopeKey,
          periodKey: window.periodKey,
          eventId: window.eventId,
          sourceDay: window.sourceDay,
          producerRevision: window.producerRevision,
          expectedCount: window.expectedCount,
          observedCount: window.observedCount,
        }),
        signal: controller.signal,
      });
      const payload = (await response.json().catch(() => null)) as ConsumerProbePayload | null;
      const graphqlSeenAt = probeTimestamp(payload?.graphqlSeenAt);
      const webSeenAt = probeTimestamp(payload?.webSeenAt);
      const graphqlRevision = probeRevision(payload?.graphqlRevision);
      const webRevision = probeRevision(payload?.webRevision);
      if (
        !response.ok ||
        payload?.success !== true ||
        payload.contractKey !== window.contractKey ||
        payload.scopeKey !== window.scopeKey ||
        !graphqlSeenAt ||
        !webSeenAt ||
        !graphqlRevision ||
        !webRevision ||
        typeof payload.complete !== 'boolean'
      ) {
        throw new Error('CONSUMER_PROBE_INVALID_RESPONSE');
      }
      const expectedCount = probeCount(payload.expectedCount) ?? window.expectedCount;
      const observedCount = probeCount(payload.observedCount) ?? window.observedCount;
      const status = await recordFreshnessObservation({
        windowId: window.windowId,
        graphqlSeenAt,
        webSeenAt,
        graphqlRevision,
        webRevision,
        expectedCount,
        observedCount,
        completenessStatus: payload.complete ? 'COMPLETE' : 'INCOMPLETE',
        db: input.db,
      });
      if (status !== null) observed += 1;
    } catch (error) {
      failed += 1;
      logInfo('Freshness consumer evidence probe failed', {
        contractKey: window.contractKey,
        windowId: window.windowId,
        error: error instanceof Error ? error.name : 'UnknownError',
      });
    } finally {
      clearTimeout(timeout);
    }
  });
  return { scanned: candidates.length, observed, failed, disabled: false };
}

/**
 * Bind a publication freshness window to an already-reserved scheduler
 * obligation.  Window reservation is deliberately best-effort and happens
 * after the obligation insert, so this small JSON merge lets existing rows
 * carry the exact window identity into the eventual Bull payload as well.
 */
export async function attachFreshnessWindowToSchedulerObligation(input: {
  obligationId: string;
  freshnessWindowId: number;
  db?: DbOrTransaction;
}): Promise<boolean> {
  if (
    !input.obligationId ||
    !Number.isSafeInteger(input.freshnessWindowId) ||
    input.freshnessWindowId <= 0
  ) {
    return false;
  }
  const db = input.db ?? (await getDb());
  const updated = await db
    .update(schedulerObligationsInOps)
    .set({
      evidence: sql`${schedulerObligationsInOps.evidence} || jsonb_build_object(
        'freshnessWindowId', ${input.freshnessWindowId}::bigint,
        'freshnessWindowIds',
        CASE
          WHEN jsonb_typeof(${schedulerObligationsInOps.evidence}->'freshnessWindowIds') = 'array'
            THEN ${schedulerObligationsInOps.evidence}->'freshnessWindowIds'
          ELSE '[]'::jsonb
        END || jsonb_build_array(${input.freshnessWindowId}::bigint)
      )`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(eq(schedulerObligationsInOps.obligationId, input.obligationId))
    .returning({ obligationId: schedulerObligationsInOps.obligationId });
  return updated.length === 1;
}

export async function recordFreshnessObservation(input: {
  windowId: number;
  sourceCheckedAt?: Date;
  pgPublishedAt?: Date;
  redisSeenAt?: Date;
  graphqlSeenAt?: Date;
  webSeenAt?: Date;
  producerRevision?: string | null;
  redisRevision?: string | null;
  graphqlRevision?: string | null;
  webRevision?: string | null;
  expectedCount?: number | null;
  observedCount?: number | null;
  notApplicableCount?: number;
  completenessStatus?: FreshnessCompletenessStatus;
  invalid?: boolean;
  breachCode?: string | null;
  db?: DbHandle;
}): Promise<FreshnessSloStatus | null> {
  const db = input.db ?? (await getDb());
  return db.transaction(async (tx) => {
    // The status machine is monotonic, but the evidence columns are a
    // read/compute/write operation. Lock the row so overlapping publication
    // and consumer probes cannot derive a status from the same stale snapshot
    // and move a window backwards.
    const [current] = await tx
      .select()
      .from(freshnessSloWindowsInOps)
      .where(eq(freshnessSloWindowsInOps.windowId, input.windowId))
      .for('update')
      .limit(1);
    if (!current) return null;
    const completeness =
      input.completenessStatus ??
      (input.invalid ? 'INVALID' : (current.completenessStatus as FreshnessCompletenessStatus));
    const invalid = input.invalid ?? current.status === 'INVALID';
    const windowEvidence = asJsonObject(current.evidence);
    const redisEvidenceRequired = windowEvidence.redisEvidenceRequired !== false;
    const observation = {
      eligible: current.status !== 'NOT_APPLICABLE',
      invalid,
      consumerEvidenceRequired: getConfig().FRESHNESS_CONSUMER_PROBES_ENABLED,
      redisEvidenceRequired,
      dueAt: current.dueAt,
      sourceCheckedAt: input.sourceCheckedAt ?? current.sourceCheckedAt,
      pgPublishedAt: input.pgPublishedAt ?? current.pgPublishedAt,
      redisSeenAt: input.redisSeenAt ?? current.redisSeenAt,
      graphqlSeenAt: input.graphqlSeenAt ?? current.graphqlSeenAt,
      producerRevision: input.producerRevision ?? current.producerRevision,
      redisRevision: input.redisRevision ?? current.redisRevision,
      graphqlRevision: input.graphqlRevision ?? current.graphqlRevision,
      webRevision: input.webRevision ?? current.webRevision,
      expectedCount: input.expectedCount ?? current.expectedCount,
      observedCount: input.observedCount ?? current.observedCount,
      completeness,
      webSeenAt: input.webSeenAt ?? current.webSeenAt,
    } as const;
    const applied = applyFreshnessObservation(current.status as FreshnessSloStatus, observation);
    // `applyFreshnessObservation` preserves historical MET/BREACHED semantics;
    // do not derive a second status path that could demote a settled window.
    const nextStatus = applied.status;
    const updates: Record<string, unknown> = {
      completenessStatus: completeness,
      status: nextStatus,
      breachCode:
        nextStatus === 'BREACHED'
          ? (input.breachCode ?? current.breachCode ?? 'DEADLINE_OR_INCOMPLETE')
          : null,
      updatedAt: sql`clock_timestamp()`,
    };
    // Observation events are partial by design: a Redis/cache probe may arrive
    // before the producer checkpoint. Never overwrite an earlier milestone with
    // undefined (or move an observed timestamp backwards).
    const milestoneFields = [
      ['sourceCheckedAt', input.sourceCheckedAt],
      ['pgPublishedAt', input.pgPublishedAt],
      ['redisSeenAt', input.redisSeenAt],
      ['graphqlSeenAt', input.graphqlSeenAt],
      ['webSeenAt', input.webSeenAt],
      ['producerRevision', input.producerRevision],
      ['redisRevision', input.redisRevision],
      ['graphqlRevision', input.graphqlRevision],
      ['webRevision', input.webRevision],
      ['expectedCount', input.expectedCount],
      ['observedCount', input.observedCount],
      ['notApplicableCount', input.notApplicableCount],
    ] as const;
    for (const [field, value] of milestoneFields) {
      if (value === undefined) continue;
      // Milestone timestamps are append-only evidence. A delayed probe can
      // arrive out of order, but it must never move a previously observed
      // source/publication/consumer timestamp backwards. Revision and count
      // fields are snapshots and may legitimately change while a window is
      // pending, so only the timestamp columns use this guard.
      if (
        (field === 'sourceCheckedAt' ||
          field === 'pgPublishedAt' ||
          field === 'redisSeenAt' ||
          field === 'graphqlSeenAt' ||
          field === 'webSeenAt') &&
        current[field] instanceof Date &&
        value instanceof Date &&
        value.getTime() < current[field].getTime()
      ) {
        continue;
      }
      updates[field] = value;
    }
    if (applied.recovered) {
      updates.recoveredAt = sql`COALESCE(${freshnessSloWindowsInOps.recoveredAt}, clock_timestamp())`;
      // Checkpoint contracts intentionally do not require GraphQL/Web
      // evidence.  Preserve the strongest revision available for the hop
      // that actually proved recovery instead of leaving a recovered window
      // without a revision when consumer probes are disabled.
      updates.recoveryRevision =
        input.webRevision ??
        current.webRevision ??
        input.redisRevision ??
        current.redisRevision ??
        input.producerRevision ??
        current.producerRevision ??
        null;
    }
    await tx
      .update(freshnessSloWindowsInOps)
      .set(updates as never)
      .where(eq(freshnessSloWindowsInOps.windowId, input.windowId));
    return nextStatus;
  });
}

export async function listFreshnessWindows(
  input: {
    status?: FreshnessSloStatus | FreshnessSloStatus[];
    recovered?: 'any' | 'unrecovered' | 'recovered';
    dueAfter?: Date;
    dueBefore?: Date;
    limit?: number;
    db?: DbHandle;
  } = {},
) {
  const db = input.db ?? (await getDb());
  const statuses =
    input.status === undefined
      ? undefined
      : Array.isArray(input.status)
        ? input.status
        : [input.status];
  const filters = [
    statuses ? inArray(freshnessSloWindowsInOps.status, statuses) : undefined,
    input.recovered === 'unrecovered'
      ? isNull(freshnessSloWindowsInOps.recoveredAt)
      : input.recovered === 'recovered'
        ? sql`${freshnessSloWindowsInOps.recoveredAt} IS NOT NULL`
        : undefined,
    input.dueAfter ? gte(freshnessSloWindowsInOps.dueAt, input.dueAfter) : undefined,
    input.dueBefore ? lte(freshnessSloWindowsInOps.dueAt, input.dueBefore) : undefined,
  ].filter(Boolean);
  return db
    .select()
    .from(freshnessSloWindowsInOps)
    .where(
      filters.length > 0
        ? and(...(filters as [ReturnType<typeof eq>, ...ReturnType<typeof eq>[]]))
        : undefined,
    )
    .orderBy(asc(freshnessSloWindowsInOps.dueAt), desc(freshnessSloWindowsInOps.windowId))
    .limit(Math.min(1_000_000, Math.max(1, input.limit ?? 100)));
}

/**
 * Keep high-frequency queue telemetry bounded without issuing an unbounded
 * DELETE during an incident. The monitor calls this at most hourly under a
 * Redis lease; each invocation removes a finite number of old rows and the
 * next invocation continues until the retention boundary is caught up.
 */
export async function pruneQueueHealthWindows(
  input: {
    now?: Date;
    retentionDays?: number;
    batchSize?: number;
    maxBatches?: number;
    db?: DbHandle;
  } = {},
): Promise<number> {
  const batchSize = input.batchSize ?? QUEUE_HEALTH_RETENTION_BATCH_SIZE;
  const maxBatches = input.maxBatches ?? QUEUE_HEALTH_RETENTION_MAX_BATCHES;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new Error('Queue health retention batch size must be a positive integer');
  }
  if (!Number.isSafeInteger(maxBatches) || maxBatches < 1) {
    throw new Error('Queue health retention max batches must be a positive integer');
  }
  // Pass timestamps as explicitly typed ISO strings. The postgres driver used
  // by the runtime does not serialize Date instances in generic `sql` chunks;
  // leaving the Date object here makes the hourly retention side-channel fail
  // with ERR_INVALID_ARG_TYPE and silently accumulates queue windows.
  const cutoff = queueHealthRetentionCutoff(input.now, input.retentionDays).toISOString();
  const db = input.db ?? (await getDb());
  let deleted = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const rows = (await db.execute(sql`
      WITH doomed AS (
        SELECT window_start, queue_name
        FROM ops.queue_health_windows
        WHERE window_start < ${cutoff}::timestamptz
        ORDER BY window_start ASC, queue_name ASC
        LIMIT ${batchSize}
      )
      DELETE FROM ops.queue_health_windows AS health
      USING doomed
      WHERE health.window_start = doomed.window_start
        AND health.queue_name = doomed.queue_name
      RETURNING health.queue_name
    `)) as unknown as readonly unknown[];
    deleted += rows.length;
    if (rows.length < batchSize) break;
  }
  return deleted;
}

export async function getFreshnessWindow(windowId: number, db?: DbHandle) {
  const handle = db ?? (await getDb());
  const [row] = await handle
    .select()
    .from(freshnessSloWindowsInOps)
    .where(eq(freshnessSloWindowsInOps.windowId, windowId))
    .limit(1);
  return row ?? null;
}

export async function listQueueHealthWindows(
  input: {
    since?: Date;
    limit?: number;
    /** Return bounded SQL buckets instead of raw one-minute samples. */
    bucket?: 'hour';
    db?: DbHandle;
  } = {},
) {
  const db = input.db ?? (await getDb());
  const limit = Math.min(100_000, Math.max(1, input.limit ?? 500));
  if (input.bucket === 'hour') {
    // A 28-day operator view can contain close to a million one-minute rows
    // across all lanes. Aggregate at the database boundary so the API never
    // materializes that raw history (and so a one-second sampling setting
    // cannot silently change the advertised 28-day response size).
    const bucketStart = sql<Date>`date_trunc('hour', ${queueHealthWindowsInOps.windowStart})`.as(
      'window_start',
    );
    return db
      .select({
        windowStart: bucketStart,
        queueName: queueHealthWindowsInOps.queueName,
        waiting: sql<number>`max(${queueHealthWindowsInOps.waiting})`.as('waiting'),
        active: sql<number>`max(${queueHealthWindowsInOps.active})`.as('active'),
        delayed: sql<number>`max(${queueHealthWindowsInOps.delayed})`.as('delayed'),
        prioritized: sql<number>`max(${queueHealthWindowsInOps.prioritized})`.as('prioritized'),
        waitingChildren: sql<number>`max(${queueHealthWindowsInOps.waitingChildren})`.as(
          'waiting_children',
        ),
        failed: sql<number>`max(${queueHealthWindowsInOps.failed})`.as('failed'),
        completed: sql<number>`max(${queueHealthWindowsInOps.completed})`.as('completed'),
        runnable: sql<number>`max(${queueHealthWindowsInOps.runnable})`.as('runnable'),
        oldestRunnableAgeMs: sql<
          number | null
        >`max(${queueHealthWindowsInOps.oldestRunnableAgeMs})`.as('oldest_runnable_age_ms'),
        arrivals: sql<number>`sum(${queueHealthWindowsInOps.arrivals})`.as('arrivals'),
        completions: sql<number>`sum(${queueHealthWindowsInOps.completions})`.as('completions'),
        failures: sql<number>`sum(${queueHealthWindowsInOps.failures})`.as('failures'),
        stalled: sql<number>`sum(${queueHealthWindowsInOps.stalled})`.as('stalled'),
        waitP50Ms: sql<number | null>`max(${queueHealthWindowsInOps.waitP50Ms})`.as('wait_p50_ms'),
        waitP95Ms: sql<number | null>`max(${queueHealthWindowsInOps.waitP95Ms})`.as('wait_p95_ms'),
        executionP50Ms: sql<number | null>`max(${queueHealthWindowsInOps.executionP50Ms})`.as(
          'execution_p50_ms',
        ),
        executionP95Ms: sql<number | null>`max(${queueHealthWindowsInOps.executionP95Ms})`.as(
          'execution_p95_ms',
        ),
        providerWaitP95Ms: sql<number | null>`max(${queueHealthWindowsInOps.providerWaitP95Ms})`.as(
          'provider_wait_p95_ms',
        ),
        provider429Rate: sql<string | null>`max(${queueHealthWindowsInOps.provider429Rate})`.as(
          'provider_429_rate',
        ),
        netGrowth: sql<number>`sum(${queueHealthWindowsInOps.netGrowth})`.as('net_growth'),
        drainEtaMs: sql<number | null>`max(${queueHealthWindowsInOps.drainEtaMs})`.as(
          'drain_eta_ms',
        ),
        // The lexical max is intentionally conservative only for display;
        // the raw rows remain available for incident forensics.  A bucket
        // with any red sample is never presented as HEALTHY by the API.
        backlogClass: sql<string>`CASE
          WHEN bool_or(${queueHealthWindowsInOps.backlogClass} = 'NO_CONSUMER') THEN 'NO_CONSUMER'
          WHEN bool_or(${queueHealthWindowsInOps.backlogClass} = 'POISON_STORM') THEN 'POISON_STORM'
          WHEN bool_or(${queueHealthWindowsInOps.backlogClass} = 'STALLED') THEN 'STALLED'
          WHEN bool_or(${queueHealthWindowsInOps.backlogClass} = 'DEADLINE_RISK') THEN 'DEADLINE_RISK'
          WHEN bool_or(${queueHealthWindowsInOps.backlogClass} = 'PROVIDER_THROTTLED') THEN 'PROVIDER_THROTTLED'
          WHEN bool_or(${queueHealthWindowsInOps.backlogClass} = 'BURST') THEN 'BURST'
          ELSE 'HEALTHY'
        END`.as('backlog_class'),
        admissionMode:
          sql<string>`CASE WHEN bool_or(${queueHealthWindowsInOps.admissionMode} = 'DRAIN_ONLY') THEN 'DRAIN_ONLY' ELSE 'OPEN' END`.as(
            'admission_mode',
          ),
        consumerHeartbeatAt:
          sql<Date | null>`max(${queueHealthWindowsInOps.consumerHeartbeatAt})`.as(
            'consumer_heartbeat_at',
          ),
        releaseSha: sql<string | null>`max(${queueHealthWindowsInOps.releaseSha})`.as(
          'release_sha',
        ),
        evidence: sql<Record<string, unknown>>`jsonb_build_object('granularity', 'hour')`.as(
          'evidence',
        ),
        createdAt: sql<Date>`min(${queueHealthWindowsInOps.createdAt})`.as('created_at'),
        updatedAt: sql<Date>`max(${queueHealthWindowsInOps.updatedAt})`.as('updated_at'),
      })
      .from(queueHealthWindowsInOps)
      .where(input.since ? gte(queueHealthWindowsInOps.windowStart, input.since) : undefined)
      .groupBy(bucketStart, queueHealthWindowsInOps.queueName)
      .orderBy(desc(bucketStart), asc(queueHealthWindowsInOps.queueName))
      .limit(limit);
  }
  return db
    .select()
    .from(queueHealthWindowsInOps)
    .where(input.since ? gte(queueHealthWindowsInOps.windowStart, input.since) : undefined)
    .orderBy(desc(queueHealthWindowsInOps.windowStart), asc(queueHealthWindowsInOps.queueName))
    .limit(limit);
}

/**
 * Mark overdue windows without pretending that a missing consumer probe is a
 * successful publication. The observer is intentionally bounded so one bad
 * day cannot monopolise the governance worker.
 */
export async function observeDueFreshnessWindows(
  input: {
    now?: Date;
    limit?: number;
    db?: DbHandle;
  } = {},
): Promise<{ scanned: number; breached: number; cases: number }> {
  const now = input.now ?? new Date();
  const windows = await listFreshnessWindows({
    status: ['PENDING', 'INVALID'],
    dueBefore: now,
    limit: Math.min(100, Math.max(1, input.limit ?? 100)),
    db: input.db,
  });
  let breached = 0;
  let cases = 0;
  for (const window of windows) {
    const status = await recordFreshnessObservation({
      windowId: window.windowId,
      completenessStatus: window.completenessStatus as FreshnessCompletenessStatus,
      breachCode: 'DEADLINE_OR_INCOMPLETE',
      db: input.db,
    });
    if (status !== 'BREACHED' && status !== 'INVALID') continue;
    if (status === 'BREACHED') breached += 1;
    // Shadow mode is observation-only.  Keep the breached window for
    // baseline/error-budget reporting, but do not create a repair case until
    // enforcement is explicitly enabled.
    if (getConfig().FRESHNESS_SLO_MODE !== 'enforced') continue;
    const contract = dataContractRegistry.find((item) => item.contractKey === window.contractKey);
    const existing = await openGovernanceCase({
      caseKind: 'freshness-breach',
      contractKey: window.contractKey,
      lane: freshnessRepairLaneForWindow(window.contractKey, window.periodKey),
      sloWindowId: window.windowId,
      scopeKey: window.scopeKey,
      targetRevision: window.producerRevision ?? undefined,
      errorClass: 'DATA_INCOMPLETE',
      errorCode: 'FRESHNESS_DEADLINE_OR_INCOMPLETE',
      fingerprint: `${window.sloKey}:${window.scopeKey}:${window.periodKey}`,
      evidence: {
        dueAt: window.dueAt.toISOString(),
        expectedCount: window.expectedCount,
        observedCount: window.observedCount,
        completenessStatus: window.completenessStatus,
      },
      repairTarget: { windowId: window.windowId, eventId: window.eventId },
      compensator: contract?.compensator ?? 'freshness observer and exact contract repair',
      db: input.db,
    });
    if (existing) cases += 1;
  }
  return { scanned: windows.length, breached, cases };
}

export async function openGovernanceCase(input: {
  caseKind: string;
  contractKey: string;
  lane: string;
  obligationId?: string;
  sloWindowId?: number;
  scopeKey: string;
  targetRevision?: string;
  errorClass: string;
  errorCode: string;
  fingerprint: string;
  evidence?: Record<string, unknown>;
  repairTarget?: Record<string, unknown>;
  compensator: string;
  db?: DbHandle;
}) {
  // Shadow mode records freshness breaches in the SLO ledger but must remain
  // observation-only.  Keep this invariant at the case boundary as well as
  // in the overdue observer so a future caller cannot accidentally turn a
  // shadow observation into repair traffic.
  if (input.caseKind === 'freshness-breach' && getConfig().FRESHNESS_SLO_MODE !== 'enforced') {
    return null;
  }
  const db = input.db ?? (await getDb());
  const [row] = await db
    .insert(dataGovernanceCasesInOps)
    .values({
      caseKind: input.caseKind,
      contractKey: input.contractKey,
      lane: input.lane,
      obligationId: input.obligationId,
      sloWindowId: input.sloWindowId,
      scopeKey: input.scopeKey,
      targetRevision: input.targetRevision,
      errorClass: input.errorClass,
      errorCode: input.errorCode,
      fingerprint: input.fingerprint,
      evidence: asJsonObject(input.evidence),
      repairTarget: asJsonObject(input.repairTarget),
      compensator: input.compensator,
    })
    .onConflictDoUpdate({
      target: [
        dataGovernanceCasesInOps.caseKind,
        dataGovernanceCasesInOps.contractKey,
        dataGovernanceCasesInOps.lane,
        dataGovernanceCasesInOps.scopeKey,
        dataGovernanceCasesInOps.fingerprint,
      ],
      targetWhere: sql`status IN ('OPEN','AUTO_REPAIRING','REQUIRES_REVIEW')`,
      set: { updatedAt: sql`clock_timestamp()`, evidence: asJsonObject(input.evidence) },
    })
    .returning();
  logInfo('Data governance case opened or refreshed', {
    caseId: row?.caseId,
    caseKind: input.caseKind,
    errorCode: input.errorCode,
  });
  return row;
}

export async function listGovernanceCases(
  input: {
    status?: GovernanceCaseStatus | GovernanceCaseStatus[];
    limit?: number;
    /** Claimable workers use oldest-first ordering; operator feeds stay newest-first. */
    order?: 'updated-desc' | 'claimable-asc';
    db?: DbHandle;
  } = {},
) {
  const db = input.db ?? (await getDb());
  const statuses =
    input.status === undefined
      ? undefined
      : Array.isArray(input.status)
        ? input.status
        : [input.status];
  const query = db
    .select()
    .from(dataGovernanceCasesInOps)
    .where(statuses ? inArray(dataGovernanceCasesInOps.status, statuses) : undefined);
  if (input.order === 'claimable-asc') {
    return query
      .orderBy(asc(dataGovernanceCasesInOps.updatedAt), asc(dataGovernanceCasesInOps.caseId))
      .limit(Math.min(500, Math.max(1, input.limit ?? 100)));
  }
  return query
    .orderBy(desc(dataGovernanceCasesInOps.updatedAt), desc(dataGovernanceCasesInOps.caseId))
    .limit(Math.min(500, Math.max(1, input.limit ?? 100)));
}

/** Return the unbounded case total separately from the bounded operator feed. */
export async function countGovernanceCases(
  input:
    | {
        status?: GovernanceCaseStatus | GovernanceCaseStatus[];
        db?: DbHandle;
      }
    | DbHandle = {},
): Promise<number> {
  const handle = 'select' in input ? input : (input.db ?? (await getDb()));
  const statuses = 'select' in input ? undefined : input.status;
  const statusValues =
    statuses === undefined ? undefined : Array.isArray(statuses) ? statuses : [statuses];
  const [row] = await handle
    .select({ count: count() })
    .from(dataGovernanceCasesInOps)
    .where(statusValues ? inArray(dataGovernanceCasesInOps.status, statusValues) : undefined);
  return Number(row?.count ?? 0);
}

export async function transitionGovernanceCase(input: {
  caseId: number;
  expectedUpdatedAt: Date;
  action: 'dry-run' | 'execute' | 'dismiss';
  db?: DbHandle;
}): Promise<boolean> {
  const db = input.db ?? (await getDb());
  const nextStatus =
    input.action === 'dismiss'
      ? 'DISMISSED'
      : input.action === 'execute'
        ? // Keep the case claimable. The governance worker owns the repair
          // identity/deadline CAS; moving here to AUTO_REPAIRING with null
          // fields would make the next recheck classify it as malformed.
          'OPEN'
        : 'REQUIRES_REVIEW';
  const result = await db
    .update(dataGovernanceCasesInOps)
    .set({
      status: nextStatus,
      ...(input.action === 'execute' ? { attempts: 0 } : {}),
      repairJobId: null,
      repairDeadlineAt: null,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(dataGovernanceCasesInOps.caseId, input.caseId),
        eq(dataGovernanceCasesInOps.updatedAt, input.expectedUpdatedAt),
        inArray(dataGovernanceCasesInOps.status, ['OPEN', 'REQUIRES_REVIEW']),
        input.action === 'execute'
          ? eq(dataGovernanceCasesInOps.caseKind, 'freshness-breach')
          : undefined,
      ),
    )
    .returning({ caseId: dataGovernanceCasesInOps.caseId });
  return result.length === 1;
}

/**
 * Release a repair claim only after its bounded settlement window has elapsed.
 * This prevents the minute-level case recheck from dispatching duplicate work
 * while the producer job is still running or its publication evidence is
 * still propagating through the outbox/cache.
 */
export async function reopenExpiredGovernanceCaseRepair(input: {
  caseId: number;
  expectedUpdatedAt: Date;
  db?: DbHandle;
}): Promise<boolean> {
  const db = input.db ?? (await getDb());
  const result = await db
    .update(dataGovernanceCasesInOps)
    .set({
      status: 'OPEN',
      repairJobId: null,
      repairDeadlineAt: null,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(dataGovernanceCasesInOps.caseId, input.caseId),
        eq(dataGovernanceCasesInOps.updatedAt, input.expectedUpdatedAt),
        eq(dataGovernanceCasesInOps.status, 'AUTO_REPAIRING'),
        sql`${dataGovernanceCasesInOps.repairDeadlineAt} IS NOT NULL`,
        sql`${dataGovernanceCasesInOps.repairDeadlineAt} <= clock_timestamp()`,
      ),
    )
    .returning({ caseId: dataGovernanceCasesInOps.caseId });
  return result.length === 1;
}

/**
 * Claim one case for a bounded automatic repair attempt.  The timestamp and
 * attempt cap form a small CAS fence so two governance workers cannot both
 * dispatch the same repair, and a permanently broken source cannot be
 * hammered forever.
 */
export async function claimGovernanceCaseRepair(input: {
  caseId: number;
  expectedUpdatedAt: Date;
  repairJobId: string;
  settlementMs: number;
  db?: DbHandle;
}) {
  if (input.repairJobId.trim().length === 0) throw new Error('Repair job id is required');
  if (!Number.isSafeInteger(input.settlementMs) || input.settlementMs < 1_000) {
    throw new Error('Repair settlement window must be at least one second');
  }
  const db = input.db ?? (await getDb());
  const [row] = await db
    .update(dataGovernanceCasesInOps)
    .set({
      status: 'AUTO_REPAIRING',
      attempts: sql`${dataGovernanceCasesInOps.attempts} + 1`,
      repairJobId: input.repairJobId,
      repairDeadlineAt: sql`clock_timestamp() + ${input.settlementMs} * interval '1 millisecond'`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(dataGovernanceCasesInOps.caseId, input.caseId),
        eq(dataGovernanceCasesInOps.updatedAt, input.expectedUpdatedAt),
        inArray(dataGovernanceCasesInOps.status, ['OPEN', 'AUTO_REPAIRING']),
        sql`${dataGovernanceCasesInOps.repairJobId} IS NULL`,
        lt(dataGovernanceCasesInOps.attempts, 2),
      ),
    )
    .returning();
  return row ?? null;
}

export async function updateGovernanceCaseStatus(input: {
  caseId: number;
  expectedUpdatedAt: Date;
  status: Extract<GovernanceCaseStatus, 'RECOVERED' | 'REQUIRES_REVIEW'>;
  lastError?: string | null;
  recoveryRevision?: string | null;
  db?: DbHandle;
}): Promise<boolean> {
  const db = input.db ?? (await getDb());
  const [row] = await db
    .update(dataGovernanceCasesInOps)
    .set({
      status: input.status,
      ...(input.lastError === undefined ? {} : { lastError: input.lastError }),
      ...(input.status === 'RECOVERED'
        ? {
            recoveredAt: sql`COALESCE(${dataGovernanceCasesInOps.recoveredAt}, clock_timestamp())`,
            recoveryRevision: input.recoveryRevision ?? null,
          }
        : {}),
      repairJobId: null,
      repairDeadlineAt: null,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(dataGovernanceCasesInOps.caseId, input.caseId),
        eq(dataGovernanceCasesInOps.updatedAt, input.expectedUpdatedAt),
        inArray(dataGovernanceCasesInOps.status, ['OPEN', 'AUTO_REPAIRING', 'REQUIRES_REVIEW']),
      ),
    )
    .returning({ caseId: dataGovernanceCasesInOps.caseId });
  return row !== undefined;
}
