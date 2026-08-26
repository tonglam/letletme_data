import { randomUUID } from 'node:crypto';

import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';

import {
  freshnessSloWindowsInOps,
  schedulerLanesInOps,
  schedulerObligationsInOps,
} from '../db/schemas/index.schema';
import { getDb, type DbHandle, type DbOrTransaction } from '../db/singleton';
import { contractForSchedulerJob } from '../domain/data-contracts';
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

export type SchedulerLaneDispatch = Readonly<{
  lane: SchedulerLane;
  owner: string;
}>;

const DISPATCH_LEASE_MS = 2 * 60_000;
const RETRY_DELAY_MS = 60_000;
const BLOCKED_RETRY_DELAY_MS = 5 * 60_000;
const LANE_SUPERSEDED_REASON = 'superseded-by-latest-authoritative';
const CUTOVER_SUPERSEDED_REASON = 'cutover-superseded';

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
    leaseOwner: row.leaseOwner,
    leaseExpiresAt: row.leaseExpiresAt,
    evidence: (row.evidence ?? {}) as Record<string, unknown>,
  };
}

function scheduledDueAtSql() {
  return sql`CASE
    WHEN ${schedulerObligationsInOps.evidence}->>'scheduledDueAtMs' ~ '^[0-9]+$'
      THEN to_timestamp((${schedulerObligationsInOps.evidence}->>'scheduledDueAtMs')::double precision / 1000)
    ELSE ${schedulerObligationsInOps.dueAt}
  END`;
}

function terminalEvidence(evidence: Record<string, unknown>) {
  return sql`${JSON.stringify(evidence)}::jsonb || CASE
    WHEN ${schedulerObligationsInOps.evidence} ? 'scheduledDueAtMs'
      THEN jsonb_build_object('scheduledDueAtMs', ${schedulerObligationsInOps.evidence}->'scheduledDueAtMs')
    ELSE '{}'::jsonb
  END`;
}

