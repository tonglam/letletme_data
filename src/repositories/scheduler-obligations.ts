import { randomUUID } from 'node:crypto';

import { and, asc, desc, eq, inArray, lte, notInArray, sql, type SQL } from 'drizzle-orm';

import { freshnessSloWindowsInOps, schedulerObligationsInOps } from '../db/schemas/index.schema';
import { getDb, type DbHandle, type DbOrTransaction } from '../db/singleton';
import type { SchedulerObligationPlan, SchedulerSource } from '../scheduler/job-registry';
import {
  contractForSchedulerJob,
  contractHasFreshnessWindow,
  queueLaneForSchedulerJob,
} from '../domain/data-contracts';
import { retryPolicyForError, summarizeDataError } from '../domain/error-classification';
import {
  openGovernanceCase,
  recordFreshnessObservation,
} from '../services/data-governance.service';
import { logError } from '../utils/logger';

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
  completedAt: Date | null;
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
    completedAt: row.completedAt,
    leaseOwner: row.leaseOwner,
    leaseExpiresAt: row.leaseExpiresAt,
    evidence: (row.evidence ?? {}) as Record<string, unknown>,
  };
}

function immutableScheduledDueAtForSql(evidence: SQL, dueAt: SQL) {
  return sql`CASE
    WHEN ${evidence}->>'scheduledDueAtMs' ~ '^[0-9]+$'
      AND (${evidence}->>'scheduledDueAtMs')::numeric BETWEEN 0 AND 8640000000000000
      THEN to_timestamp((${evidence}->>'scheduledDueAtMs')::double precision / 1000)
    ELSE ${dueAt}
  END`;
}

function immutableScheduledDueAtSql() {
  return immutableScheduledDueAtForSql(
    sql`${schedulerObligationsInOps.evidence}`,
    sql`${schedulerObligationsInOps.dueAt}`,
  );
}

function postMatchAuthorityAtForSql(evidence: SQL) {
  return sql`CASE
    WHEN ${evidence}->>'resultAuthorityAtMs' ~ '^[0-9]+$'
      THEN (${evidence}->>'resultAuthorityAtMs')::numeric
    ELSE NULL
  END`;
}

function postMatchScheduleAnchorForSql(evidence: SQL) {
  return sql`CASE
    WHEN ${evidence}->>'resultScheduleAnchorMs' ~ '^[0-9]+$'
      THEN (${evidence}->>'resultScheduleAnchorMs')::numeric
    ELSE NULL
  END`;
}

// Slot indexes are relative to the last fixture's expected end and can move
// when that fixture is rescheduled. Rank schedule versions by their persisted
// fixture update timestamp, then slots within one version by their immutable
// boundary. Same-slot finality remains monotonic, so a late provisional
// resolver cannot demote final authority.
function postMatchIdentityIsNewerSql(input: {
  newerSlot: SQL;
  newerDueAt: SQL;
  newerAuthorityAt: SQL;
  newerScheduleAnchor: SQL;
  olderSlot: SQL;
  olderDueAt: SQL;
  olderAuthorityAt: SQL;
  olderScheduleAnchor: SQL;
}) {
  const newerNumbered = sql`${input.newerSlot} ~ '^(provisional|final)-[0-9]+$'`;
  const olderNumbered = sql`${input.olderSlot} ~ '^(provisional|final)-[0-9]+$'`;
  const newerIndex = sql`substring(${input.newerSlot} from '([0-9]+)$')::integer`;
  const olderIndex = sql`substring(${input.olderSlot} from '([0-9]+)$')::integer`;
  return sql`CASE
    WHEN ${input.newerSlot} = 'final-checkpoint'
      THEN ${input.olderSlot} IS DISTINCT FROM 'final-checkpoint'
    WHEN ${input.olderSlot} = 'final-checkpoint'
      THEN false
    WHEN ${newerNumbered}
      AND ${olderNumbered}
      AND ${newerIndex} = ${olderIndex}
      AND (${input.newerSlot} LIKE 'final-%') IS DISTINCT FROM
          (${input.olderSlot} LIKE 'final-%')
      THEN ${input.newerSlot} LIKE 'final-%'
    WHEN ${input.newerScheduleAnchor} IS DISTINCT FROM ${input.olderScheduleAnchor}
      THEN CASE
        WHEN ${input.newerAuthorityAt} IS NOT NULL
          AND ${input.olderAuthorityAt} IS NULL
          THEN true
        WHEN ${input.newerAuthorityAt} IS NULL
          AND ${input.olderAuthorityAt} IS NOT NULL
          THEN false
        WHEN ${input.newerAuthorityAt} IS DISTINCT FROM ${input.olderAuthorityAt}
          THEN ${input.newerAuthorityAt} > ${input.olderAuthorityAt}
        ELSE false
      END
    ELSE ${input.newerDueAt} > ${input.olderDueAt}
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
  END || CASE
    WHEN ${schedulerObligationsInOps.evidence} ? 'resultSlot'
      THEN jsonb_build_object(
        'resultSlot',
        ${schedulerObligationsInOps.evidence}->'resultSlot'
      )
    ELSE '{}'::jsonb
  END || CASE
    WHEN ${schedulerObligationsInOps.evidence} ? 'resultAuthorityAtMs'
      THEN jsonb_build_object(
        'resultAuthorityAtMs',
        ${schedulerObligationsInOps.evidence}->'resultAuthorityAtMs'
      )
    ELSE '{}'::jsonb
  END || CASE
    WHEN ${schedulerObligationsInOps.evidence} ? 'resultScheduleAnchorMs'
      THEN jsonb_build_object(
        'resultScheduleAnchorMs',
        ${schedulerObligationsInOps.evidence}->'resultScheduleAnchorMs'
      )
    ELSE '{}'::jsonb
  END || CASE
    WHEN ${schedulerObligationsInOps.evidence} ? 'freshnessWindowId'
      THEN jsonb_build_object(
        'freshnessWindowId',
        ${schedulerObligationsInOps.evidence}->'freshnessWindowId'
      )
    ELSE '{}'::jsonb
  END || CASE
    WHEN ${schedulerObligationsInOps.evidence} ? 'freshnessWindowIds'
      THEN jsonb_build_object(
        'freshnessWindowIds',
        ${schedulerObligationsInOps.evidence}->'freshnessWindowIds'
      )
    ELSE '{}'::jsonb
  END`;
}

