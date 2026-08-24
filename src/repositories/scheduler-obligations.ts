import { randomUUID } from 'node:crypto';

import { and, asc, desc, eq, inArray, isNull, lte, notInArray, or, sql } from 'drizzle-orm';

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
// entries.  The previous 90-second default was shorter than the production
// 500-entry catch-up batches, so the scheduler reclaimed healthy work and
// started a second generation against the same mutation scopes.  Keep the
// lease comfortably above the longest normal batch; a dead worker is still
// reclaimed deterministically once this safety window expires.
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
  const owner = randomUUID();
  return db.transaction(async (tx) => {
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
          or(
            inArray(schedulerObligationsInOps.status, ['pending', 'failed']),
            and(
              inArray(schedulerObligationsInOps.status, ['enqueued', 'running']),
              or(
                isNull(schedulerObligationsInOps.leaseExpiresAt),
                lte(schedulerObligationsInOps.leaseExpiresAt, dbNow),
              ),
            ),
          ),
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
      // A failed attempt and a lease-reclaimed attempt both need a fresh
      // deterministic Bull ID.  Reusing the old generation can be swallowed
      // by a queue record whose enqueue response was lost or whose worker
      // died after claiming the job.
      const nextGeneration =
        row.status === 'failed' || row.status === 'enqueued' || row.status === 'running'
          ? row.generation + 1
          : row.generation;
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
          updatedAt: dbNow,
        })
        .where(eq(schedulerObligationsInOps.obligationId, row.obligationId))
        .returning();
      if (updated[0]) claimed.push({ obligation: mapRow(updated[0]), owner });
    }
    return claimed;
  });
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
      status: 'running',
      bullJobId: input.bullJobId === undefined ? undefined : String(input.bullJobId),
      runId: input.runId,
      // Keep the claim lease while the Bull job is running. Clearing it here
      // would make every 30-second scheduler pass reclaim a healthy job and
      // enqueue a new generation. Completion/failure clears the lease; an
      // actually lost worker is reclaimed only after this lease expires.
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(schedulerObligationsInOps.obligationId, input.obligationId),
        eq(schedulerObligationsInOps.leaseOwner, input.owner),
        eq(schedulerObligationsInOps.status, 'enqueued'),
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
    consecutiveUnsuccessfulCycles += 1;
  }
  return {
    latest,
    overdue: Boolean(
      latest &&
        latest.dueAt.getTime() <= Date.now() &&
        latest.status !== 'succeeded' &&
        latest.status !== 'skipped',
    ),
    consecutiveUnsuccessfulCycles,
  };
}
