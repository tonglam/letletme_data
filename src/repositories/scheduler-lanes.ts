import { randomUUID } from 'node:crypto';

import { and, asc, eq, exists, inArray, isNull, lte, or, sql, type SQLWrapper } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import {
  dataGovernanceCasesInOps,
  freshnessSloWindowsInOps,
  schedulerLanesInOps,
  schedulerObligationsInOps,
} from '../db/schemas/index.schema';
import { getDb, type DbHandle, type DbOrTransaction } from '../db/singleton';
import { contractForSchedulerJob, contractHasFreshnessWindow } from '../domain/data-contracts';
import { retryPolicyForError, summarizeDataError } from '../domain/error-classification';
import { isFplSeasonCode } from '../domain/fpl-season';
import {
  reserveSchedulerObligation,
  type SchedulerObligation,
  type SchedulerObligationStatus,
} from './scheduler-obligations';

export type SchedulerLaneState = 'idle' | 'dispatching' | 'enqueued' | 'running' | 'blocked';

export type SchedulerLane = Readonly<{
  laneId: string;
  laneKey: string;
  jobName: string;
  scopeKey: string;
  queueName: string;
  state: SchedulerLaneState;
  desiredObligationId: string;
  desiredDueAt: Date;
  activeObligationId: string | null;
  dispatchGeneration: number;
  dispatchOwner: string | null;
  dispatchLeaseExpiresAt: Date | null;
  bullJobId: string | null;
  runId: string | null;
  blockerJobId: string | null;
  retryNotBefore: Date | null;
  lastError: string | null;
  lastProgressAt: Date;
  supersededCount: number;
  updatedAt: Date;
}>;

export type SchedulerLaneTarget = Readonly<{
  lane: SchedulerLane;
  obligation: SchedulerObligation;
}>;

/** Identity checked while a latest-authoritative worker activates a publication. */
export type SchedulerLanePublicationFence = Readonly<{
  laneId: string;
  dispatchGeneration: number;
  activeObligationId: string;
}>;

export type SchedulerLaneDispatch = Readonly<{
  lane: SchedulerLane;
  owner: string;
}>;

const DISPATCH_LEASE_MS = 2 * 60_000;
const RETRY_DELAY_MS = 60_000;
const BLOCKED_RETRY_DELAY_MS = 5 * 60_000;
const LANE_SUPERSEDED_REASON = 'superseded-by-latest-authoritative';
const CUTOVER_SUPERSEDED_REASON = 'cutover-superseded';
const CORE_SOURCE_SUPERSEDED_REASON = 'core-source-superseded';
const STALE_SEASON_REASON = 'stale-job-season';

/**
 * Evidence copied from a provisional price watcher is only valid for the
 * exact bootstrap that was captured.  Once a Core repair loses its source
 * ordering race, a replacement price obligation must fetch a fresh source
 * instead of replaying the incompatible artifact forever.
 */
const PRICE_SOURCE_EVIDENCE_KEYS = [
  'sourceHash',
  'sourceArtifactId',
  'priceChangeBoardRevision',
  'sourceDetectedAt',
  'sourceFetchedAt',
  'blockerJobId',
  'corePlayerCount',
  'corePlayerDelta',
] as const;

export function withoutPriceChangeSourceEvidence(
  evidence: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...evidence };
  for (const key of PRICE_SOURCE_EVIDENCE_KEYS) delete result[key];
  return result;
}

function asDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const result = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(result.getTime())) throw new Error('Invalid scheduler lane timestamp');
  return result;
}

function mapLane(row: typeof schedulerLanesInOps.$inferSelect): SchedulerLane {
  const desiredDueAt = asDate(row.desiredDueAt);
  const lastProgressAt = asDate(row.lastProgressAt);
  if (!desiredDueAt || !lastProgressAt) throw new Error('Scheduler lane timestamps are invalid');
  return {
    laneId: row.laneId,
    laneKey: row.laneKey,
    jobName: row.jobName,
    scopeKey: row.scopeKey,
    queueName: row.queueName,
    state: row.state as SchedulerLaneState,
    desiredObligationId: row.desiredObligationId,
    desiredDueAt,
    activeObligationId: row.activeObligationId,
    dispatchGeneration: row.dispatchGeneration,
    dispatchOwner: row.dispatchOwner,
    dispatchLeaseExpiresAt: asDate(row.dispatchLeaseExpiresAt),
    bullJobId: row.bullJobId,
    runId: row.runId,
    blockerJobId: row.blockerJobId,
    retryNotBefore: asDate(row.retryNotBefore),
    lastError: row.lastError,
    lastProgressAt,
    supersededCount: row.supersededCount,
    updatedAt: row.updatedAt,
  };
}

function mapObligation(row: typeof schedulerObligationsInOps.$inferSelect): SchedulerObligation {
  return {
    obligationId: row.obligationId,
    jobName: row.jobName,
    scopeKey: row.scopeKey,
    periodKey: row.periodKey,
    cadence: row.cadence,
    timezone: row.timezone,
    status: row.status as SchedulerObligationStatus,
    source: row.source as SchedulerObligation['source'],
    dueAt: row.dueAt,
    generation: row.generation,
    attempts: row.attempts,
    bullJobId: row.bullJobId,
    runId: row.runId,
    completedAt: row.completedAt,
    leaseOwner: row.leaseOwner,
    leaseExpiresAt: row.leaseExpiresAt,
    evidence: (row.evidence ?? {}) as Record<string, unknown>,
  };
}

type SchedulerObligationSqlTable = {
  evidence: SQLWrapper;
  dueAt: SQLWrapper;
};

function scheduledDueAtSql(table: SchedulerObligationSqlTable = schedulerObligationsInOps) {
  return sql`CASE
    WHEN ${table.evidence}->>'scheduledDueAtMs' ~ '^[0-9]+$'
      AND (${table.evidence}->>'scheduledDueAtMs')::numeric BETWEEN 0 AND 8640000000000000
      THEN to_timestamp((${table.evidence}->>'scheduledDueAtMs')::double precision / 1000)
    ELSE ${table.dueAt}
  END`;
}

function terminalEvidence(evidence: Record<string, unknown>) {
  return sql`${JSON.stringify(evidence)}::jsonb || CASE
    WHEN ${schedulerObligationsInOps.evidence} ? 'scheduledDueAtMs'
      THEN jsonb_build_object('scheduledDueAtMs', ${schedulerObligationsInOps.evidence}->'scheduledDueAtMs')
    ELSE '{}'::jsonb
  END || CASE
    WHEN ${schedulerObligationsInOps.evidence} ? 'freshnessWindowId'
      THEN jsonb_build_object(
        'freshnessWindowId', ${schedulerObligationsInOps.evidence}->'freshnessWindowId'
      )
    ELSE '{}'::jsonb
  END || CASE
    WHEN ${schedulerObligationsInOps.evidence} ? 'freshnessWindowIds'
      THEN jsonb_build_object(
        'freshnessWindowIds', ${schedulerObligationsInOps.evidence}->'freshnessWindowIds'
      )
    ELSE '{}'::jsonb
  END || CASE
    WHEN ${schedulerObligationsInOps.evidence} ? 'decisionObservedAt'
      THEN jsonb_build_object(
        'decisionObservedAt', ${schedulerObligationsInOps.evidence}->'decisionObservedAt'
      )
    ELSE '{}'::jsonb
  END || CASE
    WHEN ${schedulerObligationsInOps.evidence} ? 'decisionObservedAtMs'
      THEN jsonb_build_object(
        'decisionObservedAtMs', ${schedulerObligationsInOps.evidence}->'decisionObservedAtMs'
      )
    ELSE '{}'::jsonb
  END || CASE
    WHEN ${schedulerObligationsInOps.evidence} ? 'dependencyWaitCount'
      THEN jsonb_build_object(
        'dependencyWaitCount', ${schedulerObligationsInOps.evidence}->'dependencyWaitCount'
      )
    ELSE '{}'::jsonb
  END || CASE
    WHEN ${schedulerObligationsInOps.evidence} ? 'firstDependencyWaitAt'
      THEN jsonb_build_object(
        'firstDependencyWaitAt', ${schedulerObligationsInOps.evidence}->'firstDependencyWaitAt'
      )
    ELSE '{}'::jsonb
  END || CASE
    WHEN ${schedulerObligationsInOps.evidence} ? 'lastDependencyReasonCodes'
      THEN jsonb_build_object(
        'lastDependencyReasonCodes', ${schedulerObligationsInOps.evidence}->'lastDependencyReasonCodes'
      )
    ELSE '{}'::jsonb
  END || CASE
    WHEN ${schedulerObligationsInOps.evidence} ? 'deferDelayMs'
      THEN jsonb_build_object(
        'deferDelayMs', ${schedulerObligationsInOps.evidence}->'deferDelayMs'
      )
    ELSE '{}'::jsonb
  END`;
}

function scheduledDueAt(obligation: SchedulerObligation): Date {
  const raw = obligation.evidence.scheduledDueAtMs;
  if (typeof raw === 'number' && Number.isSafeInteger(raw)) {
    const parsed = new Date(raw);
    if (Number.isFinite(parsed.getTime())) return parsed;
  }
  if (typeof raw === 'string' && /^[0-9]+$/.test(raw)) {
    const parsed = new Date(Number(raw));
    if (Number.isFinite(parsed.getTime())) return parsed;
  }
  return obligation.dueAt;
}

/**
 * Live snapshots are latest-authoritative by the time the scheduler made the
 * decision, rather than by the five-minute bucket that happened to contain
 * that decision. Keep the immutable scheduled boundary available for SLO
 * accounting, but use the observed decision timestamp to order concurrent
 * reservations and supersession.
 */
export function schedulerObligationAuthorityAt(obligation: SchedulerObligation): Date {
  if (obligation.jobName === 'live-snapshot') {
    const numeric = obligation.evidence.decisionObservedAtMs;
    if (typeof numeric === 'number' && Number.isSafeInteger(numeric) && numeric >= 0) {
      const parsed = new Date(numeric);
      if (Number.isFinite(parsed.getTime())) return parsed;
    }
    if (typeof numeric === 'string' && /^[0-9]+$/.test(numeric)) {
      const parsed = new Date(Number(numeric));
      if (Number.isFinite(parsed.getTime())) return parsed;
    }
    const iso = obligation.evidence.decisionObservedAt;
    if (typeof iso === 'string') {
      const parsed = new Date(iso);
      if (Number.isFinite(parsed.getTime())) return parsed;
    }
  }
  return scheduledDueAt(obligation);
}

function schedulerObligationAuthorityAtSql(
  jobName: string,
  table: SchedulerObligationSqlTable = schedulerObligationsInOps,
) {
  if (jobName !== 'live-snapshot') return scheduledDueAtSql(table);
  return sql`CASE
    WHEN ${table.evidence}->>'decisionObservedAtMs' ~ '^[0-9]+$'
      AND (${table.evidence}->>'decisionObservedAtMs')::numeric BETWEEN 0 AND 8640000000000000
      THEN to_timestamp((${table.evidence}->>'decisionObservedAtMs')::double precision / 1000)
    WHEN ${table.evidence}->>'decisionObservedAt' ~
      '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$'
      THEN (${table.evidence}->>'decisionObservedAt')::timestamptz
    ELSE ${scheduledDueAtSql(table)}
  END`;
}