function freshnessWindowIdsFromEvidence(evidence: unknown): number[] {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) return [];
  const record = evidence as Record<string, unknown>;
  const values = [
    ...(Array.isArray(record.freshnessWindowIds) ? record.freshnessWindowIds : []),
    record.freshnessWindowId,
  ];
  return [
    ...new Set(
      values.filter(
        (value): value is number =>
          typeof value === 'number' && Number.isSafeInteger(value) && value > 0,
      ),
    ),
  ];
}

function finiteEvidenceCount(evidence: Record<string, unknown>, keys: readonly string[]) {
  for (const key of keys) {
    const value = evidence[key];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  }
  return undefined;
}

function checkpointCompleteness(evidence: Record<string, unknown>) {
  if (evidence.complete === false || evidence.scanComplete === false) return 'INCOMPLETE' as const;
  if (evidence.hasMore === true) return 'INCOMPLETE' as const;
  const failedUnits = finiteEvidenceCount(evidence, ['failedUnits', 'failedCount']);
  if (failedUnits !== undefined && failedUnits > 0) return 'INCOMPLETE' as const;
  return 'COMPLETE' as const;
}

/**
 * Checkpoint jobs do not necessarily publish a Redis pointer, but their
 * semantic finalizer is still the PostgreSQL evidence boundary for a
 * freshness window.  Keep this side-channel best-effort: a telemetry outage
 * must never turn an already committed scheduler completion into a failure.
 */
export async function recordCheckpointFreshnessEvidence(input: {
  jobName: string;
  evidence: unknown;
  completedAt: Date | null;
  runId?: string | null;
}): Promise<void> {
  const contract = contractForSchedulerJob(input.jobName);
  if (contract?.freshnessEvidence !== 'checkpoint') return;
  const evidence =
    input.evidence && typeof input.evidence === 'object' && !Array.isArray(input.evidence)
      ? (input.evidence as Record<string, unknown>)
      : {};
  const windowIds = freshnessWindowIdsFromEvidence(evidence);
  if (windowIds.length === 0) return;
  const completedAt = input.completedAt ?? new Date();
  const producerRevision = [
    evidence.revision,
    evidence.snapshotRevision,
    evidence.checkpointRevision,
    evidence.publicationRevision,
    input.runId,
  ].find(
    (value): value is string | number => typeof value === 'string' || typeof value === 'number',
  );
  const expectedCount = finiteEvidenceCount(evidence, [
    'expectedCount',
    'requiredUnits',
    'expectedUnits',
  ]);
  const observedCount = finiteEvidenceCount(evidence, [
    'observedCount',
    'succeededUnits',
    'observedUnits',
  ]);
  for (const windowId of windowIds) {
    try {
      await recordFreshnessObservation({
        windowId,
        sourceCheckedAt: completedAt,
        pgPublishedAt: completedAt,
        ...(producerRevision === undefined ? {} : { producerRevision: String(producerRevision) }),
        ...(expectedCount === undefined ? {} : { expectedCount }),
        ...(observedCount === undefined ? {} : { observedCount }),
        completenessStatus: checkpointCompleteness(evidence),
      });
    } catch (error) {
      logError('Checkpoint freshness evidence update failed', error, {
        jobName: input.jobName,
        windowId,
      });
    }
  }
}

function immutableScheduledDueAt(dueAt: Date, scheduledDueAtMs: string | null): Date {
  if (!scheduledDueAtMs || !/^[0-9]+$/.test(scheduledDueAtMs)) return dueAt;
  const timestamp = Number(scheduledDueAtMs);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) return dueAt;
  const scheduled = new Date(timestamp);
  return Number.isFinite(scheduled.getTime()) ? scheduled : dueAt;
}

