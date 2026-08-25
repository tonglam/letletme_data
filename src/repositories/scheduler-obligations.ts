import { randomUUID } from 'node:crypto';

import { and, asc, desc, eq, inArray, lte, notInArray, sql } from 'drizzle-orm';

import { schedulerObligationsInOps } from '../db/schemas/index.schema';
import { getDb, type DbHandle } from '../db/singleton';
import type { SchedulerObligationPlan, SchedulerSource } from '../scheduler/job-registry';

export type SchedulerObligationStatus =
  | 'pending'
  | 'enqueued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped'
  | 'irrecoverable';

export type SchedulerObligation = Readonly<{
  obligationId: string;
  jobName: string;
  scopeKey: string;
  periodKey: string;
  cadence: string;
  timezone: string;
  status: SchedulerObligationStatus;
  source: SchedulerSource;
  dueAt: Date;
  generation: number;
  attempts: number;
  bullJobId: string | null;
  runId: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  evidence: Record<string, unknown>;
}>;

const SUPERSEDED_BY_LATEST_AUTHORITATIVE = 'superseded-by-latest-authoritative';

// A scheduled job may own one obligation while it scans a bounded batch of
// entries. The lease is progress evidence for monitoring and explicit
// reconciliation; it is not authority to create another Bull generation.
// BullMQ owns stalled-job recovery for an already-enqueued job.
const DEFAULT_SCHEDULER_LEASE_MS = 15 * 60_000;

function resolveSchedulerLeaseMs(): number {
  const configured = Number(process.env.SCHEDULER_LEASE_MS);
  if (Number.isSafeInteger(configured) && configured >= 60_000) return configured;
  return DEFAULT_SCHEDULER_LEASE_MS;
}

function dateValue(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid scheduler timestamp');
  return date;
}