function isLegacyPriceChangeInFlight(obligation: SchedulerObligation): boolean {
  if (
    obligation.jobName !== 'price-change-predictions' ||
    !['enqueued', 'running', 'skipped'].includes(obligation.status) ||
    !obligation.bullJobId
  ) {
    return false;
  }
  // Legacy scheduler jobs used scheduler-{obligationId}-g{generation}; the
  // lane producer uses scheduler-lane-{laneId}-g{dispatchGeneration}. Only
  // the former can be waiting in data-sync during a latest-wins cutover.
  return obligation.bullJobId.includes(`scheduler-${obligation.obligationId}-g`);
}

async function loadTarget(
  db: DbHandle,
  lane: SchedulerLane,
  obligationId = lane.desiredObligationId,
): Promise<SchedulerLaneTarget | null> {
  const [row] = await db
    .select()
    .from(schedulerObligationsInOps)
    .where(eq(schedulerObligationsInOps.obligationId, obligationId))
    .limit(1);
  return row ? { lane, obligation: mapObligation(row) } : null;
}

export async function advanceSchedulerLane(input: {
  laneKey: string;
  jobName: string;
  scopeKey: string;
  queueName: string;
  desiredObligation: SchedulerObligation;
  /** Keep retired live freshness windows eligible to record a real breach. */
  preserveFreshnessHistory?: boolean;
  /** Bound one scheduler pass while a hot lane has a large backlog. */
  supersedeBatchSize?: number;
  db?: DbHandle;
}): Promise<{ lane: SchedulerLane; shouldDispatch: boolean }> {
  const db = input.db ?? (await getDb());
  const desiredScheduledDueAt = scheduledDueAt(input.desiredObligation);
  const desiredAuthorityAt = schedulerObligationAuthorityAt(input.desiredObligation);
  return db.transaction(async (tx) => {
    const nowRows = await tx.execute<{ dbNow: Date | string }>(
      sql`SELECT clock_timestamp() AS "dbNow"`,
    );
    const dbNow = asDate(nowRows[0]?.dbNow);
    if (!dbNow) throw new Error('Database clock is unavailable');

    const [existingRow] = await tx
      .select()
      .from(schedulerLanesInOps)
      .where(eq(schedulerLanesInOps.laneKey, input.laneKey))
      .for('update')
      .limit(1);

    let row: typeof schedulerLanesInOps.$inferSelect;
    if (!existingRow) {
      const inserted = await tx
        .insert(schedulerLanesInOps)
        .values({
          laneId: randomUUID(),
          laneKey: input.laneKey,
          jobName: input.jobName,
          scopeKey: input.scopeKey,
          queueName: input.queueName,
          desiredObligationId: input.desiredObligation.obligationId,
          desiredDueAt: desiredScheduledDueAt,
          updatedAt: dbNow,
          lastProgressAt: dbNow,
        })
        // PostgreSQL does not gap-lock a missing unique key under the row
        // lock above. Two scheduler/API replicas can therefore both observe
        // no lane and race the first insert. Let the unique index serialize
        // the creation, then reload the winner below.
        .onConflictDoNothing({ target: schedulerLanesInOps.laneKey })
        .returning();
      if (inserted[0]) {
        row = inserted[0];
      } else {
        const [reloaded] = await tx
          .select()
          .from(schedulerLanesInOps)
          .where(eq(schedulerLanesInOps.laneKey, input.laneKey))
          .for('update')
          .limit(1);
        if (!reloaded) throw new Error('Scheduler lane disappeared after conflict');
        row = reloaded;
      }
    } else {
      row = existingRow;
    }
    // A conflict-safe insert can reload a winner whose desired waterline is
    // older than this caller's obligation. Apply the same latest-wins update
    // to both the ordinary existing-row and insert-conflict paths. Due times
    // are normally unique five-minute buckets, but manual refreshes can create
    // distinct obligations at the same millisecond. Use the immutable
    // periodKey as a deterministic tie-breaker so one equal-time obligation is
    // selected and all peers can be explicitly superseded below.
    const [currentDesiredRow] = await tx
      .select()
      .from(schedulerObligationsInOps)
      .where(eq(schedulerObligationsInOps.obligationId, row.desiredObligationId))
      .limit(1);
    if (!currentDesiredRow) throw new Error('Scheduler lane desired obligation disappeared');
    let currentDesired = mapObligation(currentDesiredRow);

    // A deployment can enable latest-wins while the old data-sync job is still
    // waiting, has just crossed its start fence, or has already completed the
    // flag-on noop before this scheduler pass observes it. Binding that legacy
    // obligation to the new lane would leave a skipped desired row without a
    // critical-queue replacement. Rearm exactly once by retiring the old
    // obligation and inserting a fresh pending identity in this lane
    // transaction. The legacy worker is guaranteed to take its flag-on noop
    // path, so retiring a just-started row is safe; its deterministic Bull
    // completion remains audit evidence and is idempotent against the skipped
    // row.
    if (
      currentDesired.obligationId === input.desiredObligation.obligationId &&
      isLegacyPriceChangeInFlight(currentDesired) &&
      row.state === 'idle' &&
      (!row.activeObligationId || row.activeObligationId === currentDesired.obligationId)
    ) {
      const replacement = await reserveSchedulerObligation({
        definition: {
          name: currentDesired.jobName,
          cadence: currentDesired.cadence,
          timezone: currentDesired.timezone,
        },
        plan: {
          scopeKey: currentDesired.scopeKey,
          periodKey: `${currentDesired.periodKey}-latest-wins-rearm-${randomUUID()}`,
          dueAt: currentDesired.dueAt,
          source: input.desiredObligation.source,
          evidence: {
            ...currentDesired.evidence,
            cutoverRearmedFromObligationId: currentDesired.obligationId,
            cutoverReason: CUTOVER_SUPERSEDED_REASON,
          },
        },
        db: tx,
      });
      const retired = await tx
        .update(schedulerObligationsInOps)
        .set({
          status: 'skipped',
          evidence: sql`${schedulerObligationsInOps.evidence} || ${JSON.stringify({
            terminal: true,
            reason: CUTOVER_SUPERSEDED_REASON,
            supersededByObligationId: replacement.obligationId,
            supersededByPeriodKey: replacement.periodKey,
          })}::jsonb`,
          completedAt: dbNow,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastError: null,
          updatedAt: dbNow,
        })
        .where(
          and(
            eq(schedulerObligationsInOps.obligationId, currentDesired.obligationId),
            inArray(schedulerObligationsInOps.status, ['enqueued', 'running', 'skipped']),
          ),
        )
        .returning();
      if (!retired[0]) throw new Error('Legacy price-change obligation cutover CAS failed');
      const updated = await tx
        .update(schedulerLanesInOps)
        .set({
          state: 'idle',
          desiredObligationId: replacement.obligationId,
          desiredDueAt: scheduledDueAt(replacement),
          activeObligationId: null,
          dispatchOwner: null,
          dispatchLeaseExpiresAt: null,
          bullJobId: null,
          runId: null,
          retryNotBefore: null,
          lastError: null,
          lastProgressAt: dbNow,
          supersededCount: sql`${schedulerLanesInOps.supersededCount} + 1`,
          updatedAt: dbNow,
        })
        .where(eq(schedulerLanesInOps.laneId, row.laneId))
        .returning();
      if (!updated[0]) throw new Error('Scheduler lane cutover rearm update returned no row');
      row = updated[0];
      currentDesired = replacement;
    }

    // The rearm path above may have changed the selected target before the
    // ordinary latest-wins comparison. Read the row's waterline from the
    // selected obligation below rather than relying on the original snapshot.
    const currentDesiredScheduledDueAt = schedulerObligationAuthorityAt(currentDesired);
    const desiredIsNewer =
      desiredAuthorityAt.getTime() > currentDesiredScheduledDueAt.getTime() ||
      (desiredAuthorityAt.getTime() === currentDesiredScheduledDueAt.getTime() &&
        input.desiredObligation.periodKey > currentDesired.periodKey);
    if (desiredIsNewer) {
      const updated = await tx
        .update(schedulerLanesInOps)
        .set({
          desiredObligationId: input.desiredObligation.obligationId,
          desiredDueAt: desiredScheduledDueAt,
          updatedAt: dbNow,
        })
        .where(eq(schedulerLanesInOps.laneId, row.laneId))
        .returning();
      if (!updated[0]) throw new Error('Scheduler lane update returned no row');
      row = updated[0];
    }

    // Read the selected waterline back after the update. Supersession must use
    // the persisted winner rather than this caller's obligation: a concurrent
    // equal-time manual request may lose the period-key tie-breaker.
    const [selectedDesiredRow] = await tx
      .select()
      .from(schedulerObligationsInOps)
      .where(eq(schedulerObligationsInOps.obligationId, row.desiredObligationId))
      .limit(1);
    if (!selectedDesiredRow) throw new Error('Scheduler lane selected obligation disappeared');
    const selectedDesired = mapObligation(selectedDesiredRow);
    const selectedScheduledDueAt = schedulerObligationAuthorityAt(selectedDesired);

    // Waiting generations have no useful work once a newer desired period is
    // known. Keep an active target intact so its publication fence can decide
    // the linearization point; the worker will adopt the newer target before
    // it writes if the desired row changed first. Equal-time peers are ordered
    // by periodKey and the non-selected one is terminalized explicitly.
    const immutableDueAt = schedulerObligationAuthorityAtSql(input.jobName);
    const selectedDueAtIso = selectedScheduledDueAt.toISOString();
    const supersessionPredicate = and(
      eq(schedulerObligationsInOps.jobName, input.jobName),
      eq(schedulerObligationsInOps.scopeKey, input.scopeKey),
      sql`(
        ${immutableDueAt} < ${selectedDueAtIso}
        OR (
          ${immutableDueAt} = ${selectedDueAtIso}
          AND ${schedulerObligationsInOps.periodKey} < ${selectedDesired.periodKey}
        )
      )`,
      inArray(schedulerObligationsInOps.status, ['pending', 'failed', 'enqueued']),
      row.activeObligationId
        ? sql`${schedulerObligationsInOps.obligationId} <> ${row.activeObligationId}`
        : undefined,
      sql`${schedulerObligationsInOps.obligationId} <> ${selectedDesired.obligationId}`,
    );
    const configuredBatchSize = input.supersedeBatchSize ?? Number.MAX_SAFE_INTEGER;
    const supersedeBatchSize = Math.max(1, Math.min(Number.MAX_SAFE_INTEGER, configuredBatchSize));
    const supersedableCandidates = await tx
      .select({
        obligationId: schedulerObligationsInOps.obligationId,
        periodKey: schedulerObligationsInOps.periodKey,
      })
      .from(schedulerObligationsInOps)
      .where(supersessionPredicate)
      .orderBy(sql`${immutableDueAt} ASC`, asc(schedulerObligationsInOps.periodKey))
      .limit(supersedeBatchSize);
    const supersedable =
      supersedableCandidates.length === 0
        ? []
        : await tx
            .update(schedulerObligationsInOps)
            .set({
              status: 'skipped',
              evidence: sql`${schedulerObligationsInOps.evidence} || ${JSON.stringify({
                terminal: true,
                reason: LANE_SUPERSEDED_REASON,
                supersededByObligationId: selectedDesired.obligationId,
                supersededByPeriodKey: selectedDesired.periodKey,
              })}::jsonb`,
              completedAt: dbNow,
              leaseOwner: null,
              lastError: null,
              leaseExpiresAt: null,
              updatedAt: dbNow,
            })
            .where(
              and(
                inArray(
                  schedulerObligationsInOps.obligationId,
                  supersedableCandidates.map((candidate) => candidate.obligationId),
                ),
                supersessionPredicate,
              ),
            )
            .returning({
              obligationId: schedulerObligationsInOps.obligationId,
              periodKey: schedulerObligationsInOps.periodKey,
            });

    if (supersedable.length > 0) {
      const [counted] = await tx
        .update(schedulerLanesInOps)
        .set({
          supersededCount: sql`${schedulerLanesInOps.supersededCount} + ${supersedable.length}`,
          updatedAt: dbNow,
        })
        .where(eq(schedulerLanesInOps.laneId, row.laneId))
        .returning();
      if (counted) row = counted;
    }

    // A latest-wins target intentionally retires older pending/enqueued
    // obligations. Their freshness windows must leave the eligible SLO
    // denominator as well; otherwise the selected target is the only one that
    // can publish while every superseded window eventually breaches.
    const contract = contractForSchedulerJob(input.jobName);
    const retiredPeriods = supersedable.map((item) => item.periodKey);
    if (input.desiredObligation.obligationId !== selectedDesired.obligationId) {
      // An older replica may insert its window after a newer replica already
      // superseded the obligation. Reconcile this exact persisted identity,
      // including the legacy cutover case, without scanning historical SLOs.
      const [retiredCaller] = await tx
        .select({ periodKey: schedulerObligationsInOps.periodKey })
        .from(schedulerObligationsInOps)
        .where(
          and(
            eq(schedulerObligationsInOps.obligationId, input.desiredObligation.obligationId),
            eq(schedulerObligationsInOps.status, 'skipped'),
            sql`${schedulerObligationsInOps.evidence}->>'reason' IN (${LANE_SUPERSEDED_REASON}, ${CUTOVER_SUPERSEDED_REASON})`,
          ),
        )
        .for('update')
        .limit(1);
      if (retiredCaller && !retiredPeriods.includes(retiredCaller.periodKey)) {
        retiredPeriods.push(retiredCaller.periodKey);
      }
    }
    if (
      retiredPeriods.length > 0 &&
      contract &&
      contractHasFreshnessWindow(contract, input.jobName) &&
      !input.preserveFreshnessHistory
    ) {
      const retiredWindows = await tx
        .update(freshnessSloWindowsInOps)
        .set({
          status: 'NOT_APPLICABLE',
          completenessStatus: 'NOT_APPLICABLE',
          breachCode: null,
          evidence: sql`${freshnessSloWindowsInOps.evidence} || ${JSON.stringify({
            reason: 'SUPERSEDED_BY_LATEST',
            supersededByPeriodKey: selectedDesired.periodKey,
          })}::jsonb`,
          updatedAt: dbNow,
        })
        .where(
          and(
            eq(freshnessSloWindowsInOps.contractKey, contract.contractKey),
            eq(freshnessSloWindowsInOps.sloKey, contract.contractKey),
            eq(freshnessSloWindowsInOps.scopeKey, input.scopeKey),
            inArray(freshnessSloWindowsInOps.periodKey, retiredPeriods),
            inArray(freshnessSloWindowsInOps.status, ['PENDING', 'INVALID', 'BREACHED']),
          ),
        )
        .returning({ windowId: freshnessSloWindowsInOps.windowId });
      if (retiredWindows.length > 0) {
        await tx
          .update(dataGovernanceCasesInOps)
          .set({
            status: 'DISMISSED',
            lastError: null,
            repairJobId: null,
            repairDeadlineAt: null,
            evidence: sql`${dataGovernanceCasesInOps.evidence} || ${JSON.stringify({
              reason: 'SUPERSEDED_BY_LATEST',
              supersededByPeriodKey: selectedDesired.periodKey,
            })}::jsonb`,
            updatedAt: dbNow.toISOString(),
          })
          .where(
            and(
              inArray(
                dataGovernanceCasesInOps.sloWindowId,
                retiredWindows.map((window) => window.windowId),
              ),
              inArray(dataGovernanceCasesInOps.status, [
                'OPEN',
                'AUTO_REPAIRING',
                'REQUIRES_REVIEW',
              ]),
            ),
          );
      }
    }

    const [desiredRow] = await tx
      .select({
        status: schedulerObligationsInOps.status,
        dueAt: schedulerObligationsInOps.dueAt,
      })
      .from(schedulerObligationsInOps)
      .where(eq(schedulerObligationsInOps.obligationId, row.desiredObligationId))
      .limit(1);
    // A terminal desired obligation is authoritative for an idle latest-wins
    // lane. If an older Bull-loss callback left a lane error behind, clear it
    // on the next scheduler observation instead of exposing a false active
    // failure forever. Failed/pending targets retain their current error
    // until the next dispatch begins.
    if (
      row.state === 'idle' &&
      row.lastError !== null &&
      (desiredRow?.status === 'succeeded' || desiredRow?.status === 'skipped')
    ) {
      const [cleared] = await tx
        .update(schedulerLanesInOps)
        .set({ lastError: null, updatedAt: dbNow })
        .where(eq(schedulerLanesInOps.laneId, row.laneId))
        .returning();
      if (cleared) row = cleared;
    }
    const lane = mapLane(row);
    const shouldDispatch =
      lane.state === 'idle' &&
      (desiredRow?.status === 'pending' || desiredRow?.status === 'failed') &&
      (desiredRow?.dueAt === undefined || desiredRow.dueAt.getTime() <= dbNow.getTime()) &&
      (lane.retryNotBefore === null || lane.retryNotBefore.getTime() <= dbNow.getTime());
    return { lane, shouldDispatch };
  });
}