function scheduledDueAt(obligation: SchedulerObligation): Date {
  const raw = obligation.evidence.scheduledDueAtMs;
  if (typeof raw === 'number' && Number.isSafeInteger(raw)) return new Date(raw);
  if (typeof raw === 'string' && /^[0-9]+$/.test(raw)) {
    const parsed = new Date(Number(raw));
    if (Number.isFinite(parsed.getTime())) return parsed;
  }
  return obligation.dueAt;
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
  db?: DbHandle;
}): Promise<{ lane: SchedulerLane; shouldDispatch: boolean }> {
  const db = input.db ?? (await getDb());
  const desiredScheduledDueAt = scheduledDueAt(input.desiredObligation);
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
    const currentDesiredScheduledDueAt = scheduledDueAt(currentDesired);
    const desiredIsNewer =
      desiredScheduledDueAt.getTime() > currentDesiredScheduledDueAt.getTime() ||
      (desiredScheduledDueAt.getTime() === currentDesiredScheduledDueAt.getTime() &&
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
    const selectedScheduledDueAt = scheduledDueAt(selectedDesired);

    // Waiting generations have no useful work once a newer desired period is
    // known. Keep an active target intact so its publication fence can decide
    // the linearization point; the worker will adopt the newer target before
    // it writes if the desired row changed first. Equal-time peers are ordered
    // by periodKey and the non-selected one is terminalized explicitly.
    const immutableDueAt = scheduledDueAtSql();
    const selectedDueAtIso = selectedScheduledDueAt.toISOString();
    const supersedable = await tx
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
        leaseExpiresAt: null,
        updatedAt: dbNow,
      })
      .where(
        and(
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
        ),
      )
      .returning({ obligationId: schedulerObligationsInOps.obligationId });

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
    if (contract?.freshnessEvidence === 'publication') {
      await tx
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
            eq(freshnessSloWindowsInOps.scopeKey, input.scopeKey),
            inArray(freshnessSloWindowsInOps.status, ['PENDING', 'INVALID']),
            sql`(
              ${freshnessSloWindowsInOps.obligationDueAt} < ${selectedDueAtIso}::timestamptz
              OR (
                ${freshnessSloWindowsInOps.obligationDueAt} = ${selectedDueAtIso}::timestamptz
                AND ${freshnessSloWindowsInOps.periodKey} < ${selectedDesired.periodKey}
              )
            )`,
          ),
        );
    }

    const lane = mapLane(row);
    const [desiredRow] = await tx
      .select({ status: schedulerObligationsInOps.status })
      .from(schedulerObligationsInOps)
      .where(eq(schedulerObligationsInOps.obligationId, lane.desiredObligationId))
      .limit(1);
    const shouldDispatch =
      lane.state === 'idle' &&
      (desiredRow?.status === 'pending' || desiredRow?.status === 'failed') &&
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
      .select({ status: schedulerObligationsInOps.status })
      .from(schedulerObligationsInOps)
      .where(eq(schedulerObligationsInOps.obligationId, row.desiredObligationId))
      .limit(1);
    if (desired?.status !== 'pending' && desired?.status !== 'failed') return null;
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
    if (
      row.state === 'running' &&
      row.bullJobId !== null &&
      row.bullJobId !== String(input.bullJobId)
    ) {
      return null;
    }
    const updated = await tx
      .update(schedulerLanesInOps)
      .set({
        state: 'running',
        activeObligationId: row.activeObligationId ?? row.desiredObligationId,
        bullJobId: String(input.bullJobId),
        runId: input.runId ?? row.runId,
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
        updatedAt: dbNow,
      })
      .where(
        and(
          eq(
            schedulerObligationsInOps.obligationId,
            laneRow.activeObligationId ?? laneRow.desiredObligationId,
          ),
          inArray(schedulerObligationsInOps.status, ['pending', 'failed', 'enqueued', 'running']),
        ),
      );
    const lane = mapLane(laneRow);
    const [obligationRow] = await tx
      .select()
      .from(schedulerObligationsInOps)
      .where(eq(schedulerObligationsInOps.obligationId, lane.activeObligationId!))
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
        runId: input.runId,
        leaseOwner: null,
        leaseExpiresAt: null,
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
    await tx
      .update(schedulerObligationsInOps)
      .set({
        status: input.status,
        evidence: terminalEvidence({
          ...(input.evidence ?? {}),
          laneKey: row.laneKey,
          dispatchGeneration: row.dispatchGeneration,
        }),
        completedAt: dbNow,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: dbNow,
      })
      .where(eq(schedulerObligationsInOps.obligationId, input.activeObligationId));
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

export async function failSchedulerLane(input: {
  laneId: string;
  dispatchGeneration: number;
  activeObligationId: string;
  error: unknown;
  db?: DbHandle;
}): Promise<boolean> {
  const db = input.db ?? (await getDb());
  const summary = (input.error instanceof Error ? input.error.message : String(input.error)).slice(
    0,
    4_000,
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

    const obligation = await tx
      .update(schedulerObligationsInOps)
      .set({
        status: 'failed',
        lastError: summary,
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
        retryNotBefore: new Date(dbNow.getTime() + RETRY_DELAY_MS),
        lastError: summary,
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
        lastError: summary,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: dbNow,
      })
      .where(eq(schedulerObligationsInOps.obligationId, input.activeObligationId));
    await tx
      .update(schedulerLanesInOps)
      .set({
        state: 'blocked',
        activeObligationId: null,
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
    for (const failedObligationId of failedObligationIds) {
      await tx
        .update(schedulerObligationsInOps)
        .set({
          status: 'failed',
          bullJobId: input.bullJobId,
          lastError: `Bull job ${input.bullState} before durable completion`,
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
        retryNotBefore: null,
        lastError: `Bull job ${input.bullState} before durable completion`,
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

export async function listSchedulerLanes(input: { db?: DbHandle } = {}): Promise<SchedulerLane[]> {
  const db = input.db ?? (await getDb());
  const rows = await db
    .select()
    .from(schedulerLanesInOps)
    .orderBy(asc(schedulerLanesInOps.jobName), asc(schedulerLanesInOps.scopeKey));
  return rows.map(mapLane);
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