function mapRow(row: typeof schedulerObligationsInOps.$inferSelect): SchedulerObligation {
  return {
    obligationId: row.obligationId,
    jobName: row.jobName,
    scopeKey: row.scopeKey,
    periodKey: row.periodKey,
    cadence: row.cadence,
    timezone: row.timezone,
    status: row.status as SchedulerObligationStatus,
    source: row.source as SchedulerSource,
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

function immutableScheduledDueAtSql() {
  return sql`CASE
    WHEN ${schedulerObligationsInOps.evidence}->>'scheduledDueAtMs' ~ '^[0-9]+$'
      THEN to_timestamp((${schedulerObligationsInOps.evidence}->>'scheduledDueAtMs')::double precision / 1000)
    ELSE ${schedulerObligationsInOps.dueAt}
  END`;
}

function terminalSchedulerEvidence(evidence?: Record<string, unknown>) {
  return sql`${JSON.stringify(evidence ?? {})}::jsonb || CASE
    WHEN ${schedulerObligationsInOps.evidence} ? 'scheduledDueAtMs'
      THEN jsonb_build_object(
        'scheduledDueAtMs',
        ${schedulerObligationsInOps.evidence}->'scheduledDueAtMs'
      )
    ELSE '{}'::jsonb
  END`;
}

function immutableScheduledDueAt(dueAt: Date, scheduledDueAtMs: string | null): Date {
  if (!scheduledDueAtMs || !/^[0-9]+$/.test(scheduledDueAtMs)) return dueAt;
  const timestamp = Number(scheduledDueAtMs);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) return dueAt;
  const scheduled = new Date(timestamp);
  return Number.isFinite(scheduled.getTime()) ? scheduled : dueAt;
}

export async function reserveSchedulerObligation(input: {
  definition: { name: string; cadence: string; timezone: string };
  plan: SchedulerObligationPlan;
  db?: DbHandle;
}): Promise<SchedulerObligation> {
  const db = input.db ?? (await getDb());
  const scheduledDueAtMs = input.plan.dueAt.getTime();
  if (!Number.isFinite(scheduledDueAtMs)) {
    throw new Error('Scheduler obligation plan must have a valid due timestamp');
  }
  const obligationId = randomUUID();
  const inserted = await db
    .insert(schedulerObligationsInOps)
    .values({
      obligationId,
      jobName: input.definition.name,
      scopeKey: input.plan.scopeKey,
      periodKey: input.plan.periodKey,
      cadence: input.definition.cadence,
      timezone: input.definition.timezone,
      status: 'pending',
      source: input.plan.source,
      dueAt: input.plan.dueAt,
      evidence: {
        ...(input.plan.evidence ?? {}),
        ...(input.plan.eventId === undefined ? {} : { targetEventId: input.plan.eventId }),
        // due_at is mutable retry state; retain the original schedule boundary
        // so latest-authoritative coalescing cannot be fooled by a retry delay.
        scheduledDueAtMs,
      },
    })
    .onConflictDoNothing({
      target: [
        schedulerObligationsInOps.jobName,
        schedulerObligationsInOps.scopeKey,
        schedulerObligationsInOps.periodKey,
      ],
    })
    .returning();
  if (inserted[0]) return mapRow(inserted[0]);
  const existing = await db
    .select()
    .from(schedulerObligationsInOps)
    .where(
      and(
        eq(schedulerObligationsInOps.jobName, input.definition.name),
        eq(schedulerObligationsInOps.scopeKey, input.plan.scopeKey),
        eq(schedulerObligationsInOps.periodKey, input.plan.periodKey),
      ),
    )
    .limit(1);
  const row = existing[0];
  if (!row) throw new Error('Scheduler obligation disappeared after conflict');
  return mapRow(row);
}

/**
 * Latest-authoritative daily lanes supersede an older pending/failed date
 * after a feature-disabled outage. In-flight work is left intact; its run
 * must drain or be recovered before a newer generation is allowed to write.
 */
export async function supersedeSchedulerObligations(input: {
  jobName: string;
  beforePeriodKey: string;
  evidence?: Record<string, unknown>;
  db?: DbHandle;
}): Promise<number> {
  const db = input.db ?? (await getDb());
  const updated = await db
    .update(schedulerObligationsInOps)
    .set({
      status: 'skipped',
      evidence: sql`${schedulerObligationsInOps.evidence} || ${JSON.stringify({
        provider: 'understat',
        terminal: true,
        reason: SUPERSEDED_BY_LATEST_AUTHORITATIVE,
        ...input.evidence,
      })}::jsonb`,
      completedAt: sql`clock_timestamp()`,
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(schedulerObligationsInOps.jobName, input.jobName),
        sql`${schedulerObligationsInOps.periodKey} < ${input.beforePeriodKey}`,
        inArray(schedulerObligationsInOps.status, ['pending', 'failed']),
      ),
    )
    .returning({ obligationId: schedulerObligationsInOps.obligationId });
  return updated.length;
}

/**
 * Latest-authoritative minute lanes use a timestamp bucket rather than a
 * lexically sortable date key. Retire older pending/failed obligations while
 * leaving an already-running fetch intact so it can drain normally.
 */
export async function supersedeSchedulerObligationsByDueAt(input: {
  jobName: string;
  scopeKey: string;
  beforeDueAt: Date;
  evidence?: Record<string, unknown>;
  db?: DbHandle;
}): Promise<number> {
  const db = input.db ?? (await getDb());
  if (!Number.isFinite(input.beforeDueAt.getTime())) {
    throw new Error('Scheduler supersede boundary must be a valid timestamp');
  }
  const beforeDueAt = input.beforeDueAt.toISOString();
  const immutableDueAt = immutableScheduledDueAtSql();
  const updated = await db
    .update(schedulerObligationsInOps)
    .set({
      status: 'skipped',
      evidence: sql`${schedulerObligationsInOps.evidence} || ${JSON.stringify({
        provider: 'fpl',
        terminal: true,
        reason: SUPERSEDED_BY_LATEST_AUTHORITATIVE,
        ...input.evidence,
      })}::jsonb`,
      completedAt: sql`clock_timestamp()`,
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(schedulerObligationsInOps.jobName, input.jobName),
        eq(schedulerObligationsInOps.scopeKey, input.scopeKey),
        sql`${immutableDueAt} < ${beforeDueAt}`,
        inArray(schedulerObligationsInOps.status, ['pending', 'failed']),
      ),
    )
    .returning({ obligationId: schedulerObligationsInOps.obligationId });
  return updated.length;
}

export type SchedulerDueAtSupersessionBoundary = Readonly<{
  jobName: string;
  scopeKey: string;
  periodKey: string;
  beforeDueAt: Date;
}>;

/**
 * Post-match latest-authoritative checkpoints can cover every finalized event.
 * Coalesce all job/scope boundaries in one statement so a season-end scheduler
 * pass does not issue one permanent no-op update per job and event.
 *
 * The authoritative period identity is excluded explicitly. Peers at the same
 * immutable due time are superseded because a final-N checkpoint replaces its
 * provisional-N peer without advancing the hourly boundary.
 */
export async function supersedeSchedulerObligationsByDueAtBatch(input: {
  boundaries: readonly SchedulerDueAtSupersessionBoundary[];
  evidence?: Record<string, unknown>;
  db?: DbHandle;
}): Promise<number> {
  if (input.boundaries.length === 0) return 0;
  const seen = new Set<string>();
  const boundaries = input.boundaries.map((boundary) => {
    if (
      boundary.jobName.length === 0 ||
      boundary.scopeKey.length === 0 ||
      boundary.periodKey.length === 0 ||
      !Number.isFinite(boundary.beforeDueAt.getTime())
    ) {
      throw new Error('Scheduler supersession boundary is invalid');
    }
    const identity = JSON.stringify([boundary.jobName, boundary.scopeKey]);
    if (seen.has(identity)) {
      throw new Error('Scheduler supersession boundaries must be unique by job and scope');
    }
    seen.add(identity);
    return {
      job_name: boundary.jobName,
      scope_key: boundary.scopeKey,
      period_key: boundary.periodKey,
      before_due_at: boundary.beforeDueAt.toISOString(),
    };
  });
  const db = input.db ?? (await getDb());
  const [result] = await db.execute<{ updatedCount: number | string }>(sql`
    WITH boundaries AS (
      SELECT job_name, scope_key, period_key, before_due_at
      FROM jsonb_to_recordset(${JSON.stringify(boundaries)}::jsonb) AS boundary(
        job_name text,
        scope_key text,
        period_key text,
        before_due_at timestamptz
      )
    ), updated AS (
      UPDATE ops.scheduler_obligations AS obligation
      SET status = 'skipped',
          evidence = obligation.evidence || jsonb_build_object(
            'provider', 'fpl',
            'terminal', true,
            'reason', ${SUPERSEDED_BY_LATEST_AUTHORITATIVE}::text,
            'supersededByPeriodKey', boundaries.period_key
          ) || ${JSON.stringify(input.evidence ?? {})}::jsonb,
          completed_at = clock_timestamp(),
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = clock_timestamp()
      FROM boundaries
      WHERE obligation.job_name = boundaries.job_name
        AND obligation.scope_key = boundaries.scope_key
        AND obligation.period_key <> boundaries.period_key
        AND CASE
          WHEN obligation.evidence->>'scheduledDueAtMs' ~ '^[0-9]+$'
            THEN to_timestamp(
              (obligation.evidence->>'scheduledDueAtMs')::double precision / 1000
            )
          ELSE obligation.due_at
        END <= boundaries.before_due_at
        AND obligation.status IN ('pending', 'failed')
      RETURNING obligation.obligation_id
    )
    SELECT count(*)::integer AS "updatedCount"
    FROM updated
  `);
  return Number(result?.updatedCount ?? 0);
}

export async function hasEarlierInFlightSchedulerObligation(input: {
  jobName: string;
  beforePeriodKey: string;
  db?: DbHandle;
}): Promise<boolean> {
  const db = input.db ?? (await getDb());
  const [row] = await db
    .select({ obligationId: schedulerObligationsInOps.obligationId })
    .from(schedulerObligationsInOps)
    .where(
      and(
        eq(schedulerObligationsInOps.jobName, input.jobName),
        sql`${schedulerObligationsInOps.periodKey} < ${input.beforePeriodKey}`,
        inArray(schedulerObligationsInOps.status, ['enqueued', 'running']),
      ),
    )
    .limit(1);
  return Boolean(row);
}

export async function deferSchedulerObligationByIdentity(input: {
  jobName: string;
  scopeKey: string;
  periodKey: string;
  delayMs: number;
  error?: string;
  db?: DbHandle;
}): Promise<boolean> {
  const db = input.db ?? (await getDb());
  const delayMs = Math.max(1_000, Math.floor(input.delayMs));
  if (!Number.isSafeInteger(delayMs)) throw new Error('Scheduler defer delay must be an integer');
  const updated = await db
    .update(schedulerObligationsInOps)
    .set({
      dueAt: sql`clock_timestamp() + ${delayMs} * interval '1 millisecond'`,
      ...(input.error ? { lastError: input.error } : {}),
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(schedulerObligationsInOps.jobName, input.jobName),
        eq(schedulerObligationsInOps.scopeKey, input.scopeKey),
        eq(schedulerObligationsInOps.periodKey, input.periodKey),
        inArray(schedulerObligationsInOps.status, ['pending', 'failed']),
      ),
    )
    .returning({ obligationId: schedulerObligationsInOps.obligationId });
  return updated.length === 1;
}

export async function claimSchedulerObligations(
  input: {
    limit?: number;
    leaseMs?: number;
    /** Keep scheduler-only obligations pending while their provider is disabled. */
    excludedJobNames?: readonly string[];
    /** Restrict this atomic claim to one ordered scheduler definition. */
    includedJobNames?: readonly string[];
    /** Existing in-flight jobs that consume any lane required by this claim. */
    inFlightConflictJobNames?: readonly string[];
    /** Advisory-lock identities shared by every definition using the same lane. */
    laneKeys?: readonly string[];
    /** Terminal generation caps for provider-specific lease recovery. */
    generationCaps?: Readonly<Record<string, number>>;
    db?: DbHandle;
  } = {},
): Promise<readonly { obligation: SchedulerObligation; owner: string }[]> {
  const limit = input.limit ?? 50;
  const leaseMs = input.leaseMs ?? resolveSchedulerLeaseMs();
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new Error('Scheduler claim limit must be between 1 and 200');
  }
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1)
    throw new Error('Scheduler lease must be positive');
  const db = input.db ?? (await getDb());
  const excludedJobNames = [...new Set(input.excludedJobNames ?? [])].filter(
    (name) => name.length > 0,
  );
  const includedJobNames = [...new Set(input.includedJobNames ?? [])].filter(
    (name) => name.length > 0,
  );
  const inFlightConflictJobNames = [
    ...new Set(input.inFlightConflictJobNames ?? includedJobNames),
  ].filter((name) => name.length > 0);
  const laneKeys = [...new Set(input.laneKeys ?? [])].filter((lane) => lane.length > 0).sort();
  const owner = randomUUID();
  return db.transaction(async (tx) => {
    // All schedulers acquire intersecting lane locks in lexical order. The
    // in-flight check and claim therefore form one database-atomic capacity
    // decision even during a rolling deployment with two scheduler processes.
    for (const lane of laneKeys) {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`scheduler-lane:${lane}`}, 0))`,
      );
    }
    if (inFlightConflictJobNames.length > 0) {
      const active = await tx
        .select({ obligationId: schedulerObligationsInOps.obligationId })
        .from(schedulerObligationsInOps)
        .where(
          and(
            inArray(schedulerObligationsInOps.jobName, inFlightConflictJobNames),
            inArray(schedulerObligationsInOps.status, ['enqueued', 'running']),
          ),
        )
        .limit(1);
      if (active.length > 0) return [];
    }
    const clockRows = await tx.execute<{ dbNow: Date | string }>(
      sql`SELECT clock_timestamp() AS "dbNow"`,
    );
    const dbNow = dateValue(clockRows[0]?.dbNow);
    if (!dbNow) throw new Error('Database clock is unavailable');
    const leaseExpiresAt = new Date(dbNow.getTime() + leaseMs);
    const rows = await tx
      .select()
      .from(schedulerObligationsInOps)
      .where(
        and(
          lte(schedulerObligationsInOps.dueAt, dbNow),
          inArray(schedulerObligationsInOps.status, ['pending', 'failed']),
          includedJobNames.length > 0
            ? inArray(schedulerObligationsInOps.jobName, includedJobNames)
            : undefined,
          excludedJobNames.length > 0
            ? notInArray(schedulerObligationsInOps.jobName, excludedJobNames)
            : undefined,
        ),
      )
      .orderBy(asc(schedulerObligationsInOps.dueAt), asc(schedulerObligationsInOps.obligationId))
      .limit(limit)
      .for('update', { skipLocked: true });
    const claimed: { obligation: SchedulerObligation; owner: string }[] = [];
    for (const row of rows) {
      // Only an explicitly failed attempt gets a fresh deterministic Bull ID.
      // Enqueued/running work is never reclaimed from lease age alone: the
      // original Bull job may still be waiting, active, stalled, or retrying.
      const nextGeneration = row.status === 'failed' ? row.generation + 1 : row.generation;
      const generationCap = input.generationCaps?.[row.jobName];
      if (generationCap !== undefined && nextGeneration >= generationCap) {
        await tx
          .update(schedulerObligationsInOps)
          .set({
            status: 'skipped',
            evidence: sql`${schedulerObligationsInOps.evidence} || ${JSON.stringify({
              provider: 'understat',
              terminal: true,
              reason: 'generation-limit',
            })}::jsonb`,
            completedAt: dbNow,
            leaseOwner: null,
            leaseExpiresAt: null,
            updatedAt: dbNow,
          })
          .where(eq(schedulerObligationsInOps.obligationId, row.obligationId));
        continue;
      }
      const updated = await tx
        .update(schedulerObligationsInOps)
        .set({
          status: 'enqueued',
          generation: nextGeneration,
          attempts: sql`${schedulerObligationsInOps.attempts} + 1`,
          leaseOwner: owner,
          leaseExpiresAt,
          // Correlation belongs to one generation. A failed generation must
          // not make a new claim look Bull-confirmed before its own enqueue.
          bullJobId: null,
          runId: null,
          updatedAt: dbNow,
        })
        .where(eq(schedulerObligationsInOps.obligationId, row.obligationId))
        .returning();
      if (updated[0]) claimed.push({ obligation: mapRow(updated[0]), owner });
    }
    return claimed;
  });
}

/**
 * Cheap prefilter for the lane-aware claimant. The later claim transaction is
 * still authoritative; this only avoids opening one transaction per registry
 * definition on every 30-second scheduler pass.
 */
export async function findDueSchedulerJobNames(input: {
  excludedJobNames?: readonly string[];
  db?: DbHandle;
}): Promise<readonly string[]> {
  const db = input.db ?? (await getDb());
  const excludedJobNames = [...new Set(input.excludedJobNames ?? [])].filter(
    (name) => name.length > 0,
  );
  const rows = await db
    .select({ jobName: schedulerObligationsInOps.jobName })
    .from(schedulerObligationsInOps)
    .where(
      and(
        sql`${schedulerObligationsInOps.dueAt} <= clock_timestamp()`,
        inArray(schedulerObligationsInOps.status, ['pending', 'failed']),
        excludedJobNames.length > 0
          ? notInArray(schedulerObligationsInOps.jobName, excludedJobNames)
          : undefined,
      ),
    )
    .groupBy(schedulerObligationsInOps.jobName);
  return rows.map((row) => row.jobName);
}

/**
 * Find expired in-flight obligations for BullMQ reconciliation. Lease expiry
 * is observation evidence only: the reconciler must inspect the exact Bull
 * generation before it may settle or retry one of these rows.
 */
export async function listExpiredSchedulerObligations(
  input: { limit?: number; db?: DbHandle } = {},
): Promise<readonly SchedulerObligation[]> {
  const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new Error('Scheduler recovery limit must be between 1 and 200');
  }
  const db = input.db ?? (await getDb());
  const rows = await db
    .select()
    .from(schedulerObligationsInOps)
    .where(
      and(
        inArray(schedulerObligationsInOps.status, ['enqueued', 'running']),
        lte(schedulerObligationsInOps.leaseExpiresAt, sql`clock_timestamp()`),
      ),
    )
    .orderBy(
      asc(schedulerObligationsInOps.leaseExpiresAt),
      asc(schedulerObligationsInOps.obligationId),
    )
    .limit(limit);
  return rows.map(mapRow);
}

export async function confirmSchedulerObligationEnqueued(input: {
  obligationId: string;
  owner: string;
  bullJobId?: string | number;
  runId?: string;
  db?: DbHandle;
}): Promise<boolean> {
  const db = input.db ?? (await getDb());
  const updated = await db
    .update(schedulerObligationsInOps)
    .set({
      bullJobId: input.bullJobId === undefined ? undefined : String(input.bullJobId),
      runId: input.runId,
      // Enqueue acknowledgement is not execution. The worker moves this row
      // to running only after atomically validating its generation fence.
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(schedulerObligationsInOps.obligationId, input.obligationId),
        eq(schedulerObligationsInOps.leaseOwner, input.owner),
        // A fast worker may cross its generation fence before the scheduler
        // persists Bull acknowledgement. The same lease owner can confirm
        // either state without demoting running work back to enqueued.
        inArray(schedulerObligationsInOps.status, ['enqueued', 'running']),
      ),
    )
    .returning({ obligationId: schedulerObligationsInOps.obligationId });
  return updated.length === 1;
}

/**
 * Fence a scheduled Bull job immediately before it performs upstream reads or
 * database writes. A superseded or terminal generation cannot start work.
 */
export async function startSchedulerObligation(input: {
  obligationId: string;
  generation: number;
  additionalLeaseMs?: number;
  db?: DbHandle;
}): Promise<boolean> {
  if (!Number.isSafeInteger(input.generation) || input.generation < 0) {
    throw new Error('Scheduler obligation generation must be a non-negative safe integer');
  }
  const additionalLeaseMs = Math.max(0, Math.floor(input.additionalLeaseMs ?? 0));
  if (!Number.isSafeInteger(additionalLeaseMs)) {
    throw new Error('Additional scheduler lease must be a safe integer');
  }
  const leaseMs = resolveSchedulerLeaseMs() + additionalLeaseMs;
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) {
    throw new Error('Scheduler lease must be a positive safe integer');
  }
  const db = input.db ?? (await getDb());
  const updated = await db
    .update(schedulerObligationsInOps)
    .set({
      status: 'running',
      leaseExpiresAt: sql`clock_timestamp() + ${leaseMs} * interval '1 millisecond'`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(schedulerObligationsInOps.obligationId, input.obligationId),
        eq(schedulerObligationsInOps.generation, input.generation),
        inArray(schedulerObligationsInOps.status, ['enqueued', 'running']),
      ),
    )
    .returning({ obligationId: schedulerObligationsInOps.obligationId });
  return updated.length === 1;
}

/**
 * Extend an in-flight obligation while a worker is progressing a chained
 * job.  The generation guard is important: a delayed successor from an old
 * generation must not be able to reclaim or extend a newer worker's lease.
 * The optional extension covers BullMQ retry/continuation delays in addition
 * to the normal processing safety window.
 */
export async function renewSchedulerObligation(input: {
  obligationId: string;
  generation?: number;
  additionalLeaseMs?: number;
  db?: DbHandle;
}): Promise<boolean> {
  const additionalLeaseMs = Math.max(0, Math.floor(input.additionalLeaseMs ?? 0));
  if (!Number.isSafeInteger(additionalLeaseMs)) {
    throw new Error('Additional scheduler lease must be a safe integer');
  }
  const leaseMs = resolveSchedulerLeaseMs() + additionalLeaseMs;
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) {
    throw new Error('Scheduler lease must be a positive safe integer');
  }
  const db = input.db ?? (await getDb());
  const updated = await db
    .update(schedulerObligationsInOps)
    .set({
      leaseExpiresAt: sql`clock_timestamp() + ${leaseMs} * interval '1 millisecond'`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(schedulerObligationsInOps.obligationId, input.obligationId),
        input.generation === undefined
          ? undefined
          : eq(schedulerObligationsInOps.generation, input.generation),
        inArray(schedulerObligationsInOps.status, ['enqueued', 'running']),
      ),
    )
    .returning({ obligationId: schedulerObligationsInOps.obligationId });
  return updated.length === 1;
}

export async function completeSchedulerObligation(input: {
  obligationId: string;
  status: Extract<SchedulerObligationStatus, 'succeeded' | 'skipped' | 'irrecoverable'>;
  generation?: number;
  evidence?: Record<string, unknown>;
  db?: DbHandle;
}): Promise<boolean> {
  const db = input.db ?? (await getDb());
  const updated = await db
    .update(schedulerObligationsInOps)
    .set({
      status: input.status,
      evidence: terminalSchedulerEvidence(input.evidence),
      completedAt: sql`clock_timestamp()`,
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(schedulerObligationsInOps.obligationId, input.obligationId),
        input.generation === undefined
          ? undefined
          : eq(schedulerObligationsInOps.generation, input.generation),
        inArray(schedulerObligationsInOps.status, ['enqueued', 'running']),
      ),
    )
    .returning({ obligationId: schedulerObligationsInOps.obligationId });
  return updated.length === 1;
}

/**
 * Close a due obligation without enqueueing it when its policy explicitly
 * says the window is no longer recoverable. In-flight generations are kept
 * intact by default; current-day-only policies may explicitly close an
 * enqueued/running row after its date boundary so lease reclaim cannot launch
 * an off-date worker. Completion/failure remains generation-guarded and cannot
 * overwrite the terminal state.
 */
export async function markSchedulerObligationIrrecoverable(input: {
  obligationId: string;
  status?: Extract<SchedulerObligationStatus, 'skipped' | 'irrecoverable'>;
  generation?: number;
  evidence?: Record<string, unknown>;
  includeInFlight?: boolean;
  db?: DbHandle;
}): Promise<boolean> {
  const db = input.db ?? (await getDb());
  const closeableStatuses: SchedulerObligationStatus[] = input.includeInFlight
    ? ['pending', 'failed', 'enqueued', 'running']
    : ['pending', 'failed'];
  const updated = await db
    .update(schedulerObligationsInOps)
    .set({
      status: input.status ?? 'irrecoverable',
      evidence: terminalSchedulerEvidence(input.evidence),
      completedAt: sql`clock_timestamp()`,
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(schedulerObligationsInOps.obligationId, input.obligationId),
        input.generation === undefined
          ? undefined
          : eq(schedulerObligationsInOps.generation, input.generation),
        inArray(schedulerObligationsInOps.status, closeableStatuses),
      ),
    )
    .returning({ obligationId: schedulerObligationsInOps.obligationId });
  return updated.length === 1;
}

export async function completeSchedulerObligationByBullJobId(input: {
  bullJobId: string | number;
  status?: Extract<SchedulerObligationStatus, 'succeeded' | 'skipped'>;
  evidence?: Record<string, unknown>;
  db?: DbHandle;
}): Promise<boolean> {
  const db = input.db ?? (await getDb());
  const updated = await db
    .update(schedulerObligationsInOps)
    .set({
      status: input.status ?? 'succeeded',
      evidence: terminalSchedulerEvidence(input.evidence),
      completedAt: sql`clock_timestamp()`,
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(schedulerObligationsInOps.bullJobId, String(input.bullJobId)),
        inArray(schedulerObligationsInOps.status, ['enqueued', 'running']),
      ),
    )
    .returning({ obligationId: schedulerObligationsInOps.obligationId });
  return updated.length === 1;
}

export async function failSchedulerObligationByBullJobId(input: {
  bullJobId: string | number;
  error: unknown;
  db?: DbHandle;
}): Promise<boolean> {
  const db = input.db ?? (await getDb());
  const [obligation] = await db
    .select({ obligationId: schedulerObligationsInOps.obligationId })
    .from(schedulerObligationsInOps)
    .where(
      and(
        eq(schedulerObligationsInOps.bullJobId, String(input.bullJobId)),
        inArray(schedulerObligationsInOps.status, ['enqueued', 'running']),
      ),
    )
    .limit(1);
  if (!obligation) return false;
  return failSchedulerObligation({
    obligationId: obligation.obligationId,
    error: input.error,
    db,
  });
}

export async function failSchedulerObligation(input: {
  obligationId: string;
  owner?: string;
  generation?: number;
  expectedStatus?: Extract<SchedulerObligationStatus, 'enqueued' | 'running'>;
  error: unknown;
  retryDelayMs?: number;
  db?: DbHandle;
}): Promise<boolean> {
  const db = input.db ?? (await getDb());
  const summary = (input.error instanceof Error ? input.error.message : String(input.error)).slice(
    0,
    4_000,
  );
  const retryDelayMs = Math.max(0, Math.floor(input.retryDelayMs ?? 60_000));
  const updated = await db
    .update(schedulerObligationsInOps)
    .set({
      status: 'failed',
      dueAt: sql`clock_timestamp() + ${retryDelayMs} * interval '1 millisecond'`,
      lastError: summary,
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(schedulerObligationsInOps.obligationId, input.obligationId),
        input.owner ? eq(schedulerObligationsInOps.leaseOwner, input.owner) : undefined,
        input.generation === undefined
          ? undefined
          : eq(schedulerObligationsInOps.generation, input.generation),
        input.expectedStatus === undefined
          ? undefined
          : eq(schedulerObligationsInOps.status, input.expectedStatus),
        inArray(schedulerObligationsInOps.status, ['enqueued', 'running']),
      ),
    )
    .returning({ obligationId: schedulerObligationsInOps.obligationId });
  return updated.length === 1;
}

export async function schedulerObligationSummary(input: { db?: DbHandle } = {}): Promise<{
  total: number;
  overdue: number;
  failed: number;
  running: number;
  irrecoverable: number;
  succeeded: number;
}> {
  const db = input.db ?? (await getDb());
  const rows = await db.execute<{
    total: number | string;
    overdue: number | string;
    failed: number | string;
    running: number | string;
    irrecoverable: number | string;
    succeeded: number | string;
  }>(sql`
    SELECT
      count(*)::integer AS total,
      count(*) FILTER (WHERE due_at <= clock_timestamp() AND status IN ('pending', 'failed'))::integer AS overdue,
      count(*) FILTER (WHERE status = 'failed')::integer AS failed,
      count(*) FILTER (WHERE status IN ('enqueued', 'running'))::integer AS running,
      count(*) FILTER (WHERE status = 'irrecoverable')::integer AS irrecoverable,
      count(*) FILTER (WHERE status = 'succeeded')::integer AS succeeded
    FROM ops.scheduler_obligations
  `);
  const row = rows[0];
  return {
    total: Number(row?.total ?? 0),
    overdue: Number(row?.overdue ?? 0),
    failed: Number(row?.failed ?? 0),
    running: Number(row?.running ?? 0),
    irrecoverable: Number(row?.irrecoverable ?? 0),
    succeeded: Number(row?.succeeded ?? 0),
  };
}

export async function schedulerObligationStatus(input: {
  jobName: string;
  scopeKey: string;
  db?: DbHandle;
}): Promise<{
  latest: {
    periodKey: string;
    status: SchedulerObligationStatus;
    dueAt: Date;
    generation: number;
    attempts: number;
    lastError: string | null;
  } | null;
  overdue: boolean;
  consecutiveUnsuccessfulCycles: number;
}> {
  const db = input.db ?? (await getDb());
  const immutableDueAt = immutableScheduledDueAtSql();
  const rows = await db
    .select({
      periodKey: schedulerObligationsInOps.periodKey,
      status: schedulerObligationsInOps.status,
      dueAt: schedulerObligationsInOps.dueAt,
      generation: schedulerObligationsInOps.generation,
      attempts: schedulerObligationsInOps.attempts,
      lastError: schedulerObligationsInOps.lastError,
      scheduledDueAtMs: sql<
        string | null
      >`${schedulerObligationsInOps.evidence}->>'scheduledDueAtMs'`,
      reason: sql<string | null>`${schedulerObligationsInOps.evidence}->>'reason'`,
    })
    .from(schedulerObligationsInOps)
    .where(
      and(
        eq(schedulerObligationsInOps.jobName, input.jobName),
        eq(schedulerObligationsInOps.scopeKey, input.scopeKey),
        sql`${immutableDueAt} >= COALESCE((
            SELECT max(CASE
              WHEN success.evidence->>'scheduledDueAtMs' ~ '^[0-9]+$'
                THEN to_timestamp((success.evidence->>'scheduledDueAtMs')::double precision / 1000)
              ELSE success.due_at
            END)
            FROM ops.scheduler_obligations AS success
            WHERE success.job_name = ${input.jobName}
              AND success.scope_key = ${input.scopeKey}
              AND (
                success.status = 'succeeded'
                OR (
                  success.status = 'skipped'
                  AND success.evidence->>'reason' = 'official_fields_not_open'
                )
              )
          ), '-infinity'::timestamptz)`,
      ),
    )
    .orderBy(desc(immutableDueAt), desc(schedulerObligationsInOps.updatedAt));
  const latest = rows[0]
    ? {
        periodKey: rows[0].periodKey,
        status: rows[0].status as SchedulerObligationStatus,
        dueAt: immutableScheduledDueAt(rows[0].dueAt, rows[0].scheduledDueAtMs),
        generation: rows[0].generation,
        attempts: rows[0].attempts,
        lastError: rows[0].lastError,
      }
    : null;
  let consecutiveUnsuccessfulCycles = 0;
  for (const row of rows) {
    if (
      row.status === 'succeeded' ||
      (row.status === 'skipped' && row.reason === 'official_fields_not_open')
    ) {
      break;
    }
    if (
      row.status === 'failed' ||
      row.status === 'irrecoverable' ||
      (row.status === 'skipped' && row.reason !== 'official_fields_not_open')
    ) {
      consecutiveUnsuccessfulCycles += 1;
    }
  }
  const latestIsOverdueState = latest?.status === 'pending' || latest?.status === 'failed';
  return {
    latest,
    overdue: Boolean(latest && latest.dueAt.getTime() <= Date.now() && latestIsOverdueState),
    consecutiveUnsuccessfulCycles,
  };
}