export async function claimSchedulerLaneDispatch(input: {
  laneId: string;
  db?: DbHandle;
}): Promise<SchedulerLaneDispatch | null> {
  const db = input.db ?? (await getDb());
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(schedulerLanesInOps)
      .where(eq(schedulerLanesInOps.laneId, input.laneId))
      .for('update')
      .limit(1);
    if (!row) return null;
    const nowRows = await tx.execute<{ dbNow: Date | string }>(
      sql`SELECT clock_timestamp() AS "dbNow"`,
    );
    const dbNow = asDate(nowRows[0]?.dbNow);
    if (!dbNow) throw new Error('Database clock is unavailable');
    const retryNotBefore = asDate(row.retryNotBefore);
    const reclaimableDispatch =
      row.state === 'dispatching' &&
      row.dispatchLeaseExpiresAt !== null &&
      row.dispatchLeaseExpiresAt.getTime() <= dbNow.getTime();
    if (
      (row.state !== 'idle' && !reclaimableDispatch) ||
      (retryNotBefore !== null && retryNotBefore.getTime() > dbNow.getTime())
    ) {
      return null;
    }
    const [desired] = await tx
      .select({
        status: schedulerObligationsInOps.status,
        dueAt: schedulerObligationsInOps.dueAt,
      })
      .from(schedulerObligationsInOps)
      .where(eq(schedulerObligationsInOps.obligationId, row.desiredObligationId))
      .limit(1);
    if (
      (desired?.status !== 'pending' && desired?.status !== 'failed') ||
      (desired?.dueAt !== undefined && desired.dueAt.getTime() > dbNow.getTime())
    ) {
      return null;
    }
    const owner = randomUUID();
    const updated = await tx
      .update(schedulerLanesInOps)
      .set({
        state: 'dispatching',
        dispatchGeneration: sql`${schedulerLanesInOps.dispatchGeneration} + 1`,
        dispatchOwner: owner,
        dispatchLeaseExpiresAt: new Date(dbNow.getTime() + DISPATCH_LEASE_MS),
        bullJobId: null,
        runId: null,
        // A new dispatch makes any previous terminal error historical. Keep
        // lastError scoped to the current lane state so retrying a failed
        // generation does not report a stale error while it is in flight.
        lastError: null,
        lastProgressAt: dbNow,
        updatedAt: dbNow,
      })
      .where(eq(schedulerLanesInOps.laneId, row.laneId))
      .returning();
    if (!updated[0]) return null;
    return { lane: mapLane(updated[0]), owner };
  });
}

