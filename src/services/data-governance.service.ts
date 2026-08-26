import { and, asc, desc, eq, gte, inArray, lt, sql } from 'drizzle-orm';

import {
  dataGovernanceCasesInOps,
  freshnessSloWindowsInOps,
  queueHealthWindowsInOps,
  schedulerObligationsInOps,
} from '../db/schemas/index.schema';
import { getDb, type DbHandle } from '../db/singleton';
import type { DataPublicationManifest } from '../cache/data-publication';
import {
  applyFreshnessObservation,
  evaluateFreshnessWindow,
  type FreshnessCompletenessStatus,
  type FreshnessSloStatus,
} from '../domain/freshness-slo';
import { dataContractRegistry } from '../domain/data-contracts';
import { logInfo } from '../utils/logger';

export type GovernanceCaseStatus =
  | 'OPEN'
  | 'AUTO_REPAIRING'
  | 'REQUIRES_REVIEW'
  | 'RECOVERED'
  | 'DISMISSED';

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
 * that produced it.  The source run is the join key: matching only season or
 * event would let a late publication accidentally settle an older bucket.
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
  if (!contractKey || !input.sourceRunId) return 0;
  const db = input.db ?? (await getDb());
  const windows = await db
    .select({ windowId: freshnessSloWindowsInOps.windowId })
    .from(freshnessSloWindowsInOps)
    .innerJoin(
      schedulerObligationsInOps,
      and(
        eq(schedulerObligationsInOps.scopeKey, freshnessSloWindowsInOps.scopeKey),
        eq(schedulerObligationsInOps.periodKey, freshnessSloWindowsInOps.periodKey),
      ),
    )
    .where(
      and(
        eq(schedulerObligationsInOps.runId, input.sourceRunId),
        eq(freshnessSloWindowsInOps.contractKey, contractKey),
        inArray(freshnessSloWindowsInOps.status, ['PENDING', 'BREACHED', 'INVALID']),
      ),
    )
    .limit(20);
  if (windows.length === 0) return 0;

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
  for (const window of windows) {
    const status = await recordFreshnessObservation({
      windowId: window.windowId,
      ...observation,
      db,
    });
    if (status !== null) updated += 1;
  }
  return updated;
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
  const [current] = await db
    .select()
    .from(freshnessSloWindowsInOps)
    .where(eq(freshnessSloWindowsInOps.windowId, input.windowId))
    .limit(1);
  if (!current) return null;
  const completeness =
    input.completenessStatus ??
    (input.invalid ? 'INVALID' : (current.completenessStatus as FreshnessCompletenessStatus));
  const invalid = input.invalid ?? current.status === 'INVALID';
  const observation = {
    eligible: current.status !== 'NOT_APPLICABLE',
    invalid,
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
  const status = evaluateFreshnessWindow(observation);
  const applied = applyFreshnessObservation(current.status as FreshnessSloStatus, observation);
  const nextStatus = current.status === 'BREACHED' ? 'BREACHED' : status;
  const updates: Record<string, unknown> = {
    completenessStatus: completeness,
    status: nextStatus,
    breachCode:
      input.breachCode ??
      (nextStatus === 'BREACHED' ? (current.breachCode ?? 'DEADLINE_OR_INCOMPLETE') : null),
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
    updates.recoveryRevision = input.webRevision ?? current.webRevision ?? null;
  }
  await db
    .update(freshnessSloWindowsInOps)
    .set(updates as never)
    .where(eq(freshnessSloWindowsInOps.windowId, input.windowId));
  return nextStatus;
}

export async function listFreshnessWindows(
  input: {
    status?: FreshnessSloStatus | FreshnessSloStatus[];
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
    input.dueAfter ? gte(freshnessSloWindowsInOps.dueAt, input.dueAfter) : undefined,
    input.dueBefore ? sql`${freshnessSloWindowsInOps.dueAt} <= ${input.dueBefore}` : undefined,
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
    .limit(Math.min(5_000, Math.max(1, input.limit ?? 100)));
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
  input: { since?: Date; limit?: number; db?: DbHandle } = {},
) {
  const db = input.db ?? (await getDb());
  return db
    .select()
    .from(queueHealthWindowsInOps)
    .where(input.since ? gte(queueHealthWindowsInOps.windowStart, input.since) : undefined)
    .orderBy(desc(queueHealthWindowsInOps.windowStart), asc(queueHealthWindowsInOps.queueName))
    .limit(Math.min(1_000, Math.max(1, input.limit ?? 500)));
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
    const contract = dataContractRegistry.find((item) => item.contractKey === window.contractKey);
    const existing = await openGovernanceCase({
      caseKind: 'freshness-breach',
      contractKey: window.contractKey,
      lane: contract?.queueLane ?? window.contractKey,
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
  return db
    .select()
    .from(dataGovernanceCasesInOps)
    .where(statuses ? inArray(dataGovernanceCasesInOps.status, statuses) : undefined)
    .orderBy(desc(dataGovernanceCasesInOps.updatedAt), desc(dataGovernanceCasesInOps.caseId))
    .limit(Math.min(500, Math.max(1, input.limit ?? 100)));
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
        ? 'AUTO_REPAIRING'
        : 'REQUIRES_REVIEW';
  const result = await db
    .update(dataGovernanceCasesInOps)
    .set({ status: nextStatus, updatedAt: sql`clock_timestamp()` })
    .where(
      and(
        eq(dataGovernanceCasesInOps.caseId, input.caseId),
        eq(dataGovernanceCasesInOps.updatedAt, input.expectedUpdatedAt),
        inArray(dataGovernanceCasesInOps.status, ['OPEN', 'REQUIRES_REVIEW']),
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
  db?: DbHandle;
}) {
  const db = input.db ?? (await getDb());
  const [row] = await db
    .update(dataGovernanceCasesInOps)
    .set({
      status: 'AUTO_REPAIRING',
      attempts: sql`${dataGovernanceCasesInOps.attempts} + 1`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(dataGovernanceCasesInOps.caseId, input.caseId),
        eq(dataGovernanceCasesInOps.updatedAt, input.expectedUpdatedAt),
        inArray(dataGovernanceCasesInOps.status, ['OPEN', 'AUTO_REPAIRING']),
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