export async function reserveSchedulerObligation(input: {
  definition: { name: string; cadence: string; timezone: string; queueName?: string };
  plan: SchedulerObligationPlan;
  db?: DbOrTransaction;
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
        ...(input.definition.queueName ? { scheduledQueueName: input.definition.queueName } : {}),
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
 * Attach immutable source hand-off metadata to an already-reserved
 * obligation. A hot watcher often observes the price move after the ordinary
 * five-minute scheduler has reserved/enqueued the same waterline. Updating
 * the evidence keeps that single Bull job in place while allowing its worker
 * to replay the exact captured bootstrap instead of creating a parallel job.
 */
export async function mergeSchedulerObligationEvidence(input: {
  obligationId: string;
  evidence: Record<string, unknown>;
  db?: DbOrTransaction;
}): Promise<SchedulerObligation> {
  const db = input.db ?? (await getDb());
  const rows = await db
    .update(schedulerObligationsInOps)
    .set({
      evidence: sql`${schedulerObligationsInOps.evidence} || ${JSON.stringify(input.evidence)}::jsonb`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(eq(schedulerObligationsInOps.obligationId, input.obligationId))
    .returning();
  if (!rows[0]) throw new Error('Scheduler obligation disappeared while merging evidence');
  return mapRow(rows[0]);
}

export async function getSchedulerObligation(input: {
  obligationId: string;
  db?: DbHandle;
}): Promise<SchedulerObligation | null> {
  const db = input.db ?? (await getDb());
  const rows = await db
    .select()
    .from(schedulerObligationsInOps)
    .where(eq(schedulerObligationsInOps.obligationId, input.obligationId))
    .limit(1);
  return rows[0] ? mapRow(rows[0]) : null;
}

async function refreshPostMatchObligationAuthority(input: {
  obligation: SchedulerObligation;
  plan: SchedulerObligationPlan;
  db: DbOrTransaction;
}): Promise<SchedulerObligation> {
  const resultSlot = input.plan.evidence?.resultSlot;
  const resultAuthorityAtMs = input.plan.evidence?.resultAuthorityAtMs;
  const resultScheduleAnchorMs = input.plan.evidence?.resultScheduleAnchorMs;
  if (
    typeof resultSlot !== 'string' ||
    !Number.isSafeInteger(resultAuthorityAtMs) ||
    Number(resultAuthorityAtMs) <= 0 ||
    !Number.isSafeInteger(resultScheduleAnchorMs) ||
    Number(resultScheduleAnchorMs) <= 0
  ) {
    return input.obligation;
  }
  const scheduledDueAtMs = input.plan.dueAt.getTime();
  const scheduledDueAtIso = input.plan.dueAt.toISOString();
  const currentAuthorityAt = postMatchAuthorityAtForSql(sql`${schedulerObligationsInOps.evidence}`);
  const currentScheduleAnchor = postMatchScheduleAnchorForSql(
    sql`${schedulerObligationsInOps.evidence}`,
  );
  const newerAuthority = sql`(
    ${currentAuthorityAt} IS NULL OR ${currentAuthorityAt} < ${Number(resultAuthorityAtMs)}
  )`;
  const scheduleChanged = sql`(
    ${currentScheduleAnchor} IS NULL OR
    ${currentScheduleAnchor} <> ${Number(resultScheduleAnchorMs)}
  )`;
  const planEvidence = {
    ...(input.plan.evidence ?? {}),
    ...(input.plan.eventId === undefined ? {} : { targetEventId: input.plan.eventId }),
    scheduledDueAtMs,
  };
  const reactivationEvidence = {
    ...planEvidence,
    reactivatedForScheduleAuthority: true,
  };
  const refreshed = await input.db
    .update(schedulerObligationsInOps)
    .set({
      source: input.plan.source,
      dueAt: sql`CASE
        WHEN ${scheduleChanged} THEN ${scheduledDueAtIso}::timestamptz
        ELSE ${schedulerObligationsInOps.dueAt}
      END`,
      evidence: sql`${schedulerObligationsInOps.evidence} || ${JSON.stringify(planEvidence)}::jsonb`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(schedulerObligationsInOps.obligationId, input.obligation.obligationId),
        inArray(schedulerObligationsInOps.status, ['pending', 'failed']),
        newerAuthority,
      ),
    )
    .returning();
  if (refreshed[0]) return mapRow(refreshed[0]);

  // Persist a newer authority version without rerunning work when the durable
  // schedule itself is unchanged. Besides avoiding false retries, this keeps a
  // late resolver for an older schedule version from outranking a completed or
  // in-flight row whose ordinary fixture refresh was already observed.
  const authorityAdvancedWithoutScheduleChange = await input.db
    .update(schedulerObligationsInOps)
    .set({
      source: input.plan.source,
      evidence: sql`${schedulerObligationsInOps.evidence} || ${JSON.stringify(planEvidence)}::jsonb`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(schedulerObligationsInOps.obligationId, input.obligation.obligationId),
        inArray(schedulerObligationsInOps.status, ['enqueued', 'running', 'succeeded']),
        newerAuthority,
        sql`NOT ${scheduleChanged}`,
      ),
    )
    .returning();
  if (authorityAdvancedWithoutScheduleChange[0]) {
    return mapRow(authorityAdvancedWithoutScheduleChange[0]);
  }

  const reactivated = await input.db
    .update(schedulerObligationsInOps)
    .set({
      status: 'pending',
      source: input.plan.source,
      dueAt: input.plan.dueAt,
      generation: sql`${schedulerObligationsInOps.generation} + 1`,
      leaseOwner: null,
      leaseExpiresAt: null,
      bullJobId: null,
      runId: null,
      lastError: null,
      evidence: reactivationEvidence,
      completedAt: null,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(schedulerObligationsInOps.obligationId, input.obligation.obligationId),
        sql`(
          (
            ${schedulerObligationsInOps.status} = 'succeeded'
            AND ${/^(provisional|final)-\d+$/.test(resultSlot)}
            AND ${scheduleChanged}
          ) OR (
            ${schedulerObligationsInOps.status} = 'skipped'
            AND ${schedulerObligationsInOps.evidence}->>'reason' =
                ${SUPERSEDED_BY_LATEST_AUTHORITATIVE}
          )
        )`,
        newerAuthority,
      ),
    )
    .returning();
  return reactivated[0] ? mapRow(reactivated[0]) : input.obligation;
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
      lastError: null,
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
      lastError: null,
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
  const contract = contractForSchedulerJob(input.jobName);
  if (contract && contractHasFreshnessWindow(contract, input.jobName)) {
    await db
      .update(freshnessSloWindowsInOps)
      .set({
        status: 'NOT_APPLICABLE',
        completenessStatus: 'NOT_APPLICABLE',
        breachCode: null,
        evidence: sql`${freshnessSloWindowsInOps.evidence} || ${JSON.stringify({
          reason: 'SUPERSEDED_BY_LATEST',
          ...(input.evidence?.supersededByPeriodKey === undefined
            ? {}
            : { supersededByPeriodKey: input.evidence.supersededByPeriodKey }),
        })}::jsonb`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(freshnessSloWindowsInOps.contractKey, contract.contractKey),
          eq(freshnessSloWindowsInOps.scopeKey, input.scopeKey),
          inArray(freshnessSloWindowsInOps.status, ['PENDING', 'INVALID']),
          sql`${freshnessSloWindowsInOps.obligationDueAt} < ${beforeDueAt}::timestamptz`,
        ),
      );
  }
  return updated.length;
}

export type SchedulerDueAtSupersessionBoundary = Readonly<{
  jobName: string;
  scopeKey: string;
  periodKey: string;
  resultSlot: string;
  resultAuthorityAtMs?: number;
  resultScheduleAnchorMs?: number;
  beforeDueAt: Date;
}>;

/**
 * Post-match latest-authoritative checkpoints can cover every finalized event.
 * Coalesce all job/scope boundaries in one statement so a season-end scheduler
 * pass does not issue one permanent no-op update per job and event.
 *
 * The authoritative period identity is excluded explicitly. Absolute slot
 * time ranks rescheduled fixtures; for the same numbered slot, final authority
 * outranks provisional authority even for pre-rollout observation timestamps.
 * A persisted fixture update timestamp orders different schedule versions, so
 * a stale resolver cannot reverse a fresh exact-hour reschedule after waiting
 * for the lane lock. Immutable due time orders slots within one version.
 */
export async function supersedeSchedulerObligationsByDueAtBatch(input: {
  boundaries: readonly SchedulerDueAtSupersessionBoundary[];
  evidence?: Record<string, unknown>;
  db?: DbOrTransaction;
}): Promise<number> {
  if (input.boundaries.length === 0) return 0;
  const seen = new Set<string>();
  const boundaries = input.boundaries.map((boundary) => {
    if (
      boundary.jobName.length === 0 ||
      boundary.scopeKey.length === 0 ||
      boundary.periodKey.length === 0 ||
      typeof boundary.resultSlot !== 'string' ||
      boundary.resultSlot.length === 0 ||
      (boundary.resultAuthorityAtMs !== undefined &&
        (!Number.isSafeInteger(boundary.resultAuthorityAtMs) ||
          boundary.resultAuthorityAtMs <= 0)) ||
      (boundary.resultScheduleAnchorMs !== undefined &&
        (!Number.isSafeInteger(boundary.resultScheduleAnchorMs) ||
          boundary.resultScheduleAnchorMs <= 0)) ||
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
      result_slot: boundary.resultSlot,
      result_authority_at_ms: boundary.resultAuthorityAtMs ?? null,
      result_schedule_anchor_ms: boundary.resultScheduleAnchorMs ?? null,
      before_due_at: boundary.beforeDueAt.toISOString(),
    };
  });
  const db = input.db ?? (await getDb());
  const boundarySlot = sql`boundaries.result_slot`;
  const obligationSlot = sql`obligation.evidence->>'resultSlot'`;
  const boundaryAuthorityAt = sql`boundaries.result_authority_at_ms`;
  const obligationAuthorityAt = postMatchAuthorityAtForSql(sql`obligation.evidence`);
  const boundaryScheduleAnchor = sql`boundaries.result_schedule_anchor_ms`;
  const obligationScheduleAnchor = postMatchScheduleAnchorForSql(sql`obligation.evidence`);
  const boundaryDueAt = sql`boundaries.before_due_at`;
  const obligationDueAt = immutableScheduledDueAtForSql(
    sql`obligation.evidence`,
    sql`obligation.due_at`,
  );
  const updated = await db.execute<{
    jobName: string;
    scopeKey: string;
    periodKey: string;
  }>(sql`
    WITH boundaries AS (
      SELECT job_name, scope_key, period_key, result_slot,
             result_authority_at_ms, result_schedule_anchor_ms, before_due_at
      FROM jsonb_to_recordset(${JSON.stringify(boundaries)}::jsonb) AS boundary(
        job_name text,
        scope_key text,
        period_key text,
        result_slot text,
        result_authority_at_ms bigint,
        result_schedule_anchor_ms bigint,
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
          last_error = NULL,
          updated_at = clock_timestamp()
      FROM boundaries
      WHERE obligation.job_name = boundaries.job_name
        AND obligation.scope_key = boundaries.scope_key
        AND obligation.period_key <> boundaries.period_key
        AND ${postMatchIdentityIsNewerSql({
          newerSlot: boundarySlot,
          newerDueAt: boundaryDueAt,
          newerAuthorityAt: boundaryAuthorityAt,
          newerScheduleAnchor: boundaryScheduleAnchor,
          olderSlot: obligationSlot,
          olderDueAt: obligationDueAt,
          olderAuthorityAt: obligationAuthorityAt,
          olderScheduleAnchor: obligationScheduleAnchor,
        })}
        AND obligation.status IN ('pending', 'failed')
      RETURNING obligation.obligation_id
    )
    SELECT obligation.job_name AS "jobName",
           obligation.scope_key AS "scopeKey",
           obligation.period_key AS "periodKey"
    FROM ops.scheduler_obligations AS obligation
    INNER JOIN updated
      ON updated.obligation_id = obligation.obligation_id
  `);
  if (updated.length === 0) return 0;

  // The obligation update above is the authority for supersession.  Mirror
  // only those rows into the SLO ledger; marking every earlier period for a
  // stale boundary would incorrectly turn a still-valid checkpoint into
  // NOT_APPLICABLE.  Keep the update in the caller's transaction so a
  // post-match reservation, supersession and window retirement commit
  // together.
  const boundaryByIdentity = new Map(
    input.boundaries.map((boundary) => [`${boundary.jobName}\u0000${boundary.scopeKey}`, boundary]),
  );
  const windowGroups = new Map<
    string,
    { contractKey: string; jobName: string; scopeKey: string; periods: string[] }
  >();
  for (const row of updated) {
    const contract = contractForSchedulerJob(row.jobName);
    if (!contract || !contractHasFreshnessWindow(contract, row.jobName)) continue;
    const key = `${row.jobName}\u0000${row.scopeKey}`;
    const group = windowGroups.get(key) ?? {
      contractKey: contract.contractKey,
      jobName: row.jobName,
      scopeKey: row.scopeKey,
      periods: [],
    };
    if (!group.periods.includes(row.periodKey)) group.periods.push(row.periodKey);
    windowGroups.set(key, group);
  }
  for (const group of windowGroups.values()) {
    const boundary = boundaryByIdentity.get(`${group.jobName}\u0000${group.scopeKey}`);
    await db
      .update(freshnessSloWindowsInOps)
      .set({
        status: 'NOT_APPLICABLE',
        completenessStatus: 'NOT_APPLICABLE',
        breachCode: null,
        evidence: sql`${freshnessSloWindowsInOps.evidence} || ${JSON.stringify({
          reason: 'SUPERSEDED_BY_LATEST',
          ...(boundary ? { supersededByPeriodKey: boundary.periodKey } : {}),
          ...(input.evidence ?? {}),
        })}::jsonb`,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(freshnessSloWindowsInOps.contractKey, group.contractKey),
          eq(freshnessSloWindowsInOps.scopeKey, group.scopeKey),
          inArray(freshnessSloWindowsInOps.periodKey, group.periods),
          inArray(freshnessSloWindowsInOps.status, ['PENDING', 'INVALID']),
        ),
      );
  }
  return updated.length;
}

export type SchedulerObligationReservation = Readonly<{
  definition: Readonly<{ name: string; cadence: string; timezone: string; queueName?: string }>;
  plan: SchedulerObligationPlan;
}>;

/**
 * Reserve the current post-match identities, refresh their durable fixture
 * authority, and retire stale peers in one transaction under the same lane
 * advisory lock used by claim. A previously superseded identity is revived
 * only when it reappears with a strictly newer authority version; a succeeded
 * identity gets a new generation only when that version also changes the
 * schedule anchor. A claimant that waits for this transaction takes its
 * statement snapshot only after the current identities are committed, so an
 * uncommitted reservation cannot be missed by the latest-authoritative fence.
 */
export async function reconcilePostMatchSchedulerObligations(input: {
  reservations: readonly SchedulerObligationReservation[];
  boundaries: readonly SchedulerDueAtSupersessionBoundary[];
  evidence?: Record<string, unknown>;
  db?: DbHandle;
}): Promise<Readonly<{ reservations: readonly SchedulerObligation[]; superseded: number }>> {
  if (input.reservations.some(({ plan }) => plan.terminalStatus !== undefined)) {
    throw new Error('Post-match atomic reconciliation only accepts active plans');
  }
  if (input.reservations.length === 0 && input.boundaries.length === 0) {
    return { reservations: [], superseded: 0 };
  }
  const db = input.db ?? (await getDb());
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(
        hashtextextended(${'scheduler-lane:post-match-results'}, 0)
      )`,
    );
    const reservations: SchedulerObligation[] = [];
    for (const reservation of input.reservations) {
      const obligation = await reserveSchedulerObligation({ ...reservation, db: tx });
      reservations.push(
        await refreshPostMatchObligationAuthority({
          obligation,
          plan: reservation.plan,
          db: tx,
        }),
      );
    }
    const superseded = await supersedeSchedulerObligationsByDueAtBatch({
      boundaries: input.boundaries,
      evidence: input.evidence,
      db: tx,
    });
    return { reservations, superseded };
  });
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
  const deferredError = input.error
    ? summarizeDataError(new Error(input.error)).summary
    : undefined;
  const updated = await db
    .update(schedulerObligationsInOps)
    .set({
      dueAt: sql`clock_timestamp() + ${delayMs} * interval '1 millisecond'`,
      // A pending obligation is deferred work, not a failed terminal attempt.
      // Preserve the diagnostic in structured evidence and only expose a
      // current obligation error while the row remains failed.
      ...(deferredError
        ? {
            lastError: sql`CASE
              WHEN ${schedulerObligationsInOps.status} = 'failed'::text
                THEN ${`TRANSIENT_INFRA:${deferredError}`}
              ELSE NULL
            END`,
            evidence: sql`${schedulerObligationsInOps.evidence} || jsonb_build_object(
              'deferredError', ${`TRANSIENT_INFRA:${deferredError}`}::text,
              'deferredAt', clock_timestamp()
            )`,
          }
        : {
            lastError: sql`CASE
              WHEN ${schedulerObligationsInOps.status} = 'failed'::text
                THEN ${schedulerObligationsInOps.lastError}
              ELSE NULL
            END`,
          }),
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

/**
 * Admission control must defer a claimed obligation instead of failing it.
 * The owner/generation/status fence makes the operation safe when a worker
 * observes DRAIN_ONLY concurrently with another scheduler recovery pass.
 */
export async function deferSchedulerObligationForAdmission(input: {
  obligationId: string;
  owner: string;
  generation: number;
  delayMs?: number;
  db?: DbHandle;
}): Promise<boolean> {
  const db = input.db ?? (await getDb());
  const delayMs = Math.max(1_000, Math.floor(input.delayMs ?? 60_000));
  if (!Number.isSafeInteger(input.generation) || input.generation < 0) {
    throw new Error('Scheduler generation must be a non-negative integer');
  }
  if (!Number.isSafeInteger(delayMs)) throw new Error('Scheduler defer delay must be an integer');
  const result = await db
    .update(schedulerObligationsInOps)
    .set({
      status: 'pending',
      dueAt: sql`clock_timestamp() + ${delayMs} * interval '1 millisecond'`,
      leaseOwner: null,
      leaseExpiresAt: null,
      bullJobId: null,
      runId: null,
      lastError: null,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(schedulerObligationsInOps.obligationId, input.obligationId),
        eq(schedulerObligationsInOps.leaseOwner, input.owner),
        eq(schedulerObligationsInOps.generation, input.generation),
        eq(schedulerObligationsInOps.status, 'enqueued'),
      ),
    )
    .returning({ obligationId: schedulerObligationsInOps.obligationId });
  return result.length === 1;
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
    /** Revalidate one latest-authoritative identity per durable job/scope. */
    enforceLatestAuthoritativeScope?: boolean;
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
  const currentResultSlot = sql`${schedulerObligationsInOps.evidence}->>'resultSlot'`;
  const newerResultSlot = sql`newer.evidence->>'resultSlot'`;
  const currentDueAt = immutableScheduledDueAtSql();
  const newerDueAt = immutableScheduledDueAtForSql(sql`newer.evidence`, sql`newer.due_at`);
  const currentAuthorityAt = postMatchAuthorityAtForSql(sql`${schedulerObligationsInOps.evidence}`);
  const newerAuthorityAt = postMatchAuthorityAtForSql(sql`newer.evidence`);
  const currentScheduleAnchor = postMatchScheduleAnchorForSql(
    sql`${schedulerObligationsInOps.evidence}`,
  );
  const newerScheduleAnchor = postMatchScheduleAnchorForSql(sql`newer.evidence`);
  const latestAuthoritativeScope = input.enforceLatestAuthoritativeScope
    ? sql`NOT EXISTS (
        SELECT 1
        FROM ops.scheduler_obligations AS newer
        WHERE newer.job_name = ${schedulerObligationsInOps.jobName}
          AND newer.scope_key = ${schedulerObligationsInOps.scopeKey}
          AND newer.period_key <> ${schedulerObligationsInOps.periodKey}
          AND ${postMatchIdentityIsNewerSql({
            newerSlot: newerResultSlot,
            newerDueAt,
            newerAuthorityAt,
            newerScheduleAnchor,
            olderSlot: currentResultSlot,
            olderDueAt: currentDueAt,
            olderAuthorityAt: currentAuthorityAt,
            olderScheduleAnchor: currentScheduleAnchor,
          })}
      )`
    : undefined;
  const owner = randomUUID();
  return db.transaction(async (tx) => {
    // Scheduler coordination is a bounded control-plane operation. A stuck
    // connection or advisory lock must fail this claim and let the next
    // 30-second pass recover, rather than pinning the scheduler in-flight.
    await tx.execute(sql`SET LOCAL statement_timeout = '10s'`);
    await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
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
          latestAuthoritativeScope,
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
            lastError: null,
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
          lastError: null,
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
 * Earliest-due candidates used by the scheduler's EDF admission pass.  The
 * claimant still rechecks this ordering and all lane/generation predicates in
 * its transaction; this read only avoids claiming a newer low-priority bucket
 * ahead of an older deadline.
 */
export async function findDueSchedulerObligationCandidates(
  input: {
    excludedJobNames?: readonly string[];
    db?: DbHandle;
  } = {},
): Promise<
  readonly {
    jobName: string;
    /** Mutable retry eligibility timestamp. */
    earliestDueAt: Date;
    /** Immutable schedule boundary used for dispatch deadlines and lateness. */
    earliestScheduledDueAt: Date;
  }[]
> {
  const db = input.db ?? (await getDb());
  const excludedJobNames = [...new Set(input.excludedJobNames ?? [])].filter(
    (name) => name.length > 0,
  );
  const scheduledDueAt = immutableScheduledDueAtSql();
  const rows = await db.execute<{
    jobName: string;
    earliestDueAt: Date | string;
    earliestScheduledDueAt: Date | string;
  }>(sql`
    SELECT
      job_name AS "jobName",
      min(due_at) AS "earliestDueAt",
      min(${scheduledDueAt}) AS "earliestScheduledDueAt"
    FROM ops.scheduler_obligations
    WHERE due_at <= clock_timestamp()
      AND status IN ('pending', 'failed')
      ${
        excludedJobNames.length > 0
          ? sql`AND job_name NOT IN (${sql.join(
              excludedJobNames.map((name) => sql`${name}`),
              sql`, `,
            )})`
          : sql``
      }
    GROUP BY job_name
    ORDER BY min(${scheduledDueAt}) ASC, min(obligation_id::text) ASC
  `);
  return rows
    .map((row) => {
      const dueAt =
        row.earliestDueAt instanceof Date ? row.earliestDueAt : new Date(row.earliestDueAt);
      if (!Number.isFinite(dueAt.getTime())) return null;
      const scheduledDueAtValue =
        row.earliestScheduledDueAt instanceof Date
          ? row.earliestScheduledDueAt
          : new Date(row.earliestScheduledDueAt);
      const earliestScheduledDueAt = Number.isFinite(scheduledDueAtValue.getTime())
        ? scheduledDueAtValue
        : dueAt;
      return { jobName: row.jobName, earliestDueAt: dueAt, earliestScheduledDueAt };
    })
    .filter(
      (
        row,
      ): row is {
        jobName: string;
        earliestDueAt: Date;
        earliestScheduledDueAt: Date;
      } => row !== null,
    );
}

/**
 * Find expired in-flight obligations for BullMQ reconciliation. Lease expiry
 * is observation evidence only: the reconciler must inspect the exact Bull
 * generation before it may settle or retry one of these rows.
 */
export async function listExpiredSchedulerObligations(
  input: { limit?: number; excludedJobNames?: readonly string[]; db?: DbHandle } = {},
): Promise<readonly SchedulerObligation[]> {
  const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new Error('Scheduler recovery limit must be between 1 and 200');
  }
  const db = input.db ?? (await getDb());
  const excludedJobNames = [...new Set(input.excludedJobNames ?? [])].filter(
    (name) => name.length > 0,
  );
  const rows = await db
    .select()
    .from(schedulerObligationsInOps)
    .where(
      and(
        inArray(schedulerObligationsInOps.status, ['enqueued', 'running']),
        lte(schedulerObligationsInOps.leaseExpiresAt, sql`clock_timestamp()`),
        excludedJobNames.length > 0
          ? notInArray(schedulerObligationsInOps.jobName, excludedJobNames)
          : undefined,
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
  /** Actual Bull queue used for this generation. */
  queueName?: string;
  db?: DbHandle;
}): Promise<boolean> {
  const db = input.db ?? (await getDb());
  const updated = await db
    .update(schedulerObligationsInOps)
    .set({
      bullJobId: input.bullJobId === undefined ? undefined : String(input.bullJobId),
      runId: input.runId,
      ...(input.queueName
        ? {
            evidence: sql`${schedulerObligationsInOps.evidence} || jsonb_build_object('submittedQueueName', ${input.queueName}::text)`,
          }
        : {}),
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
  /** Only an irrecoverable terminal error keeps a durable error marker. */
  lastError?: string | null;
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
      lastError: input.status === 'irrecoverable' ? (input.lastError ?? null) : null,
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
    .returning({
      obligationId: schedulerObligationsInOps.obligationId,
      jobName: schedulerObligationsInOps.jobName,
      evidence: schedulerObligationsInOps.evidence,
      completedAt: schedulerObligationsInOps.completedAt,
      runId: schedulerObligationsInOps.runId,
    });
  const row = updated[0];
  if (!row) return false;
  await recordCheckpointFreshnessEvidence(row);
  return true;
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
  /** Historical/current-day skips clear errors; failed terminal work keeps one. */
  lastError?: string | null;
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
      lastError:
        (input.status ?? 'irrecoverable') === 'irrecoverable' ? (input.lastError ?? null) : null,
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
      lastError: null,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(schedulerObligationsInOps.bullJobId, String(input.bullJobId)),
        inArray(schedulerObligationsInOps.status, ['enqueued', 'running']),
      ),
    )
    .returning({
      obligationId: schedulerObligationsInOps.obligationId,
      jobName: schedulerObligationsInOps.jobName,
      evidence: schedulerObligationsInOps.evidence,
      completedAt: schedulerObligationsInOps.completedAt,
      runId: schedulerObligationsInOps.runId,
    });
  const row = updated[0];
  if (!row) return false;
  await recordCheckpointFreshnessEvidence(row);
  return true;
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
  const classified = summarizeDataError(input.error);
  const retryPolicy = retryPolicyForError(classified.errorClass);
  const summary = `${classified.errorClass}:${classified.errorCode} ${classified.summary}`.slice(
    0,
    1_000,
  );
  const retryDelayMs = Math.max(0, Math.floor(input.retryDelayMs ?? 60_000));
  // `attempts` is incremented when a failed obligation is claimed for a new
  // generation.  Keep transient/provider retries bounded at the scheduler
  // layer as well as at Bull's per-job attempt layer; otherwise a source that
  // stays unavailable would create an unbounded stream of new generations.
  const terminalAfterThisAttempt = sql`${schedulerObligationsInOps.attempts} >= ${retryPolicy.maxAttempts}`;
  const updated = await db
    .update(schedulerObligationsInOps)
    .set({
      status: sql`CASE WHEN ${terminalAfterThisAttempt} THEN 'irrecoverable' ELSE 'failed' END`,
      dueAt: sql`CASE
        WHEN ${terminalAfterThisAttempt} THEN clock_timestamp()
        ELSE clock_timestamp() + ${retryDelayMs} * interval '1 millisecond'
      END`,
      completedAt: sql`CASE WHEN ${terminalAfterThisAttempt} THEN clock_timestamp() ELSE NULL END`,
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
    .returning({
      obligationId: schedulerObligationsInOps.obligationId,
      status: schedulerObligationsInOps.status,
    });
  if (updated.length === 1) {
    // A terminal worker failure is durable evidence that needs an actionable
    // repair case. Persisting the case is best-effort and must never mask the
    // already-recorded obligation failure.
    // Retryable provider/source-not-ready errors should not open a governance
    // case on every bounded attempt.  Once the scheduler exhausts the policy
    // and marks the obligation irrecoverable, keep an actionable case even if
    // the individual error class normally relies on the SLO observer.
    if (retryPolicy.createGovernanceCase || updated[0]?.status === 'irrecoverable') {
      try {
        const [obligation] = await db
          .select({
            jobName: schedulerObligationsInOps.jobName,
            scopeKey: schedulerObligationsInOps.scopeKey,
            generation: schedulerObligationsInOps.generation,
          })
          .from(schedulerObligationsInOps)
          .where(eq(schedulerObligationsInOps.obligationId, input.obligationId))
          .limit(1);
        const contract = obligation ? contractForSchedulerJob(obligation.jobName) : undefined;
        if (obligation && contract) {
          await openGovernanceCase({
            caseKind: 'scheduler-failure',
            contractKey: contract.contractKey,
            lane: queueLaneForSchedulerJob(obligation.jobName) ?? contract.queueLane,
            obligationId: input.obligationId,
            scopeKey: obligation.scopeKey,
            errorClass: classified.errorClass,
            errorCode: classified.errorCode,
            fingerprint: `${obligation.jobName}:${obligation.scopeKey}:${classified.errorCode}`,
            evidence: {
              generation: obligation.generation,
              retryable: retryPolicy.retryable,
              maxAttempts: retryPolicy.maxAttempts,
            },
            repairTarget: { jobName: obligation.jobName, scopeKey: obligation.scopeKey },
            compensator: contract.compensator,
            db,
          });
        }
      } catch (caseError) {
        logError('Scheduler failure governance case persistence failed', caseError, {
          obligationId: input.obligationId,
        });
      }
    }
  }
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