export async function confirmSchedulerLaneEnqueued(input: {
  laneId: string;
  owner: string;
  bullJobId: string | number;
  runId?: string;
  /** Obligation carried by the Bull payload being confirmed. */
  obligationId?: string;
  /** Actual Bull queue used for this lane generation. */
  queueName?: string;
  db?: DbHandle;
}): Promise<boolean> {
  const db = input.db ?? (await getDb());
  return db.transaction(async (tx) => {
    const [lane] = await tx
      .select()
      .from(schedulerLanesInOps)
      .where(eq(schedulerLanesInOps.laneId, input.laneId))
      .for('update')
      .limit(1);
    if (!lane) return false;

    const bullJobId = String(input.bullJobId);
    const obligationId = input.obligationId ?? lane.activeObligationId ?? lane.desiredObligationId;
    const [obligation] = await tx
      .select()
      .from(schedulerObligationsInOps)
      .where(eq(schedulerObligationsInOps.obligationId, obligationId))
      .limit(1);

    // Bull can settle a very short job before this transaction gets the
    // scheduler lock.  The terminal callback has already persisted the
    // accepted Bull identity on the obligation and released the lane, so a
    // late confirmation is an idempotent success rather than a server error.
    // Also accept a retry after the first confirmation while the same Bull job
    // is enqueued/running.  Require the obligation to belong to this lane's
    // job/scope before treating the identity as authoritative.
    const obligationBelongsToLane =
      obligation?.jobName === lane.jobName && obligation.scopeKey === lane.scopeKey;
    const terminalObligation =
      obligationBelongsToLane &&
      obligation?.bullJobId === bullJobId &&
      ['succeeded', 'skipped', 'failed', 'irrecoverable'].includes(obligation.status);
    if (terminalObligation) return true;
    if (
      obligationBelongsToLane &&
      lane.bullJobId === bullJobId &&
      ['enqueued', 'running'].includes(lane.state)
    ) {
      return true;
    }

    if (lane.state !== 'dispatching' || lane.dispatchOwner !== input.owner) return false;
    await tx
      .update(schedulerLanesInOps)
      .set({
        state: 'enqueued',
        dispatchOwner: null,
        dispatchLeaseExpiresAt: null,
        bullJobId,
        runId: input.runId,
        lastError: null,
        lastProgressAt: sql`clock_timestamp()`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(eq(schedulerLanesInOps.laneId, lane.laneId));
    // Keep the accepted Bull identity on the obligation as well as the lane.
    // This lets recovery identify an older enqueued job after the desired
    // waterline has advanced to a newer obligation.
    await tx
      .update(schedulerObligationsInOps)
      .set({
        bullJobId,
        ...(input.runId === undefined ? {} : { runId: input.runId }),
        ...(input.queueName
          ? {
              evidence: sql`${schedulerObligationsInOps.evidence} || jsonb_build_object('submittedQueueName', ${input.queueName}::text)`,
            }
          : {}),
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        eq(schedulerObligationsInOps.obligationId, input.obligationId ?? lane.desiredObligationId),
      );
    return true;
  });
}

export async function failSchedulerLaneDispatch(input: {
  laneId: string;
  owner: string;
  error: unknown;
  db?: DbHandle;
}): Promise<boolean> {
  const db = input.db ?? (await getDb());
  const summary = (input.error instanceof Error ? input.error.message : String(input.error)).slice(
    0,
    4_000,
  );
  const updated = await db
    .update(schedulerLanesInOps)
    .set({
      state: 'idle',
      dispatchOwner: null,
      dispatchLeaseExpiresAt: null,
      retryNotBefore: sql`clock_timestamp() + ${RETRY_DELAY_MS} * interval '1 millisecond'`,
      lastError: summary,
      lastProgressAt: sql`clock_timestamp()`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(schedulerLanesInOps.laneId, input.laneId),
        eq(schedulerLanesInOps.dispatchOwner, input.owner),
        eq(schedulerLanesInOps.state, 'dispatching'),
      ),
    )
    .returning({ laneId: schedulerLanesInOps.laneId });
  return updated.length === 1;
}

export async function startSchedulerLane(input: {
  laneId: string;
  dispatchGeneration: number;
  bullJobId: string | number;
  /** Obligation identity carried by the Bull payload, when available. */
  obligationId?: string;
  runId?: string;
  db?: DbHandle;
}): Promise<SchedulerLaneTarget | null> {
  const db = input.db ?? (await getDb());
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(schedulerLanesInOps)
      .where(
        and(
          eq(schedulerLanesInOps.laneId, input.laneId),
          eq(schedulerLanesInOps.dispatchGeneration, input.dispatchGeneration),
          inArray(schedulerLanesInOps.state, ['dispatching', 'enqueued', 'running']),
        ),
      )
      .for('update')
      .limit(1);
    if (!row) return null;
    const nowRows = await tx.execute<{ dbNow: Date | string }>(
      sql`SELECT clock_timestamp() AS "dbNow"`,
    );
    const dbNow = asDate(nowRows[0]?.dbNow);
    if (!dbNow) throw new Error('Database clock is unavailable');
    if (row.bullJobId !== null && row.bullJobId !== String(input.bullJobId)) {
      return null;
    }
    const requestedObligationId =
      input.obligationId ?? row.activeObligationId ?? row.desiredObligationId;
    const [requestedObligation] = await tx
      .select({
        obligationId: schedulerObligationsInOps.obligationId,
        jobName: schedulerObligationsInOps.jobName,
        scopeKey: schedulerObligationsInOps.scopeKey,
        generation: schedulerObligationsInOps.generation,
      })
      .from(schedulerObligationsInOps)
      .where(eq(schedulerObligationsInOps.obligationId, requestedObligationId))
      .limit(1);
    // Bull payloads are internal, but a stale or malformed payload must not
    // be allowed to borrow a different lane's obligation identity.  The
    // foreign keys protect the desired/active columns; this check protects
    // the worker-provided identity before it can move the lane to `running`.
    if (
      !requestedObligation ||
      requestedObligation.jobName !== row.jobName ||
      requestedObligation.scopeKey !== row.scopeKey
    ) {
      return null;
    }
    if (
      row.jobName === 'live-snapshot' &&
      requestedObligationId !== row.desiredObligationId &&
      ['dispatching', 'enqueued'].includes(row.state)
    ) {
      // A live Bull job can wait in the queue while a newer observation
      // advances the lane waterline.  Do not let the old payload borrow the
      // newer desired identity in this start transaction: retire the exact
      // queued obligation, release this dispatch generation, and let the
      // scheduler enqueue the current target.  The provider and checkpoint
      // stages therefore never start for the stale task.
      const retired = await tx
        .update(schedulerObligationsInOps)
        .set({
          status: 'skipped',
          evidence: terminalEvidence({
            terminal: true,
            reason: LANE_SUPERSEDED_REASON,
            supersededByObligationId: row.desiredObligationId,
          }),
          completedAt: dbNow,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastError: null,
          updatedAt: dbNow,
        })
        .where(
          and(
            eq(schedulerObligationsInOps.obligationId, requestedObligationId),
            inArray(schedulerObligationsInOps.status, ['pending', 'failed', 'enqueued', 'running']),
          ),
        )
        .returning({ obligationId: schedulerObligationsInOps.obligationId });
      await tx
        .update(schedulerLanesInOps)
        .set({
          state: 'idle',
          activeObligationId: null,
          bullJobId: null,
          runId: null,
          dispatchOwner: null,
          dispatchLeaseExpiresAt: null,
          retryNotBefore: null,
          lastError: null,
          lastProgressAt: dbNow,
          ...(retired.length === 1
            ? { supersededCount: sql`${schedulerLanesInOps.supersededCount} + 1` }
            : {}),
          updatedAt: dbNow,
        })
        .where(
          and(
            eq(schedulerLanesInOps.laneId, row.laneId),
            eq(schedulerLanesInOps.dispatchGeneration, input.dispatchGeneration),
            inArray(schedulerLanesInOps.state, ['dispatching', 'enqueued']),
          ),
        );
      return null;
    }
    const updated = await tx
      .update(schedulerLanesInOps)
      .set({
        state: 'running',
        activeObligationId: requestedObligationId,
        bullJobId: String(input.bullJobId),
        runId: input.runId ?? row.runId,
        lastError: null,
        lastProgressAt: dbNow,
        updatedAt: dbNow,
      })
      .where(eq(schedulerLanesInOps.laneId, row.laneId))
      .returning();
    const laneRow = updated[0];
    if (!laneRow) return null;
    await tx
      .update(schedulerObligationsInOps)
      .set({
        status: 'running',
        bullJobId: String(input.bullJobId),
        runId: input.runId,
        attempts: sql`${schedulerObligationsInOps.attempts} + 1`,
        evidence: sql`${schedulerObligationsInOps.evidence} || jsonb_build_object(
          'executionAttemptCount', CASE
            WHEN ${schedulerObligationsInOps.evidence}->>'executionAttemptCount' ~ '^[0-9]+$'
              THEN (${schedulerObligationsInOps.evidence}->>'executionAttemptCount')::numeric + 1
            ELSE 1
          END,
          'executionAttemptGeneration', ${requestedObligation.generation}::integer
        )`,
        lastError: null,
        updatedAt: dbNow,
      })
      .where(
        and(
          eq(schedulerObligationsInOps.obligationId, requestedObligationId),
          inArray(schedulerObligationsInOps.status, ['pending', 'failed', 'enqueued', 'running']),
        ),
      );
    const lane = mapLane(laneRow);
    const [obligationRow] = await tx
      .select()
      .from(schedulerObligationsInOps)
      .where(eq(schedulerObligationsInOps.obligationId, requestedObligationId))
      .limit(1);
    return obligationRow ? { lane, obligation: mapObligation(obligationRow) } : null;
  });
}

export async function fenceSchedulerLaneTarget(input: {
  laneId: string;
  dispatchGeneration: number;
  activeObligationId: string;
  bullJobId: string | number;
  runId?: string;
  db?: DbHandle;
}): Promise<SchedulerLaneTarget | null> {
  const db = input.db ?? (await getDb());
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(schedulerLanesInOps)
      .where(
        and(
          eq(schedulerLanesInOps.laneId, input.laneId),
          eq(schedulerLanesInOps.dispatchGeneration, input.dispatchGeneration),
          eq(schedulerLanesInOps.state, 'running'),
        ),
      )
      .for('update')
      .limit(1);
    if (!row) return null;
    // A worker may call the fence with the target it started while the lane's
    // desired waterline has already advanced.  Compare both columns: in that
    // case `activeObligationId` still equals the caller's value, but the
    // caller is nevertheless stale and must retire its obligation before the
    // latest target is allowed to run.
    const targetChanged =
      row.activeObligationId !== input.activeObligationId ||
      row.desiredObligationId !== input.activeObligationId;
    const nowRows = await tx.execute<{ dbNow: Date | string }>(
      sql`SELECT clock_timestamp() AS "dbNow"`,
    );
    const dbNow = asDate(nowRows[0]?.dbNow);
    if (!dbNow) throw new Error('Database clock is unavailable');
    if (targetChanged) {
      if (row.jobName === 'live-snapshot') {
        // A queued live Bull job must never borrow a newer target's identity.
        // Retire the exact old obligation and let the next scheduler pass
        // dispatch the current target with a fresh lane generation. An older
        // callback cannot clear a newer active worker's lane.
        await tx
          .update(schedulerObligationsInOps)
          .set({
            status: 'skipped',
            evidence: terminalEvidence({
              terminal: true,
              reason: LANE_SUPERSEDED_REASON,
              supersededByObligationId: row.desiredObligationId,
            }),
            completedAt: dbNow,
            leaseOwner: null,
            leaseExpiresAt: null,
            lastError: null,
            updatedAt: dbNow,
          })
          .where(
            and(
              eq(schedulerObligationsInOps.obligationId, input.activeObligationId),
              inArray(schedulerObligationsInOps.status, [
                'running',
                'enqueued',
                'pending',
                'failed',
              ]),
            ),
          );
        if (row.activeObligationId === input.activeObligationId) {
          await tx
            .update(schedulerLanesInOps)
            .set({
              state: 'idle',
              activeObligationId: null,
              bullJobId: null,
              runId: null,
              dispatchOwner: null,
              dispatchLeaseExpiresAt: null,
              retryNotBefore: null,
              lastError: null,
              lastProgressAt: dbNow,
              updatedAt: dbNow,
            })
            .where(
              and(
                eq(schedulerLanesInOps.laneId, row.laneId),
                eq(schedulerLanesInOps.activeObligationId, input.activeObligationId),
                eq(schedulerLanesInOps.state, 'running'),
              ),
            );
        }
        return null;
      }
      await tx
        .update(schedulerObligationsInOps)
        .set({
          status: 'skipped',
          evidence: terminalEvidence({
            terminal: true,
            reason: LANE_SUPERSEDED_REASON,
            supersededByObligationId: row.desiredObligationId,
          }),
          completedAt: dbNow,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastError: null,
          updatedAt: dbNow,
        })
        .where(
          and(
            eq(schedulerObligationsInOps.obligationId, input.activeObligationId),
            inArray(schedulerObligationsInOps.status, ['running', 'enqueued']),
          ),
        );
      await tx
        .update(schedulerLanesInOps)
        .set({
          activeObligationId: row.desiredObligationId,
          lastError: null,
          lastProgressAt: dbNow,
          updatedAt: dbNow,
        })
        .where(eq(schedulerLanesInOps.laneId, row.laneId));
    }
    await tx
      .update(schedulerObligationsInOps)
      .set({
        status: 'running',
        bullJobId: String(input.bullJobId),
        // When an older Bull retry adopts a newer desired target, that target
        // may already have its own source-run identity from the scheduler
        // enqueue. Preserve it instead of rebinding the new obligation to the
        // stale payload run (which may already be terminal/skipped).
        ...(input.runId === undefined
          ? {}
          : {
              runId: sql`COALESCE(${schedulerObligationsInOps.runId}, ${input.runId}::uuid)`,
            }),
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: null,
        updatedAt: dbNow,
      })
      .where(
        and(
          eq(schedulerObligationsInOps.obligationId, row.desiredObligationId),
          inArray(schedulerObligationsInOps.status, ['pending', 'failed', 'enqueued', 'running']),
        ),
      );
    const [targetRow] = await tx
      .select()
      .from(schedulerObligationsInOps)
      .where(eq(schedulerObligationsInOps.obligationId, row.desiredObligationId))
      .limit(1);
    if (!targetRow) return null;
    if (
      row.jobName === 'live-snapshot' &&
      !['pending', 'failed', 'enqueued', 'running'].includes(targetRow.status)
    ) {
      // A queued retry can arrive after the desired target was already closed
      // by a newer scheduler pass. Leave the lane idle and stop before any
      // provider call; returning a terminal target here would let the worker
      // accidentally execute an obligation that can no longer publish.
      await tx
        .update(schedulerLanesInOps)
        .set({
          state: 'idle',
          activeObligationId: null,
          bullJobId: null,
          runId: null,
          dispatchOwner: null,
          dispatchLeaseExpiresAt: null,
          retryNotBefore: null,
          lastError: null,
          lastProgressAt: dbNow,
          updatedAt: dbNow,
        })
        .where(eq(schedulerLanesInOps.laneId, row.laneId));
      return null;
    }
    return {
      lane: mapLane({ ...row, activeObligationId: row.desiredObligationId }),
      obligation: mapObligation(targetRow),
    };
  });
}

/**
 * Called by the dataset publication activation transaction. The lane row is
 * locked in that same PostgreSQL transaction, so a newer desired obligation
 * cannot race a prepared result into the canonical publication.
 */
export async function assertSchedulerLanePublicationFence(
  tx: DbOrTransaction,
  input: {
    laneId: string;
    dispatchGeneration: number;
    activeObligationId: string;
  },
): Promise<void> {
  const [lane] = await tx
    .select({
      state: schedulerLanesInOps.state,
      dispatchGeneration: schedulerLanesInOps.dispatchGeneration,
      activeObligationId: schedulerLanesInOps.activeObligationId,
      desiredObligationId: schedulerLanesInOps.desiredObligationId,
    })
    .from(schedulerLanesInOps)
    .where(eq(schedulerLanesInOps.laneId, input.laneId))
    .for('update')
    .limit(1);
  if (
    !lane ||
    lane.state !== 'running' ||
    lane.dispatchGeneration !== input.dispatchGeneration ||
    lane.activeObligationId !== input.activeObligationId ||
    lane.desiredObligationId !== input.activeObligationId
  ) {
    throw new Error('Scheduler lane target was superseded before publication activation');
  }
}

export async function completeSchedulerLane(input: {
  laneId: string;
  dispatchGeneration: number;
  activeObligationId: string;
  /** Bind completion to the worker generation that actually ran. */
  obligationGeneration?: number;
  status: Extract<SchedulerObligationStatus, 'succeeded' | 'skipped'>;
  evidence?: Record<string, unknown>;
  db?: DbHandle;
}): Promise<{ ok: boolean; needsDispatch: boolean; lane: SchedulerLane | null }> {
  const db = input.db ?? (await getDb());
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(schedulerLanesInOps)
      .where(
        and(
          eq(schedulerLanesInOps.laneId, input.laneId),
          eq(schedulerLanesInOps.dispatchGeneration, input.dispatchGeneration),
          eq(schedulerLanesInOps.activeObligationId, input.activeObligationId),
          eq(schedulerLanesInOps.state, 'running'),
        ),
      )
      .for('update')
      .limit(1);
    if (!row) return { ok: false, needsDispatch: false, lane: null };
    const nowRows = await tx.execute<{ dbNow: Date | string }>(
      sql`SELECT clock_timestamp() AS "dbNow"`,
    );
    const dbNow = asDate(nowRows[0]?.dbNow);
    if (!dbNow) throw new Error('Database clock is unavailable');
    const desiredChanged = row.desiredObligationId !== input.activeObligationId;
    const liveTargetSuperseded = row.jobName === 'live-snapshot' && desiredChanged;
    const terminalStatus = liveTargetSuperseded ? 'skipped' : input.status;
    const completedObligation = await tx
      .update(schedulerObligationsInOps)
      .set({
        status: terminalStatus,
        evidence: terminalEvidence({
          ...(input.evidence ?? {}),
          laneKey: row.laneKey,
          dispatchGeneration: row.dispatchGeneration,
          ...(liveTargetSuperseded
            ? {
                reason: LANE_SUPERSEDED_REASON,
                supersededByObligationId: row.desiredObligationId,
              }
            : {}),
        }),
        completedAt: dbNow,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: null,
        updatedAt: dbNow,
      })
      .where(
        and(
          eq(schedulerObligationsInOps.obligationId, input.activeObligationId),
          input.obligationGeneration === undefined
            ? undefined
            : eq(schedulerObligationsInOps.generation, input.obligationGeneration),
          inArray(schedulerObligationsInOps.status, ['enqueued', 'running']),
        ),
      )
      .returning({
        obligationId: schedulerObligationsInOps.obligationId,
      });
    if (completedObligation.length !== 1) {
      // A dependency wait deliberately increments the obligation generation
      // and leaves it pending. Release only this still-running lane so the
      // next scheduler pass can honor the new dueAt/backoff; never turn the
      // deferred row into a success just because the worker callback returned.
      if (input.obligationGeneration !== undefined) {
        const [currentObligation] = await tx
          .select({
            generation: schedulerObligationsInOps.generation,
            status: schedulerObligationsInOps.status,
          })
          .from(schedulerObligationsInOps)
          .where(eq(schedulerObligationsInOps.obligationId, input.activeObligationId))
          .limit(1);
        if (
          currentObligation &&
          currentObligation.generation !== input.obligationGeneration &&
          currentObligation.status === 'pending'
        ) {
          const released = await tx
            .update(schedulerLanesInOps)
            .set({
              state: 'idle',
              activeObligationId: null,
              bullJobId: null,
              runId: null,
              dispatchOwner: null,
              dispatchLeaseExpiresAt: null,
              blockerJobId: null,
              retryNotBefore: null,
              lastError: null,
              lastProgressAt: dbNow,
              updatedAt: dbNow,
            })
            .where(
              and(
                eq(schedulerLanesInOps.laneId, row.laneId),
                eq(schedulerLanesInOps.dispatchGeneration, input.dispatchGeneration),
                eq(schedulerLanesInOps.activeObligationId, input.activeObligationId),
                eq(schedulerLanesInOps.state, 'running'),
              ),
            )
            .returning();
          return {
            ok: false,
            needsDispatch: released.length === 1,
            lane: released[0] ? mapLane(released[0]) : null,
          };
        }
      }
      return { ok: false, needsDispatch: false, lane: null };
    }
    const updated = await tx
      .update(schedulerLanesInOps)
      .set({
        state: 'idle',
        activeObligationId: null,
        bullJobId: null,
        runId: null,
        dispatchOwner: null,
        dispatchLeaseExpiresAt: null,
        blockerJobId: null,
        retryNotBefore: null,
        lastError: null,
        lastProgressAt: dbNow,
        updatedAt: dbNow,
      })
      .where(eq(schedulerLanesInOps.laneId, row.laneId))
      .returning();
    return {
      ok: true,
      needsDispatch: desiredChanged,
      lane: updated[0] ? mapLane(updated[0]) : null,
    };
  });
}

/**
 * A superseded live Bull job may settle after the scheduler has already
 * skipped its obligation while leaving the lane in `enqueued` or
 * `dispatching`. A completion/failure callback must release that exact lane
 * generation without turning the stale obligation into a success or failure.
 */
export async function acknowledgeSupersededSchedulerLane(input: {
  laneId: string;
  dispatchGeneration: number;
  bullJobId: string | number;
  activeObligationId?: string;
  db?: DbHandle;
}): Promise<boolean> {
  const db = input.db ?? (await getDb());
  return db.transaction(async (tx) => {
    const bullJobId = String(input.bullJobId);
    const [lane] = await tx
      .select()
      .from(schedulerLanesInOps)
      .where(
        and(
          eq(schedulerLanesInOps.laneId, input.laneId),
          eq(schedulerLanesInOps.dispatchGeneration, input.dispatchGeneration),
          inArray(schedulerLanesInOps.state, ['dispatching', 'enqueued']),
          or(eq(schedulerLanesInOps.bullJobId, bullJobId), isNull(schedulerLanesInOps.bullJobId)),
        ),
      )
      .for('update')
      .limit(1);
    if (!lane || lane.jobName !== 'live-snapshot') return false;

    const obligationId = input.activeObligationId;
    const [obligation] = obligationId
      ? await tx
          .select()
          .from(schedulerObligationsInOps)
          .where(eq(schedulerObligationsInOps.obligationId, obligationId))
          .limit(1)
      : await tx
          .select()
          .from(schedulerObligationsInOps)
          .where(
            and(
              eq(schedulerObligationsInOps.bullJobId, bullJobId),
              eq(schedulerObligationsInOps.status, 'skipped'),
            ),
          )
          .orderBy(sql`${schedulerObligationsInOps.updatedAt} DESC`)
          .limit(1);
    const obligationReason = (obligation?.evidence as Record<string, unknown> | null | undefined)
      ?.reason;
    if (
      !obligation ||
      obligation.jobName !== lane.jobName ||
      obligation.scopeKey !== lane.scopeKey ||
      obligation.status !== 'skipped' ||
      obligationReason !== LANE_SUPERSEDED_REASON ||
      obligation.obligationId === lane.desiredObligationId
    ) {
      return false;
    }
    const nowRows = await tx.execute<{ dbNow: Date | string }>(
      sql`SELECT clock_timestamp() AS "dbNow"`,
    );
    const dbNow = asDate(nowRows[0]?.dbNow);
    if (!dbNow) throw new Error('Database clock is unavailable');
    const updated = await tx
      .update(schedulerLanesInOps)
      .set({
        state: 'idle',
        activeObligationId: null,
        bullJobId: null,
        runId: null,
        dispatchOwner: null,
        dispatchLeaseExpiresAt: null,
        retryNotBefore: null,
        lastError: null,
        lastProgressAt: dbNow,
        updatedAt: dbNow,
      })
      .where(
        and(
          eq(schedulerLanesInOps.laneId, lane.laneId),
          eq(schedulerLanesInOps.dispatchGeneration, input.dispatchGeneration),
          inArray(schedulerLanesInOps.state, ['dispatching', 'enqueued']),
          or(eq(schedulerLanesInOps.bullJobId, bullJobId), isNull(schedulerLanesInOps.bullJobId)),
        ),
      )
      .returning({ laneId: schedulerLanesInOps.laneId });
    return updated.length === 1;
  });
}

export async function failSchedulerLane(input: {
  laneId: string;
  dispatchGeneration: number;
  activeObligationId: string;
  error: unknown;
  db?: DbHandle;
}): Promise<boolean> {
  const db = input.db ?? (await getDb());
  const classified = summarizeDataError(input.error);
  const retryPolicy = retryPolicyForError(classified.errorClass);
  const summary = `${classified.errorClass}:${classified.errorCode} ${classified.summary}`.slice(
    0,
    1_000,
  );
  const updated = await db.transaction(async (tx) => {
    const nowRows = await tx.execute<{ dbNow: Date | string }>(
      sql`SELECT clock_timestamp() AS "dbNow"`,
    );
    const dbNow = asDate(nowRows[0]?.dbNow);
    if (!dbNow) throw new Error('Database clock is unavailable');
    // Lock and validate the lane first.  A terminal Bull callback from an old
    // generation must not mark an obligation failed after a newer generation
    // has already adopted the lane.
    const [laneRow] = await tx
      .select({
        laneId: schedulerLanesInOps.laneId,
        dispatchGeneration: schedulerLanesInOps.dispatchGeneration,
        activeObligationId: schedulerLanesInOps.activeObligationId,
        desiredObligationId: schedulerLanesInOps.desiredObligationId,
        jobName: schedulerLanesInOps.jobName,
        state: schedulerLanesInOps.state,
      })
      .from(schedulerLanesInOps)
      .where(eq(schedulerLanesInOps.laneId, input.laneId))
      .for('update')
      .limit(1);
    if (
      !laneRow ||
      laneRow.dispatchGeneration !== input.dispatchGeneration ||
      laneRow.activeObligationId !== input.activeObligationId ||
      laneRow.state !== 'running'
    ) {
      return false;
    }

    const desiredChanged =
      laneRow.jobName === 'live-snapshot' &&
      laneRow.desiredObligationId !== input.activeObligationId;
    const [obligationRow] = await tx
      .select({
        obligationId: schedulerObligationsInOps.obligationId,
        attempts: schedulerObligationsInOps.attempts,
        generation: schedulerObligationsInOps.generation,
        evidence: schedulerObligationsInOps.evidence,
      })
      .from(schedulerObligationsInOps)
      .where(eq(schedulerObligationsInOps.obligationId, input.activeObligationId))
      .for('update')
      .limit(1);
    if (!obligationRow) return false;
    const evidence =
      obligationRow.evidence && typeof obligationRow.evidence === 'object'
        ? (obligationRow.evidence as Record<string, unknown>)
        : {};
    const evidenceGeneration = Number(evidence.executionAttemptGeneration);
    const evidenceAttempts = Number(evidence.executionAttemptCount);
    const executionAttempts =
      Number.isSafeInteger(evidenceGeneration) &&
      evidenceGeneration === obligationRow.generation &&
      Number.isSafeInteger(evidenceAttempts)
        ? evidenceAttempts
        : obligationRow.attempts;
    const terminalFailure = !retryPolicy.retryable || executionAttempts >= retryPolicy.maxAttempts;
    const terminal = desiredChanged || terminalFailure;
    const obligation = await tx
      .update(schedulerObligationsInOps)
      .set({
        status: desiredChanged ? 'skipped' : terminalFailure ? 'irrecoverable' : 'failed',
        evidence: desiredChanged
          ? terminalEvidence({
              terminal: true,
              reason: LANE_SUPERSEDED_REASON,
              supersededByObligationId: laneRow.desiredObligationId,
            })
          : undefined,
        lastError: desiredChanged ? null : summary,
        completedAt: terminal ? dbNow : undefined,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: dbNow,
      })
      .where(
        and(
          eq(schedulerObligationsInOps.obligationId, input.activeObligationId),
          inArray(schedulerObligationsInOps.status, ['pending', 'enqueued', 'running', 'failed']),
        ),
      )
      .returning({ obligationId: schedulerObligationsInOps.obligationId });
    const lane = await tx
      .update(schedulerLanesInOps)
      .set({
        state: 'idle',
        activeObligationId: null,
        bullJobId: null,
        runId: null,
        dispatchOwner: null,
        dispatchLeaseExpiresAt: null,
        retryNotBefore: terminal ? null : new Date(dbNow.getTime() + RETRY_DELAY_MS),
        lastError: desiredChanged ? null : summary,
        lastProgressAt: dbNow,
        updatedAt: dbNow,
      })
      .where(
        and(
          eq(schedulerLanesInOps.laneId, input.laneId),
          eq(schedulerLanesInOps.dispatchGeneration, input.dispatchGeneration),
          eq(schedulerLanesInOps.activeObligationId, input.activeObligationId),
          eq(schedulerLanesInOps.state, 'running'),
        ),
      )
      .returning({ laneId: schedulerLanesInOps.laneId });
    return obligation.length === 1 && lane.length === 1;
  });
  return updated;
}

export async function blockSchedulerLane(input: {
  laneId: string;
  dispatchGeneration: number;
  activeObligationId: string;
  blockerJobId: string;
  error: unknown;
  /** Source identity required to replay a Core repair after Bull loss. */
  blockerEvidence?: Record<string, unknown>;
  db?: DbHandle;
}): Promise<boolean> {
  const db = input.db ?? (await getDb());
  const summary = (input.error instanceof Error ? input.error.message : String(input.error)).slice(
    0,
    4_000,
  );
  return db.transaction(async (tx) => {
    const [lane] = await tx
      .select()
      .from(schedulerLanesInOps)
      .where(
        and(
          eq(schedulerLanesInOps.laneId, input.laneId),
          eq(schedulerLanesInOps.dispatchGeneration, input.dispatchGeneration),
          eq(schedulerLanesInOps.activeObligationId, input.activeObligationId),
          eq(schedulerLanesInOps.state, 'running'),
        ),
      )
      .for('update')
      .limit(1);
    if (!lane) return false;
    const nowRows = await tx.execute<{ dbNow: Date | string }>(
      sql`SELECT clock_timestamp() AS "dbNow"`,
    );
    const dbNow = asDate(nowRows[0]?.dbNow);
    if (!dbNow) throw new Error('Database clock is unavailable');
    await tx
      .update(schedulerObligationsInOps)
      .set({
        status: 'pending',
        dueAt: new Date(dbNow.getTime() + RETRY_DELAY_MS),
        // The blocker is a lane-level admission state, not a failed
        // obligation attempt. Keep the diagnostic in evidence and on the
        // lane, while satisfying the obligation error-state invariant.
        lastError: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        evidence: sql`${schedulerObligationsInOps.evidence} || ${JSON.stringify({
          blockerJobId: input.blockerJobId,
          blockerError: summary,
          ...(input.blockerEvidence ?? {}),
        })}::jsonb`,
        updatedAt: dbNow,
      })
      .where(eq(schedulerObligationsInOps.obligationId, input.activeObligationId));
    await tx
      .update(schedulerLanesInOps)
      .set({
        state: 'blocked',
        // Retain the blocked obligation identity until the repair completes so
        // recovery can replay its exact hot source instead of silently
        // fetching a newer, potentially incompatible bootstrap.
        activeObligationId: input.activeObligationId,
        bullJobId: null,
        runId: null,
        blockerJobId: input.blockerJobId,
        lastError: summary,
        lastProgressAt: dbNow,
        updatedAt: dbNow,
      })
      .where(eq(schedulerLanesInOps.laneId, lane.laneId));
    return true;
  });
}

export async function unblockSchedulerLane(input: {
  blockerJobId: string;
  success: boolean;
  error?: unknown;
  db?: DbHandle;
}): Promise<boolean> {
  const db = input.db ?? (await getDb());
  const summary = input.error
    ? (input.error instanceof Error ? input.error.message : String(input.error)).slice(0, 4_000)
    : null;
  const updated = await db
    .update(schedulerLanesInOps)
    .set({
      state: 'idle',
      activeObligationId: null,
      blockerJobId: null,
      retryNotBefore: input.success
        ? null
        : sql`clock_timestamp() + ${BLOCKED_RETRY_DELAY_MS} * interval '1 millisecond'`,
      lastError: summary,
      lastProgressAt: sql`clock_timestamp()`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(schedulerLanesInOps.blockerJobId, input.blockerJobId),
        eq(schedulerLanesInOps.state, 'blocked'),
      ),
    )
    .returning({ laneId: schedulerLanesInOps.laneId });
  return updated.length === 1;
}

export type SchedulerLaneCoreSourceReplacement = Readonly<{
  ok: boolean;
  replaced: boolean;
  lane: SchedulerLane | null;
  obligation: SchedulerObligation | null;
}>;

/**
 * Retire a price target whose archived watcher source lost the Core source
 * ordering race.  A successful Core repair must not simply unblock the same
 * target: that target carries an incompatible player set and would enter the
 * Core-admission blocker again on every retry.  Reuse a newer source-free
 * desired target when one already exists; otherwise create one successor for
 * the same immutable schedule bucket and let the next price worker fetch the
 * current bootstrap.
 *
 * The callback can be delivered more than once (Bull completion plus a late
 * scheduler reconciliation).  Recognise the terminal audit marker and return
 * success without mutating a newer generation.
 */
export async function replaceBlockedSchedulerLaneAfterCoreSourceStale(input: {
  laneId: string;
  dispatchGeneration: number;
  activeObligationId: string;
  blockerJobId: string;
  db?: DbHandle;
}): Promise<SchedulerLaneCoreSourceReplacement> {
  const db = input.db ?? (await getDb());
  return db.transaction(async (tx) => {
    const nowRows = await tx.execute<{ dbNow: Date | string }>(
      sql`SELECT clock_timestamp() AS "dbNow"`,
    );
    const dbNow = asDate(nowRows[0]?.dbNow);
    if (!dbNow) throw new Error('Database clock is unavailable');

    const [laneRow] = await tx
      .select()
      .from(schedulerLanesInOps)
      .where(eq(schedulerLanesInOps.laneId, input.laneId))
      .for('update')
      .limit(1);
    if (!laneRow) return { ok: false, replaced: false, lane: null, obligation: null };

    const [oldRow] = await tx
      .select()
      .from(schedulerObligationsInOps)
      .where(eq(schedulerObligationsInOps.obligationId, input.activeObligationId))
      .for('update')
      .limit(1);
    const oldObligation = oldRow ? mapObligation(oldRow) : null;

    // Idempotent acknowledgement for a callback replay after this
    // transaction committed and a scheduler pass already claimed the
    // successor.  Do not accept a terminal row from an unrelated lane.
    if (
      oldObligation?.jobName === laneRow.jobName &&
      oldObligation.scopeKey === laneRow.scopeKey &&
      oldObligation.status === 'skipped' &&
      oldObligation.evidence.reason === CORE_SOURCE_SUPERSEDED_REASON &&
      laneRow.desiredObligationId !== input.activeObligationId &&
      laneRow.blockerJobId !== input.blockerJobId
    ) {
      const [desiredRow] = await tx
        .select()
        .from(schedulerObligationsInOps)
        .where(eq(schedulerObligationsInOps.obligationId, laneRow.desiredObligationId))
        .limit(1);
      return {
        ok: true,
        replaced: false,
        lane: mapLane(laneRow),
        obligation: desiredRow ? mapObligation(desiredRow) : null,
      };
    }

    if (
      laneRow.state !== 'blocked' ||
      laneRow.dispatchGeneration !== input.dispatchGeneration ||
      laneRow.activeObligationId !== input.activeObligationId ||
      laneRow.blockerJobId !== input.blockerJobId ||
      !oldObligation ||
      oldObligation.jobName !== laneRow.jobName ||
      oldObligation.scopeKey !== laneRow.scopeKey ||
      oldObligation.jobName !== 'price-change-predictions'
    ) {
      return { ok: false, replaced: false, lane: mapLane(laneRow), obligation: null };
    }

    const [desiredRow] = await tx
      .select()
      .from(schedulerObligationsInOps)
      .where(eq(schedulerObligationsInOps.obligationId, laneRow.desiredObligationId))
      .for('update')
      .limit(1);
    const desired = desiredRow ? mapObligation(desiredRow) : null;
    const desiredIsRunnable = desired && ['pending', 'failed'].includes(desired.status);
    const desiredIsDifferent = desired?.obligationId !== oldObligation.obligationId;
    let successor = desiredIsRunnable && desiredIsDifferent ? desired : null;

    if (!successor) {
      successor = await reserveSchedulerObligation({
        definition: {
          name: oldObligation.jobName,
          cadence: oldObligation.cadence,
          timezone: oldObligation.timezone,
          queueName: laneRow.queueName,
        },
        plan: {
          scopeKey: oldObligation.scopeKey,
          periodKey: `${oldObligation.periodKey}-core-source-refresh-${randomUUID()}`,
          dueAt: scheduledDueAt(oldObligation),
          source: oldObligation.source,
          evidence: {
            ...withoutPriceChangeSourceEvidence(oldObligation.evidence),
            coreSourceSupersededFromObligationId: oldObligation.obligationId,
            coreSourceSupersededReason: 'newer-core-publication',
          },
        },
        db: tx,
      });
    }

    const supersededSourceEvidence = {
      ...(typeof oldObligation.evidence.sourceHash === 'string'
        ? { supersededSourceHash: oldObligation.evidence.sourceHash }
        : {}),
      ...(typeof oldObligation.evidence.sourceArtifactId === 'string'
        ? { supersededSourceArtifactId: oldObligation.evidence.sourceArtifactId }
        : {}),
      ...(typeof oldObligation.evidence.priceChangeBoardRevision === 'string'
        ? { supersededPriceChangeBoardRevision: oldObligation.evidence.priceChangeBoardRevision }
        : {}),
    };
    const retired = await tx
      .update(schedulerObligationsInOps)
      .set({
        status: 'skipped',
        evidence: terminalEvidence({
          terminal: true,
          reason: CORE_SOURCE_SUPERSEDED_REASON,
          supersededByObligationId: successor.obligationId,
          supersededByPeriodKey: successor.periodKey,
          ...supersededSourceEvidence,
        }),
        completedAt: dbNow,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: null,
        updatedAt: dbNow,
      })
      .where(
        and(
          eq(schedulerObligationsInOps.obligationId, oldObligation.obligationId),
          inArray(schedulerObligationsInOps.status, ['pending', 'enqueued', 'running', 'failed']),
        ),
      )
      .returning({ obligationId: schedulerObligationsInOps.obligationId });
    if (retired.length !== 1) {
      throw new Error('Stale Core repair price obligation retirement CAS failed');
    }

    const updated = await tx
      .update(schedulerLanesInOps)
      .set({
        state: 'idle',
        desiredObligationId: successor.obligationId,
        desiredDueAt: scheduledDueAt(successor),
        activeObligationId: null,
        dispatchOwner: null,
        dispatchLeaseExpiresAt: null,
        bullJobId: null,
        runId: null,
        blockerJobId: null,
        retryNotBefore: null,
        lastError: null,
        lastProgressAt: dbNow,
        supersededCount: sql`${schedulerLanesInOps.supersededCount} + 1`,
        updatedAt: dbNow,
      })
      .where(
        and(
          eq(schedulerLanesInOps.laneId, input.laneId),
          eq(schedulerLanesInOps.dispatchGeneration, input.dispatchGeneration),
          eq(schedulerLanesInOps.activeObligationId, input.activeObligationId),
          eq(schedulerLanesInOps.blockerJobId, input.blockerJobId),
          eq(schedulerLanesInOps.state, 'blocked'),
        ),
      )
      .returning();
    if (!updated[0]) throw new Error('Stale Core repair lane replacement CAS failed');

    return {
      ok: true,
      replaced: true,
      lane: mapLane(updated[0]),
      obligation: successor,
    };
  });
}

export async function renewSchedulerLane(input: {
  laneId: string;
  dispatchGeneration: number;
  db?: DbHandle;
}): Promise<boolean> {
  const db = input.db ?? (await getDb());
  const updated = await db
    .update(schedulerLanesInOps)
    .set({
      lastProgressAt: sql`clock_timestamp()`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(schedulerLanesInOps.laneId, input.laneId),
        eq(schedulerLanesInOps.dispatchGeneration, input.dispatchGeneration),
        eq(schedulerLanesInOps.state, 'running'),
      ),
    )
    .returning({ laneId: schedulerLanesInOps.laneId });
  return updated.length === 1;
}

/**
 * Reconcile the durable lane with Bull's actual state. Time alone is never a
 * reason to create a new generation: only an absent/failed Bull record can
 * release an enqueued/running lane for recovery.
 */
export async function recoverSchedulerLaneAfterBullLoss(input: {
  laneId: string;
  dispatchGeneration: number;
  bullJobId: string;
  bullState: 'missing' | 'failed';
  /** Payload identity for failures before the worker can start the lane. */
  obligationId?: string;
  db?: DbHandle;
}): Promise<boolean> {
  const db = input.db ?? (await getDb());
  return db.transaction(async (tx) => {
    const nowRows = await tx.execute<{ dbNow: Date | string }>(
      sql`SELECT clock_timestamp() AS "dbNow"`,
    );
    const dbNow = asDate(nowRows[0]?.dbNow);
    if (!dbNow) throw new Error('Database clock is unavailable');
    const [lane] = await tx
      .select()
      .from(schedulerLanesInOps)
      .where(
        and(
          eq(schedulerLanesInOps.laneId, input.laneId),
          eq(schedulerLanesInOps.dispatchGeneration, input.dispatchGeneration),
          or(
            and(
              inArray(schedulerLanesInOps.state, ['enqueued', 'running']),
              eq(schedulerLanesInOps.bullJobId, input.bullJobId),
            ),
            // A worker can fail before the scheduler's enqueue confirmation
            // writes Bull's ID.  The lane generation and payload obligation
            // still fence this callback to the dispatch being settled.
            and(
              eq(schedulerLanesInOps.state, 'dispatching'),
              isNull(schedulerLanesInOps.bullJobId),
              // A missing Bull record is ambiguous while the owner may still
              // be between claimSchedulerLaneDispatch and Queue.add.  Only
              // a terminal Bull failure can settle that dispatch immediately;
              // a missing record must wait for the short lease to expire.
              or(
                input.bullState === 'failed'
                  ? sql`TRUE`
                  : isNull(schedulerLanesInOps.dispatchLeaseExpiresAt),
                input.bullState === 'failed'
                  ? sql`FALSE`
                  : lte(schedulerLanesInOps.dispatchLeaseExpiresAt, dbNow),
              ),
            ),
          ),
        ),
      )
      .for('update')
      .limit(1);
    if (!lane || !['dispatching', 'enqueued', 'running'].includes(lane.state)) return false;
    // A queued job can fail before startSchedulerLane assigns
    // active_obligation_id (for example after a season rollover). Prefer the
    // obligation carried by the Bull payload, then the accepted Bull identity
    // persisted during enqueue confirmation. Never guess from the current
    // desired waterline: it may already point at a newer obligation.
    const failedObligationIds = new Set<string>();
    if (input.obligationId) failedObligationIds.add(input.obligationId);
    if (lane.activeObligationId) failedObligationIds.add(lane.activeObligationId);
    if (failedObligationIds.size === 0) {
      const [bullObligation] = await tx
        .select({ obligationId: schedulerObligationsInOps.obligationId })
        .from(schedulerObligationsInOps)
        .where(eq(schedulerObligationsInOps.bullJobId, input.bullJobId))
        .limit(1);
      if (bullObligation?.obligationId) failedObligationIds.add(bullObligation.obligationId);
    }
    const supersededObligationIds = new Set<string>();
    if (lane.jobName === 'live-snapshot') {
      if (lane.activeObligationId && lane.activeObligationId !== lane.desiredObligationId) {
        supersededObligationIds.add(lane.activeObligationId);
      }
      if (input.obligationId && input.obligationId !== lane.desiredObligationId) {
        supersededObligationIds.add(input.obligationId);
      }
    }
    const supersededOnly =
      lane.jobName === 'live-snapshot' &&
      failedObligationIds.size > 0 &&
      [...failedObligationIds].every((obligationId) => obligationId !== lane.desiredObligationId);
    const bullLossError = `Bull job ${input.bullState} before durable completion`.slice(0, 1_000);
    const retryPolicy = retryPolicyForError('TRANSIENT_INFRA');
    for (const failedObligationId of failedObligationIds) {
      const superseded =
        supersededObligationIds.has(failedObligationId) ||
        (lane.jobName === 'live-snapshot' && failedObligationId !== lane.desiredObligationId);
      const [obligationRow] = await tx
        .select({
          status: schedulerObligationsInOps.status,
          attempts: schedulerObligationsInOps.attempts,
          generation: schedulerObligationsInOps.generation,
          evidence: schedulerObligationsInOps.evidence,
        })
        .from(schedulerObligationsInOps)
        .where(eq(schedulerObligationsInOps.obligationId, failedObligationId))
        .for('update')
        .limit(1);
      if (!obligationRow || !['pending', 'enqueued', 'running'].includes(obligationRow.status)) {
        continue;
      }
      const evidence =
        obligationRow.evidence && typeof obligationRow.evidence === 'object'
          ? (obligationRow.evidence as Record<string, unknown>)
          : {};
      const evidenceGeneration = Number(evidence.executionAttemptGeneration);
      const evidenceAttempts = Number(evidence.executionAttemptCount);
      const executionAttempts =
        Number.isSafeInteger(evidenceGeneration) &&
        evidenceGeneration === obligationRow.generation &&
        Number.isSafeInteger(evidenceAttempts) &&
        evidenceAttempts >= 0
          ? evidenceAttempts
          : obligationRow.attempts;
      const terminalFailure =
        !superseded && (!retryPolicy.retryable || executionAttempts >= retryPolicy.maxAttempts);
      await tx
        .update(schedulerObligationsInOps)
        .set({
          status: superseded ? 'skipped' : terminalFailure ? 'irrecoverable' : 'failed',
          ...(superseded
            ? {
                evidence: terminalEvidence({
                  terminal: true,
                  reason: LANE_SUPERSEDED_REASON,
                  supersededByObligationId: lane.desiredObligationId,
                }),
              }
            : {}),
          bullJobId: input.bullJobId,
          lastError: superseded ? null : bullLossError,
          completedAt: superseded || terminalFailure ? dbNow : undefined,
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: dbNow,
        })
        .where(
          and(
            eq(schedulerObligationsInOps.obligationId, failedObligationId),
            inArray(schedulerObligationsInOps.status, ['pending', 'enqueued', 'running']),
          ),
        );
    }
    const updated = await tx
      .update(schedulerLanesInOps)
      .set({
        state: 'idle',
        activeObligationId: null,
        bullJobId: null,
        runId: null,
        dispatchOwner: null,
        dispatchLeaseExpiresAt: null,
        // Bull-loss recovery is an explicit missing-delivery signal, so a
        // still-budgeted obligation remains immediately claimable. The
        // execution counter above is the bound; adding a delay here would
        // change the established recovery behavior without preventing loops.
        retryNotBefore: null,
        lastError: supersededOnly ? null : bullLossError,
        lastProgressAt: dbNow,
        updatedAt: dbNow,
      })
      .where(eq(schedulerLanesInOps.laneId, lane.laneId))
      .returning({ laneId: schedulerLanesInOps.laneId });
    return updated.length === 1;
  });
}

export async function getSchedulerLane(input: {
  laneKey?: string;
  laneId?: string;
  db?: DbHandle;
}): Promise<SchedulerLane | null> {
  if (!input.laneKey && !input.laneId) throw new Error('laneKey or laneId is required');
  const db = input.db ?? (await getDb());
  const [row] = await db
    .select()
    .from(schedulerLanesInOps)
    .where(
      input.laneKey
        ? eq(schedulerLanesInOps.laneKey, input.laneKey)
        : eq(schedulerLanesInOps.laneId, input.laneId!),
    )
    .limit(1);
  return row ? mapLane(row) : null;
}

export async function listSchedulerLanes(
  input: {
    jobName?: string;
    states?: readonly SchedulerLaneState[];
    db?: DbHandle;
  } = {},
): Promise<SchedulerLane[]> {
  const db = input.db ?? (await getDb());
  const stateFilter = input.states?.length
    ? inArray(schedulerLanesInOps.state, [...input.states])
    : undefined;
  const rows = await db
    .select()
    .from(schedulerLanesInOps)
    .where(
      and(input.jobName ? eq(schedulerLanesInOps.jobName, input.jobName) : undefined, stateFilter),
    )
    .orderBy(asc(schedulerLanesInOps.jobName), asc(schedulerLanesInOps.scopeKey));
  return rows.map(mapLane);
}

/**
 * Return only live lanes that can make progress during off-plan recovery.
 *
 * A vanished lifecycle plan must still allow a pending/failed desired target
 * to be dispatched, while an idle lane with no runnable target and no stale
 * sibling has nothing for the recovery pass to do.  Keep this query bounded
 * so retained historical lane rows cannot make every scheduler pass perform
 * one read/transaction per event forever.
 */
export async function listLiveSnapshotRecoveryLanes(
  input: {
    limit?: number;
    db?: DbHandle;
  } = {},
): Promise<SchedulerLane[]> {
  const db = input.db ?? (await getDb());
  const desired = alias(schedulerObligationsInOps, 'live_lane_desired');
  const stale = alias(schedulerObligationsInOps, 'live_lane_stale');
  const desiredAuthority = schedulerObligationAuthorityAtSql('live-snapshot', desired);
  const staleAuthority = schedulerObligationAuthorityAtSql('live-snapshot', stale);
  const staleSibling = exists(
    db
      .select({ one: sql`1` })
      .from(stale)
      .where(
        and(
          eq(stale.jobName, 'live-snapshot'),
          eq(stale.scopeKey, schedulerLanesInOps.scopeKey),
          sql`${stale.obligationId} <> ${schedulerLanesInOps.desiredObligationId}`,
          inArray(stale.status, ['pending', 'failed', 'enqueued']),
          sql`(
            ${staleAuthority} < ${desiredAuthority}
            OR (
              ${staleAuthority} = ${desiredAuthority}
              AND ${stale.periodKey} < ${desired.periodKey}
            )
          )`,
        ),
      ),
  );
  const desiredRunnable = exists(
    db
      .select({ one: sql`1` })
      .from(desired)
      .where(
        and(
          eq(desired.obligationId, schedulerLanesInOps.desiredObligationId),
          eq(desired.jobName, 'live-snapshot'),
          inArray(desired.status, ['pending', 'failed']),
          or(
            isNull(schedulerLanesInOps.retryNotBefore),
            lte(schedulerLanesInOps.retryNotBefore, sql`clock_timestamp()`),
          ),
        ),
      ),
  );
  const hasStaleSibling = exists(
    db
      .select({ one: sql`1` })
      .from(desired)
      .where(
        and(
          eq(desired.obligationId, schedulerLanesInOps.desiredObligationId),
          eq(desired.jobName, 'live-snapshot'),
          staleSibling,
        ),
      ),
  );
  const rows = await db
    .select()
    .from(schedulerLanesInOps)
    .where(
      and(
        eq(schedulerLanesInOps.jobName, 'live-snapshot'),
        or(
          inArray(schedulerLanesInOps.state, ['dispatching', 'enqueued', 'running']),
          and(eq(schedulerLanesInOps.state, 'idle'), or(desiredRunnable, hasStaleSibling)),
        ),
      ),
    )
    .orderBy(asc(schedulerLanesInOps.updatedAt), asc(schedulerLanesInOps.laneId))
    .limit(
      Number.isFinite(input.limit) ? Math.max(1, Math.min(250, Math.floor(input.limit!))) : 250,
    );
  return rows.map(mapLane);
}

/**
 * Retire a live lane whose season is no longer current before a worker can
 * call the current-season FPL endpoint. Historical live obligations retain
 * their original due/freshness evidence; only the runnable identity and lane
 * state are terminalized. Locking the lane and every non-terminal obligation
 * in one transaction also fences a worker that is already between start and
 * its publication check.
 */
export async function retireSchedulerLaneForStaleSeason(input: {
  laneId: string;
  currentSeasonCode: string;
  db?: DbHandle;
}): Promise<boolean> {
  if (!isFplSeasonCode(input.currentSeasonCode)) {
    throw new Error(`Invalid current FPL season code: ${input.currentSeasonCode}`);
  }
  const db = input.db ?? (await getDb());
  return db.transaction(async (tx) => {
    const nowRows = await tx.execute<{ dbNow: Date | string }>(
      sql`SELECT clock_timestamp() AS "dbNow"`,
    );
    const dbNow = asDate(nowRows[0]?.dbNow);
    if (!dbNow) throw new Error('Database clock is unavailable');

    const [laneRow] = await tx
      .select()
      .from(schedulerLanesInOps)
      .where(
        and(
          eq(schedulerLanesInOps.laneId, input.laneId),
          eq(schedulerLanesInOps.jobName, 'live-snapshot'),
        ),
      )
      .for('update')
      .limit(1);
    if (!laneRow) return false;

    const scopeMatch = /^(\d{4}):event:([1-9][0-9]*)$/.exec(laneRow.scopeKey);
    if (!scopeMatch || !isFplSeasonCode(scopeMatch[1])) {
      throw new Error(`Invalid persisted live-snapshot lane scope: ${laneRow.scopeKey}`);
    }
    const persistedSeasonCode = scopeMatch[1];
    if (persistedSeasonCode === input.currentSeasonCode) return false;

    // Retire every non-terminal obligation in this scope. A bounded scheduler
    // supersession pass may have left older siblings behind, and leaving one
    // pending would make the next recovery query look runnable again.
    const retiredObligations = await tx
      .update(schedulerObligationsInOps)
      .set({
        status: 'skipped',
        evidence: terminalEvidence({
          terminal: true,
          reason: STALE_SEASON_REASON,
          staleSeason: persistedSeasonCode,
          currentSeason: input.currentSeasonCode,
        }),
        completedAt: dbNow,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: null,
        nextAttemptAt: null,
        updatedAt: dbNow,
      })
      .where(
        and(
          eq(schedulerObligationsInOps.jobName, 'live-snapshot'),
          eq(schedulerObligationsInOps.scopeKey, laneRow.scopeKey),
          inArray(schedulerObligationsInOps.status, [
            'pending',
            'failed',
            'enqueued',
            'running',
            'retrying',
          ]),
        ),
      )
      .returning({ obligationId: schedulerObligationsInOps.obligationId });

    const laneNeedsReset =
      laneRow.state !== 'idle' ||
      laneRow.activeObligationId !== null ||
      laneRow.dispatchOwner !== null ||
      laneRow.dispatchLeaseExpiresAt !== null ||
      laneRow.bullJobId !== null ||
      laneRow.runId !== null ||
      laneRow.blockerJobId !== null ||
      laneRow.retryNotBefore !== null ||
      laneRow.lastError !== null;
    if (retiredObligations.length === 0 && !laneNeedsReset) return false;

    const updated = await tx
      .update(schedulerLanesInOps)
      .set({
        state: 'idle',
        activeObligationId: null,
        dispatchOwner: null,
        dispatchLeaseExpiresAt: null,
        bullJobId: null,
        runId: null,
        blockerJobId: null,
        retryNotBefore: null,
        lastError: null,
        lastProgressAt: dbNow,
        updatedAt: dbNow,
      })
      .where(eq(schedulerLanesInOps.laneId, laneRow.laneId))
      .returning({ laneId: schedulerLanesInOps.laneId });
    return updated.length === 1;
  });
}

export async function getSchedulerLaneTarget(input: {
  laneId: string;
  db?: DbHandle;
}): Promise<SchedulerLaneTarget | null> {
  const db = input.db ?? (await getDb());
  const lane = await getSchedulerLane({ laneId: input.laneId, db });
  return lane ? loadTarget(db, lane) : null;
}

export async function getSchedulerLaneTargets(input: { laneId: string; db?: DbHandle }): Promise<{
  lane: SchedulerLane;
  desired: SchedulerObligation | null;
  active: SchedulerObligation | null;
} | null> {
  const db = input.db ?? (await getDb());
  const lane = await getSchedulerLane({ laneId: input.laneId, db });
  if (!lane) return null;
  const rows = await db
    .select()
    .from(schedulerObligationsInOps)
    .where(
      inArray(schedulerObligationsInOps.obligationId, [
        lane.desiredObligationId,
        ...(lane.activeObligationId ? [lane.activeObligationId] : []),
      ]),
    );
  const desiredRow = rows.find((row) => row.obligationId === lane.desiredObligationId);
  const activeRow = lane.activeObligationId
    ? rows.find((row) => row.obligationId === lane.activeObligationId)
    : undefined;
  return {
    lane,
    desired: desiredRow ? mapObligation(desiredRow) : null,
    active: activeRow ? mapObligation(activeRow) : null,
  };
}

export const schedulerLaneConstants = {
  dispatchLeaseMs: DISPATCH_LEASE_MS,
  blockedRetryDelayMs: BLOCKED_RETRY_DELAY_MS,
};
