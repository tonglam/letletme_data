import { createHash, randomUUID } from 'node:crypto';

import { and, asc, desc, eq, inArray, isNull, isNotNull, lte, max, or, sql } from 'drizzle-orm';

import {
  contentAcquisitionGaps,
  contentAcquisitionBudgetReservations,
  contentAcquisitionJobOutbox,
  contentAcquisitionProviderTraces,
  contentAcquisitionRuns,
  contentSourceEndpoints,
  contentSourcePartitionMembers,
  contentSourcePartitions,
  contentSourceObservations,
  contentSourceSchedules,
  contentSources,
} from '../../db/schemas/content.schema';
import { getDb, type DbHandle, type TransactionHandle } from '../../db/singleton';
import {
  getAcquisitionProfile,
  X_ACQUISITION_LANES,
  type AcquisitionPhase,
  type XAcquisitionLane,
} from './acquisition-profiles';
import { sha256CanonicalJson } from './canonicalization';
import type { SupadataFailureEvidence } from './supadata-transcript-client';
import {
  acquisitionJobV1Schema,
  parseFormalRunRequestV1,
  type AcquisitionJobV1,
  type FormalRunRequestV1,
} from './formal-run-contract';
import {
  compileXKeywordRequest,
  compileXSemanticRequest,
  compileXUserRequest,
} from './x-query-compiler';
import {
  commitProbeAndReleaseXRunBudgets,
  commitOneXRunBudgetUnit,
  commitRunBudgets,
  reconcileReservedProviderBudget,
  releaseXRunBudgets,
  reserveXRunBudgets,
  type XBudgetPolicy,
} from './x-budget';
import { backstopSlotEndForDueAt, latestBackstopSlotEndAt } from './registry-state';
import { xEndpointMayScan } from './x-identity-policy';

export type RecurringAdapterKind =
  | 'X_ACCOUNT'
  | 'X_SEMANTIC'
  | 'RSS_ATOM'
  | 'PODCAST_FEED'
  | 'YOUTUBE_CHANNEL';

export type FormalQueueKind = 'X' | 'HTTP' | 'MEDIA';

export type ClaimedFormalRun = Readonly<{
  runId: string;
  scheduleId: string | null;
  scheduleKey: string;
  jobKind: string;
  queueKind: FormalQueueKind;
  jobId: string;
  job: AcquisitionJobV1;
  phase: AcquisitionPhase;
  requestHash: string;
  priority: number;
}>;

export type BegunFormalRun = Readonly<{
  runId: string;
  scheduleId: string | null;
  scheduleKey: string | null;
  parentRunId: string | null;
  request: FormalRunRequestV1;
  providerJobId: string | null;
  providerUnits: number;
  providerTraceSequence: number;
  status: 'RUNNING' | 'TERMINAL';
}>;

export type FormalRunProviderEvidence = Readonly<{
  provider: 'grok-build' | 'tikhub';
  operation: string;
  requestMetadataHash: string;
  responseMetadataHash: string | null;
  providerJobIdHash: string | null;
  providerUnits: number;
  terminalState: string;
  runMetrics: Readonly<Record<string, unknown>>;
}>;

/**
 * A host-runner liveness probe is a real billable X call, but the probe
 * endpoint intentionally returns only a bounded health response.  Keep its
 * request identity while allowing the provider response/call id to remain
 * unavailable rather than inventing evidence the runner did not return.
 */
export type FormalRunProbeEvidence = Readonly<{
  provider: 'grok-build';
  operation: 'x_user_search';
  requestMetadataHash: string;
  responseMetadataHash: string | null;
  providerJobIdHash: string | null;
  providerUnits: 1;
  terminalState: string;
  runMetrics: Readonly<Record<string, unknown>>;
}>;

export type FormalRunFailureRejection = Readonly<{
  endpointKey: string;
  externalItemId: string;
  reasonCode: string;
  nativeItemHash?: string | null;
}>;

type JsonRecord = Record<string, unknown>;

const asRecord = (value: unknown): JsonRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {};

const asString = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

function dateValue(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const result = value instanceof Date ? value : new Date(value);
  return Number.isFinite(result.getTime()) ? result : null;
}

export function resolveFormalAcquisitionPhase(input: {
  now: Date;
  nextDeadline: Date | null;
}): AcquisitionPhase {
  if (!input.nextDeadline) return 'NORMAL';
  const untilDeadline = input.nextDeadline.getTime() - input.now.getTime();
  if (untilDeadline >= 0 && untilDeadline <= 90 * 60_000) return 'FINAL90';
  if (untilDeadline >= 0 && untilDeadline <= 24 * 60 * 60_000) return 'APPROACHING';
  return 'NORMAL';
}

function queueKind(adapterKind: string): FormalQueueKind {
  if (adapterKind === 'X_ACCOUNT' || adapterKind === 'X_SEMANTIC') return 'X';
  if (adapterKind === 'HERMES_TRANSCRIPT') return 'MEDIA';
  return 'HTTP';
}

export function formalAcquisitionJobId(input: {
  targetId: string;
  jobKind: string;
  windowEnd: Date;
  profileRevision: number;
  attemptNo: number;
  requestHash: string;
}): string {
  const value = [
    input.targetId,
    input.jobKind,
    input.windowEnd.getTime(),
    input.profileRevision,
    input.attemptNo,
    input.requestHash,
  ].join('\u001f');
  return `content-acquisition-${createHash('sha256').update(value, 'utf8').digest('hex')}`;
}

async function endpointSnapshot(tx: TransactionHandle, endpointId: string) {
  const rows = await tx
    .select({
      endpointId: contentSourceEndpoints.endpointId,
      endpointKey: contentSourceEndpoints.endpointKey,
      sourceId: contentSources.sourceId,
      sourceKey: contentSources.sourceKey,
      sourceStatus: contentSources.status,
      adapterKind: contentSourceEndpoints.adapterKind,
      profileKey: contentSourceEndpoints.profileKey,
      locator: contentSourceEndpoints.locator,
      stableExternalId: contentSourceEndpoints.stableExternalId,
      identityRequirement: contentSourceEndpoints.identityRequirement,
      identityStatus: contentSourceEndpoints.identityStatus,
      endpointStatus: contentSourceEndpoints.status,
      endpointRightsPolicy: contentSourceEndpoints.rightsPolicy,
      sourceRightsPolicy: contentSources.rightsPolicy,
    })
    .from(contentSourceEndpoints)
    .innerJoin(contentSources, eq(contentSources.sourceId, contentSourceEndpoints.sourceId))
    .where(eq(contentSourceEndpoints.endpointId, endpointId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    endpointId: row.endpointId,
    endpointKey: row.endpointKey,
    sourceId: row.sourceId,
    sourceKey: row.sourceKey,
    sourceStatus: row.sourceStatus,
    adapterKind: row.adapterKind,
    profileKey: row.profileKey,
    locator: asRecord(row.locator) as Record<string, string>,
    stableExternalId: row.stableExternalId,
    identityRequirement: row.identityRequirement,
    identityStatus: row.identityStatus,
    endpointStatus: row.endpointStatus,
    rightsPolicy: {
      source: asRecord(row.sourceRightsPolicy),
      endpoint: asRecord(row.endpointRightsPolicy),
    },
  };
}

async function partitionSnapshot(tx: TransactionHandle, partitionId: string) {
  const partitionRows = await tx
    .select({
      partitionId: contentSourcePartitions.partitionId,
      partitionKey: contentSourcePartitions.partitionKey,
      adapterKind: contentSourcePartitions.adapterKind,
      profileKey: contentSourcePartitions.profileKey,
      status: contentSourcePartitions.status,
    })
    .from(contentSourcePartitions)
    .where(eq(contentSourcePartitions.partitionId, partitionId))
    .limit(1);
  const partition = partitionRows[0];
  if (!partition) return null;
  const rows = await tx
    .select({
      position: contentSourcePartitionMembers.position,
      endpointId: contentSourceEndpoints.endpointId,
      endpointKey: contentSourceEndpoints.endpointKey,
      sourceId: contentSources.sourceId,
      sourceKey: contentSources.sourceKey,
      sourceStatus: contentSources.status,
      adapterKind: contentSourceEndpoints.adapterKind,
      profileKey: contentSourceEndpoints.profileKey,
      locator: contentSourceEndpoints.locator,
      stableExternalId: contentSourceEndpoints.stableExternalId,
      identityRequirement: contentSourceEndpoints.identityRequirement,
      identityStatus: contentSourceEndpoints.identityStatus,
      endpointStatus: contentSourceEndpoints.status,
      endpointRightsPolicy: contentSourceEndpoints.rightsPolicy,
      sourceRightsPolicy: contentSources.rightsPolicy,
    })
    .from(contentSourcePartitionMembers)
    .innerJoin(
      contentSourceEndpoints,
      eq(contentSourceEndpoints.endpointId, contentSourcePartitionMembers.endpointId),
    )
    .innerJoin(contentSources, eq(contentSources.sourceId, contentSourceEndpoints.sourceId))
    .where(eq(contentSourcePartitionMembers.partitionId, partitionId))
    .orderBy(asc(contentSourcePartitionMembers.position));
  return {
    ...partition,
    members: rows.map((row) => ({
      endpointId: row.endpointId,
      endpointKey: row.endpointKey,
      sourceId: row.sourceId,
      sourceKey: row.sourceKey,
      sourceStatus: row.sourceStatus,
      adapterKind: row.adapterKind,
      profileKey: row.profileKey,
      locator: asRecord(row.locator) as Record<string, string>,
      stableExternalId: row.stableExternalId,
      identityRequirement: row.identityRequirement,
      identityStatus: row.identityStatus,
      endpointStatus: row.endpointStatus,
      rightsPolicy: {
        source: asRecord(row.sourceRightsPolicy),
        endpoint: asRecord(row.endpointRightsPolicy),
      },
    })),
  };
}

function requestWindow(input: {
  adapterKind: string;
  scheduleRole?: 'PRIMARY' | 'BACKSTOP';
  scheduleKey?: string;
  scheduleDueAt?: Date;
  dbNow: Date;
  checkpoint: JsonRecord;
  bootstrapCutoffAt: Date;
  bootstrapEnabled: boolean;
  lookbackMinutes: number;
}): { windowStart: Date; windowEnd: Date } {
  if (input.adapterKind === 'X_ACCOUNT' || input.adapterKind === 'X_SEMANTIC') {
    const windowEnd =
      input.scheduleRole === 'BACKSTOP' && input.scheduleKey && input.scheduleDueAt
        ? backstopSlotEndForDueAt({
            now: input.dbNow,
            scheduleKey: input.scheduleKey,
            dueAt: input.scheduleDueAt,
          })
        : input.scheduleRole === 'BACKSTOP'
          ? latestBackstopSlotEndAt(input.dbNow)
          : new Date(input.dbNow.getTime() - 60_000);
    const checkpointEnd = dateValue(asString(input.checkpoint.windowEnd));
    const defaultStart = new Date(
      windowEnd.getTime() -
        input.lookbackMinutes * 60_000 -
        (input.scheduleRole === 'BACKSTOP' ? 120_000 : 0),
    );
    const overlapped = checkpointEnd
      ? new Date(Math.min(checkpointEnd.getTime() - 120_000, windowEnd.getTime()))
      : defaultStart;
    // Once a checkpoint exists, preserve it even when execution has been
    // delayed beyond the nominal daily cadence. Bounding a checkpoint-based
    // window would silently skip the uncovered interval; saturation handling
    // and Receipt ID deduplication keep an extended recovery window safe.
    const boundedStart = checkpointEnd ? overlapped : defaultStart;
    if (input.adapterKind === 'X_SEMANTIC') {
      boundedStart.setUTCHours(0, 0, 0, 0);
    }
    return {
      windowStart: boundedStart,
      windowEnd,
    };
  }
  const windowEnd = input.dbNow;
  const checkpointAt = dateValue(asString(input.checkpoint.checkedAt));
  const windowStart = input.bootstrapEnabled
    ? new Date(input.bootstrapCutoffAt.getTime() - input.lookbackMinutes * 60_000)
    : (checkpointAt ?? new Date(windowEnd.getTime() - input.lookbackMinutes * 60_000));
  return { windowStart, windowEnd };
}

async function nextAttemptNumber(
  tx: TransactionHandle,
  jobKind: string,
  requestHash: string,
): Promise<number> {
  const rows = await tx
    .select({ maximum: max(contentAcquisitionRuns.attemptNo) })
    .from(contentAcquisitionRuns)
    .where(
      and(
        eq(contentAcquisitionRuns.jobKind, jobKind),
        eq(contentAcquisitionRuns.requestHash, requestHash),
      ),
    );
  return Number(rows[0]?.maximum ?? 0) + 1;
}

async function outstandingXRunCount(tx: TransactionHandle, dbNow: Date): Promise<number> {
  const rows = await tx.execute<{ outstanding: string | number }>(sql`
    SELECT count(*)::integer AS outstanding
    FROM content.acquisition_runs
    WHERE adapter_kind IN ('X_ACCOUNT', 'X_SEMANTIC')
      AND status IN ('PENDING', 'RUNNING')
      AND (lease_expires_at IS NULL OR lease_expires_at > ${dbNow.toISOString()}::timestamptz)
  `);
  const outstanding = Number(rows[0]?.outstanding ?? 0);
  if (!Number.isSafeInteger(outstanding) || outstanding < 0) {
    throw new Error('Outstanding X acquisition run count is invalid');
  }
  return outstanding;
}

export async function claimDueXIdentityRuns(input: {
  claimLimit: number;
  budgetPolicy: XBudgetPolicy;
  db?: DbHandle;
}): Promise<readonly ClaimedFormalRun[]> {
  if (!Number.isSafeInteger(input.claimLimit) || input.claimLimit < 1 || input.claimLimit > 100) {
    throw new Error('X identity claimLimit must be an integer from 1 to 100');
  }
  const db = input.db ?? (await getDb());
  return db.transaction(async (tx) => {
    const clockRows = await tx.execute<{
      dbNow: Date | string;
      nextDeadline: Date | string | null;
    }>(
      sql`SELECT now() AS "dbNow", (SELECT min(deadline_time) FROM fpl.events WHERE deadline_time > now()) AS "nextDeadline"`,
    );
    const dbNow = dateValue(clockRows[0]?.dbNow);
    if (!dbNow) throw new Error('Database clock is invalid');
    // Serialize X admission across scheduler instances. The same lock is
    // used by recurring scans, so queued PENDING work is counted before
    // another identity run can be claimed.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('briefing-x-capacity-v1'))`);
    const phase = resolveFormalAcquisitionPhase({
      now: dbNow,
      nextDeadline: dateValue(clockRows[0]?.nextDeadline),
    });
    const staleIdentityRuns = await tx
      .select({ runId: contentAcquisitionRuns.runId })
      .from(contentAcquisitionRuns)
      .where(
        and(
          eq(contentAcquisitionRuns.jobKind, 'X_IDENTITY'),
          inArray(contentAcquisitionRuns.status, ['PENDING', 'RUNNING']),
          lte(contentAcquisitionRuns.leaseExpiresAt, dbNow),
        ),
      )
      .orderBy(asc(contentAcquisitionRuns.leaseExpiresAt), asc(contentAcquisitionRuns.runId))
      .limit(input.claimLimit)
      .for('update', { skipLocked: true });
    for (const stale of staleIdentityRuns) {
      await tx
        .update(contentAcquisitionRuns)
        .set({
          status: 'FAILED',
          failureClass: 'LEASE_EXPIRED',
          failureDetailsHash: sha256CanonicalJson({
            failureClass: 'LEASE_EXPIRED',
            recoveryOwner: 'X_IDENTITY_SCHEDULER',
          }),
          errorSummary: 'X identity acquisition lease expired before terminal commit',
          completedAt: dbNow,
          leaseExpiresAt: null,
          checkpointAdvanced: false,
          runMetrics: sql`${contentAcquisitionRuns.runMetrics} || ${JSON.stringify({
            recoveredAfterLeaseExpiryAt: dbNow.toISOString(),
            recoveryOwner: 'X_IDENTITY_SCHEDULER',
          })}::jsonb`,
        })
        .where(
          and(
            eq(contentAcquisitionRuns.runId, stale.runId),
            inArray(contentAcquisitionRuns.status, ['PENDING', 'RUNNING']),
          ),
        );
      await releaseXRunBudgets({ tx, runId: stale.runId, dbNow });
    }
    const availableClaimLimit = Math.max(
      0,
      input.claimLimit - (await outstandingXRunCount(tx, dbNow)),
    );
    if (availableClaimLimit === 0) return [];
    const dueEndpoints = await tx
      .select({ endpointId: contentSourceEndpoints.endpointId })
      .from(contentSourceEndpoints)
      .innerJoin(contentSources, eq(contentSources.sourceId, contentSourceEndpoints.sourceId))
      .where(
        and(
          eq(contentSourceEndpoints.adapterKind, 'X_ACCOUNT'),
          eq(contentSourceEndpoints.identityRequirement, 'REQUIRED'),
          eq(contentSourceEndpoints.status, 'active'),
          eq(contentSources.status, 'active'),
          or(
            and(
              inArray(contentSourceEndpoints.identityStatus, ['PENDING', 'FAILED']),
              or(
                isNull(contentSourceEndpoints.identityNextCheckAt),
                lte(contentSourceEndpoints.identityNextCheckAt, dbNow),
              ),
            ),
            and(
              eq(contentSourceEndpoints.identityStatus, 'VERIFIED'),
              lte(contentSourceEndpoints.identityNextCheckAt, dbNow),
            ),
          ),
          sql`NOT EXISTS (
            SELECT 1
            FROM content.acquisition_runs AS active_identity
            WHERE active_identity.endpoint_id = ${contentSourceEndpoints.endpointId}
              AND active_identity.job_kind = 'X_IDENTITY'
              AND active_identity.status IN ('PENDING', 'RUNNING')
          )`,
        ),
      )
      .orderBy(
        asc(contentSourceEndpoints.identityNextCheckAt),
        asc(contentSourceEndpoints.endpointId),
      )
      .limit(availableClaimLimit)
      .for('update', { skipLocked: true });

    const claimed: ClaimedFormalRun[] = [];
    for (const due of dueEndpoints) {
      const endpoint = await endpointSnapshot(tx, due.endpointId);
      if (
        !endpoint ||
        endpoint.adapterKind !== 'X_ACCOUNT' ||
        endpoint.endpointStatus !== 'active' ||
        endpoint.sourceStatus !== 'active'
      ) {
        continue;
      }
      const profile = getAcquisitionProfile(endpoint.profileKey);
      const handle = endpoint.locator.handle;
      if (!profile || profile.adapterKind !== 'X_ACCOUNT' || !handle) continue;
      const persistedEndpoint = {
        endpointId: endpoint.endpointId,
        endpointKey: endpoint.endpointKey,
        sourceId: endpoint.sourceId,
        sourceKey: endpoint.sourceKey,
        adapterKind: endpoint.adapterKind,
        profileKey: endpoint.profileKey,
        locator: endpoint.locator,
        stableExternalId: endpoint.stableExternalId,
        identityRequirement: endpoint.identityRequirement,
        rightsPolicy: endpoint.rightsPolicy,
      };
      const request = parseFormalRunRequestV1({
        schemaVersion: 1,
        jobKind: 'X_IDENTITY',
        adapterKind: 'X_ACCOUNT',
        phase,
        profileKey: endpoint.profileKey,
        profileRevision: profile.revision,
        windowStart: dbNow.toISOString(),
        windowEnd: dbNow.toISOString(),
        endpoint: persistedEndpoint,
        toolRequest: compileXUserRequest(handle),
      });
      const requestHash = sha256CanonicalJson(request);
      const attemptNo = await nextAttemptNumber(tx, request.jobKind, requestHash);
      const runId = randomUUID();
      const leaseExpiresAt = new Date(dbNow.getTime() + 6 * 60_000);
      await tx.insert(contentAcquisitionRuns).values({
        runId,
        endpointId: endpoint.endpointId,
        jobKind: request.jobKind,
        adapterKind: request.adapterKind,
        profileKey: request.profileKey,
        profileRevision: request.profileRevision,
        windowStart: dbNow,
        windowEnd: dbNow,
        idempotencyKey: `briefing-identity:${endpoint.endpointId}:${requestHash}:${attemptNo}`,
        status: 'PENDING',
        requestSnapshot: request,
        requestHash,
        sourceSnapshot: [
          {
            sourceId: endpoint.sourceId,
            sourceKey: endpoint.sourceKey,
            rightsPolicy: endpoint.rightsPolicy,
          },
        ],
        endpointSnapshot: persistedEndpoint,
        sourceSnapshotRevision: endpoint.endpointId,
        attemptNo,
        leaseExpiresAt,
        evidenceMode: 'GROK_ATTESTED_FINAL',
      });
      const budget = await reserveXRunBudgets({
        tx,
        runId,
        phase,
        lane: 'IDENTITY',
        dbNow,
        policy: input.budgetPolicy,
      });
      if (!budget.reserved) {
        await tx
          .update(contentAcquisitionRuns)
          .set({
            status: 'BUDGET_DEFERRED',
            completedAt: dbNow,
            leaseExpiresAt: null,
            checkpointAdvanced: false,
            runMetrics: {
              deferredScope: budget.deferredScope,
              remainingBeforeReservation: budget.remainingBeforeReservation,
            },
          })
          .where(eq(contentAcquisitionRuns.runId, runId));
        await tx
          .update(contentSourceEndpoints)
          .set({
            identityNextCheckAt: new Date(dbNow.getTime() + 30 * 60_000),
            updatedAt: dbNow,
          })
          .where(eq(contentSourceEndpoints.endpointId, endpoint.endpointId));
        continue;
      }
      const job = acquisitionJobV1Schema.parse({ schemaVersion: 1, runId });
      claimed.push({
        runId,
        scheduleId: null,
        scheduleKey: `identity:${endpoint.endpointKey}`,
        jobKind: request.jobKind,
        queueKind: 'X',
        jobId: formalAcquisitionJobId({
          targetId: endpoint.endpointId,
          jobKind: request.jobKind,
          windowEnd: dbNow,
          profileRevision: request.profileRevision,
          attemptNo,
          requestHash,
        }),
        job,
        phase,
        requestHash,
        priority: 5,
      });
    }
    return claimed;
  });
}

export async function claimDueFormalRuns(input: {
  enabledAdapters: readonly RecurringAdapterKind[];
  claimLimit: number;
  xBudgetPolicy?: XBudgetPolicy;
  xAccountProvider?: 'GROK_BUILD' | 'TIKHUB';
  db?: DbHandle;
}): Promise<readonly ClaimedFormalRun[]> {
  if (!Number.isSafeInteger(input.claimLimit) || input.claimLimit < 1 || input.claimLimit > 100) {
    throw new Error('Formal acquisition claimLimit must be an integer from 1 to 100');
  }
  if (input.enabledAdapters.length === 0) return [];
  if (
    input.enabledAdapters.some((adapter) => adapter === 'X_ACCOUNT' || adapter === 'X_SEMANTIC') &&
    !input.xBudgetPolicy
  ) {
    throw new Error('Formal X claims require an explicit budget policy');
  }
  const db = input.db ?? (await getDb());
  return db.transaction(async (tx) => {
    const clockRows = await tx.execute<{
      dbNow: Date | string;
      nextDeadline: Date | string | null;
    }>(
      sql`SELECT now() AS "dbNow", (SELECT min(deadline_time) FROM fpl.events WHERE deadline_time > now()) AS "nextDeadline"`,
    );
    const dbNow = dateValue(clockRows[0]?.dbNow);
    if (!dbNow) throw new Error('Database clock is invalid');
    const nextDeadline = dateValue(clockRows[0]?.nextDeadline);
    const phase = resolveFormalAcquisitionPhase({ now: dbNow, nextDeadline });
    const isXClaim = input.enabledAdapters.some(
      (adapter) => adapter === 'X_ACCOUNT' || adapter === 'X_SEMANTIC',
    );
    let effectiveClaimLimit = input.claimLimit;
    if (isXClaim) {
      // Count PENDING as well as RUNNING: the scheduler has already handed
      // those jobs to BullMQ and they still consume the bounded X capacity.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('briefing-x-capacity-v1'))`);
      effectiveClaimLimit = Math.max(0, input.claimLimit - (await outstandingXRunCount(tx, dbNow)));
      if (effectiveClaimLimit === 0) return [];
    }

    const schedules = await tx
      .select({
        scheduleId: contentSourceSchedules.scheduleId,
        scheduleKey: contentSourceSchedules.scheduleKey,
        endpointId: contentSourceSchedules.endpointId,
        partitionId: contentSourceSchedules.partitionId,
        jobKind: contentSourceSchedules.jobKind,
        adapterKind: contentSourceSchedules.adapterKind,
        profileKey: contentSourceSchedules.profileKey,
        profileRevision: contentSourceSchedules.profileRevision,
        scheduleRole: contentSourceSchedules.scheduleRole,
        nextDueAt: contentSourceSchedules.nextDueAt,
        manifestRevision: contentSourceSchedules.manifestRevision,
        priority: contentSourceSchedules.priority,
        validator: contentSourceSchedules.validator,
        checkpoint: contentSourceSchedules.checkpoint,
        bootstrapCompletedAt: contentSourceSchedules.bootstrapCompletedAt,
        bootstrapCutoffAt: contentSourceSchedules.bootstrapCutoffAt,
        failureStreak: contentSourceSchedules.failureStreak,
        leaseOwner: contentSourceSchedules.leaseOwner,
        leaseExpiresAt: contentSourceSchedules.leaseExpiresAt,
        circuitState: contentSourceSchedules.circuitState,
      })
      .from(contentSourceSchedules)
      .where(
        and(
          eq(contentSourceSchedules.status, 'active'),
          inArray(contentSourceSchedules.adapterKind, input.enabledAdapters),
          lte(contentSourceSchedules.nextDueAt, dbNow),
          or(
            isNull(contentSourceSchedules.leaseExpiresAt),
            lte(contentSourceSchedules.leaseExpiresAt, dbNow),
          ),
          or(
            eq(contentSourceSchedules.circuitState, 'CLOSED'),
            and(
              inArray(contentSourceSchedules.circuitState, ['OPEN', 'HALF_OPEN']),
              lte(contentSourceSchedules.probeAfter, dbNow),
            ),
          ),
        ),
      )
      .orderBy(
        asc(contentSourceSchedules.priority),
        asc(contentSourceSchedules.nextDueAt),
        asc(contentSourceSchedules.scheduleId),
      )
      .limit(effectiveClaimLimit)
      .for('update', { skipLocked: true });

    const claimed: ClaimedFormalRun[] = [];
    const deferIneligibleSchedule = async (scheduleId: string): Promise<void> => {
      await tx
        .update(contentSourceSchedules)
        .set({
          nextDueAt: new Date(dbNow.getTime() + 5 * 60_000),
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: dbNow,
        })
        .where(eq(contentSourceSchedules.scheduleId, scheduleId));
    };
    for (const schedule of schedules) {
      let scheduleFailureStreak = schedule.failureStreak;
      if (schedule.leaseOwner && schedule.leaseExpiresAt && schedule.leaseExpiresAt <= dbNow) {
        scheduleFailureStreak += 1;
        const exhaustedXWindow =
          scheduleFailureStreak >= 3 &&
          (schedule.adapterKind === 'X_ACCOUNT' || schedule.adapterKind === 'X_SEMANTIC');
        const staleRuns = await tx
          .update(contentAcquisitionRuns)
          .set({
            status: exhaustedXWindow ? 'GAP' : 'FAILED',
            failureClass: 'LEASE_EXPIRED',
            errorSummary: 'Formal acquisition lease expired before terminal commit',
            completedAt: dbNow,
            leaseExpiresAt: null,
            checkpointAdvanced: exhaustedXWindow,
          })
          .where(
            and(
              eq(contentAcquisitionRuns.runId, schedule.leaseOwner),
              inArray(contentAcquisitionRuns.status, ['PENDING', 'RUNNING']),
            ),
          )
          .returning({
            runId: contentAcquisitionRuns.runId,
            endpointId: contentAcquisitionRuns.endpointId,
            partitionId: contentAcquisitionRuns.sourcePartitionId,
            windowStart: contentAcquisitionRuns.windowStart,
            windowEnd: contentAcquisitionRuns.windowEnd,
          });
        await releaseXRunBudgets({ tx, runId: schedule.leaseOwner, dbNow });
        const staleRun = staleRuns[0];
        if (exhaustedXWindow && staleRun?.windowStart && staleRun.windowEnd) {
          await tx.insert(contentAcquisitionGaps).values({
            gapId: randomUUID(),
            declaringRunId: staleRun.runId,
            endpointId: staleRun.endpointId,
            partitionId: staleRun.partitionId,
            windowStart: staleRun.windowStart,
            windowEnd: staleRun.windowEnd,
            reason: 'RETRY_EXHAUSTED_LEASE_EXPIRED',
            detailsHash: sha256CanonicalJson({
              failureClass: 'LEASE_EXPIRED',
              failureStreak: scheduleFailureStreak,
            }),
          });
        }
        await tx
          .update(contentSourceSchedules)
          .set({
            leaseOwner: null,
            leaseExpiresAt: null,
            failureStreak: scheduleFailureStreak,
            circuitState: scheduleFailureStreak >= 3 ? 'OPEN' : 'CLOSED',
            probeAfter: scheduleFailureStreak >= 3 ? new Date(dbNow.getTime() + 30 * 60_000) : null,
            nextDueAt: scheduleFailureStreak >= 3 ? new Date(dbNow.getTime() + 30 * 60_000) : dbNow,
            checkpoint:
              exhaustedXWindow && staleRun?.windowEnd
                ? {
                    ...asRecord(schedule.checkpoint),
                    checkedAt: dbNow.toISOString(),
                    windowEnd: staleRun.windowEnd.toISOString(),
                  }
                : asRecord(schedule.checkpoint),
            updatedAt: dbNow,
          })
          .where(eq(contentSourceSchedules.scheduleId, schedule.scheduleId));
        if (scheduleFailureStreak >= 3) continue;
      }
      const profile = getAcquisitionProfile(schedule.profileKey);
      if (!profile || profile.revision !== schedule.profileRevision) {
        await tx
          .update(contentSourceSchedules)
          .set({
            circuitState: 'OPEN',
            probeAfter: new Date(dbNow.getTime() + 30 * 60_000),
            leaseOwner: null,
            leaseExpiresAt: null,
            updatedAt: dbNow,
          })
          .where(eq(contentSourceSchedules.scheduleId, schedule.scheduleId));
        continue;
      }
      const bootstrapCutoffAt = schedule.bootstrapCutoffAt ?? dbNow;
      const bootstrapEnabled = schedule.bootstrapCompletedAt === null;
      const window = requestWindow({
        adapterKind: schedule.adapterKind,
        scheduleRole: schedule.scheduleRole as 'PRIMARY' | 'BACKSTOP',
        scheduleKey: schedule.scheduleKey,
        scheduleDueAt: schedule.nextDueAt,
        dbNow,
        checkpoint: asRecord(schedule.checkpoint),
        bootstrapCutoffAt,
        bootstrapEnabled,
        lookbackMinutes:
          schedule.scheduleRole === 'BACKSTOP' ? 12 * 60 : profile.bootstrap.lookbackMinutes,
      });

      let request: FormalRunRequestV1;
      let sourceSnapshot: readonly JsonRecord[];
      let endpointSnapshotValue: JsonRecord;
      if (schedule.endpointId) {
        const endpoint = await endpointSnapshot(tx, schedule.endpointId);
        if (
          !endpoint ||
          endpoint.endpointStatus !== 'active' ||
          endpoint.sourceStatus !== 'active' ||
          endpoint.adapterKind !== schedule.adapterKind ||
          endpoint.profileKey !== schedule.profileKey ||
          (endpoint.adapterKind !== 'RSS_ATOM' &&
            endpoint.adapterKind !== 'PODCAST_FEED' &&
            !xEndpointMayScan({
              adapterKind: endpoint.adapterKind,
              identityRequirement: endpoint.identityRequirement,
              identityStatus: endpoint.identityStatus,
            }))
        ) {
          await deferIneligibleSchedule(schedule.scheduleId);
          continue;
        }
        const validator = asRecord(schedule.validator);
        const persistedEndpoint = {
          endpointId: endpoint.endpointId,
          endpointKey: endpoint.endpointKey,
          sourceId: endpoint.sourceId,
          sourceKey: endpoint.sourceKey,
          adapterKind: endpoint.adapterKind,
          profileKey: endpoint.profileKey,
          locator: endpoint.locator,
          stableExternalId: endpoint.stableExternalId,
          identityRequirement: endpoint.identityRequirement,
          rightsPolicy: endpoint.rightsPolicy,
        };
        request = parseFormalRunRequestV1({
          schemaVersion: 1,
          jobKind: 'FEED_POLL',
          adapterKind: endpoint.adapterKind,
          phase,
          profileKey: schedule.profileKey,
          profileRevision: schedule.profileRevision,
          windowStart: window.windowStart.toISOString(),
          windowEnd: window.windowEnd.toISOString(),
          endpoint: persistedEndpoint,
          validator: {
            etag: asString(validator.etag),
            lastModified: asString(validator.lastModified),
          },
          bootstrap: {
            enabled: bootstrapEnabled,
            cutoffAt: bootstrapCutoffAt.toISOString(),
            ...profile.bootstrap,
          },
        });
        sourceSnapshot = [
          {
            sourceId: endpoint.sourceId,
            sourceKey: endpoint.sourceKey,
            rightsPolicy: endpoint.rightsPolicy,
          },
        ];
        endpointSnapshotValue = persistedEndpoint;
      } else if (schedule.partitionId) {
        const partition = await partitionSnapshot(tx, schedule.partitionId);
        if (
          !partition ||
          partition.status !== 'active' ||
          partition.adapterKind !== schedule.adapterKind ||
          partition.profileKey !== schedule.profileKey ||
          partition.members.length === 0 ||
          partition.members.some(
            (member) =>
              !xEndpointMayScan({
                adapterKind: member.adapterKind,
                identityRequirement: member.identityRequirement,
                identityStatus: member.identityStatus,
              }) ||
              member.endpointStatus !== 'active' ||
              member.sourceStatus !== 'active' ||
              member.adapterKind !== partition.adapterKind ||
              member.profileKey !== partition.profileKey,
          )
        ) {
          await deferIneligibleSchedule(schedule.scheduleId);
          continue;
        }
        const members = partition.members.map((member) => ({
          endpointId: member.endpointId,
          endpointKey: member.endpointKey,
          sourceId: member.sourceId,
          sourceKey: member.sourceKey,
          adapterKind: member.adapterKind,
          profileKey: member.profileKey,
          locator: member.locator,
          stableExternalId: member.stableExternalId,
          identityRequirement: member.identityRequirement,
          rightsPolicy: member.rightsPolicy,
        }));
        const firstMember = members[0]!;
        const toolRequest =
          schedule.jobKind === 'X_KEYWORD_SCAN'
            ? compileXKeywordRequest({
                handles: members.map((member) => member.locator.handle ?? ''),
                windowStart: window.windowStart,
                windowEnd: window.windowEnd,
                limit: profile.saturationThreshold ?? 10,
              })
            : compileXSemanticRequest({
                semanticProfileKey: firstMember.locator.semanticProfileKey ?? '',
                windowStart: window.windowStart,
                windowEnd: window.windowEnd,
                limit: profile.saturationThreshold ?? 10,
              });
        request = parseFormalRunRequestV1({
          schemaVersion: 1,
          jobKind: schedule.jobKind,
          adapterKind: schedule.adapterKind,
          phase,
          profileKey: schedule.profileKey,
          profileRevision: schedule.profileRevision,
          windowStart: window.windowStart.toISOString(),
          windowEnd: window.windowEnd.toISOString(),
          providerRoute:
            schedule.adapterKind === 'X_ACCOUNT' && input.xAccountProvider === 'TIKHUB'
              ? 'TIKHUB_TIMELINE'
              : 'GROK_BUILD',
          coverageMode: schedule.scheduleRole,
          partition: {
            partitionId: partition.partitionId,
            partitionKey: partition.partitionKey,
            members,
          },
          toolRequest,
        });
        sourceSnapshot = members.map((member) => ({
          sourceId: member.sourceId,
          sourceKey: member.sourceKey,
          rightsPolicy: member.rightsPolicy,
        }));
        endpointSnapshotValue = {
          partitionId: partition.partitionId,
          partitionKey: partition.partitionKey,
          members,
        };
      } else {
        await deferIneligibleSchedule(schedule.scheduleId);
        continue;
      }

      let sourceSnapshotRevision = schedule.manifestRevision;
      if (scheduleFailureStreak > 0 && scheduleFailureStreak < 3) {
        const retryRows = await tx
          .select({
            endpointId: contentAcquisitionRuns.endpointId,
            partitionId: contentAcquisitionRuns.sourcePartitionId,
            jobKind: contentAcquisitionRuns.jobKind,
            adapterKind: contentAcquisitionRuns.adapterKind,
            profileKey: contentAcquisitionRuns.profileKey,
            profileRevision: contentAcquisitionRuns.profileRevision,
            requestSnapshot: contentAcquisitionRuns.requestSnapshot,
            sourceSnapshot: contentAcquisitionRuns.sourceSnapshot,
            endpointSnapshot: contentAcquisitionRuns.endpointSnapshot,
            sourceSnapshotRevision: contentAcquisitionRuns.sourceSnapshotRevision,
          })
          .from(contentAcquisitionRuns)
          .where(
            and(
              eq(contentAcquisitionRuns.scheduleId, schedule.scheduleId),
              eq(contentAcquisitionRuns.status, 'FAILED'),
            ),
          )
          .orderBy(desc(contentAcquisitionRuns.createdAt), desc(contentAcquisitionRuns.runId))
          .limit(1);
        const retry = retryRows[0];
        if (retry) {
          if (
            retry.endpointId !== schedule.endpointId ||
            retry.partitionId !== schedule.partitionId ||
            retry.jobKind !== schedule.jobKind ||
            retry.adapterKind !== schedule.adapterKind ||
            retry.profileKey !== schedule.profileKey ||
            retry.profileRevision !== schedule.profileRevision ||
            !Array.isArray(retry.sourceSnapshot)
          ) {
            throw new Error('Retry run no longer matches its recurring schedule contract');
          }
          request = parseFormalRunRequestV1(retry.requestSnapshot);
          if ('coverageMode' in request && request.coverageMode !== schedule.scheduleRole) {
            throw new Error('Retry run coverage mode no longer matches its recurring schedule');
          }
          sourceSnapshot = retry.sourceSnapshot.map((item) => asRecord(item));
          endpointSnapshotValue = asRecord(retry.endpointSnapshot);
          sourceSnapshotRevision = retry.sourceSnapshotRevision ?? schedule.manifestRevision;
        }
      }

      const requestHash = sha256CanonicalJson(request);
      const attemptNo = await nextAttemptNumber(tx, schedule.jobKind, requestHash);
      const runId = randomUUID();
      const leaseMinutes = queueKind(schedule.adapterKind) === 'X' ? 6 : 2;
      const leaseExpiresAt = new Date(dbNow.getTime() + leaseMinutes * 60_000);
      const requestWindowStart = new Date(request.windowStart);
      const requestWindowEnd = new Date(request.windowEnd);
      await tx.insert(contentAcquisitionRuns).values({
        runId,
        endpointId: schedule.endpointId,
        sourcePartitionId: schedule.partitionId,
        scheduleId: schedule.scheduleId,
        jobKind: schedule.jobKind,
        adapterKind: schedule.adapterKind,
        profileKey: schedule.profileKey,
        profileRevision: schedule.profileRevision,
        windowStart: requestWindowStart,
        windowEnd: requestWindowEnd,
        idempotencyKey: `briefing-formal:${schedule.scheduleId}:${requestHash}:${attemptNo}`,
        status: 'PENDING',
        requestSnapshot: request,
        requestHash,
        sourceSnapshot,
        endpointSnapshot: endpointSnapshotValue,
        sourceSnapshotRevision,
        attemptNo,
        leaseExpiresAt,
        evidenceMode:
          schedule.adapterKind === 'X_ACCOUNT' || schedule.adapterKind === 'X_SEMANTIC'
            ? 'providerRoute' in request && request.providerRoute === 'TIKHUB_TIMELINE'
              ? 'PROVIDER_ATTESTED'
              : 'GROK_ATTESTED_FINAL'
            : 'HTTP_DETERMINISTIC',
      });
      if (schedule.adapterKind === 'X_ACCOUNT' || schedule.adapterKind === 'X_SEMANTIC') {
        if (
          !input.xBudgetPolicy ||
          !X_ACQUISITION_LANES.includes(profile.lane as XAcquisitionLane)
        ) {
          throw new Error('Formal X schedule has no valid lane budget');
        }
        const budget = await reserveXRunBudgets({
          tx,
          runId,
          phase: request.phase,
          lane: profile.lane as XAcquisitionLane,
          dbNow,
          policy: input.xBudgetPolicy,
        });
        if (!budget.reserved) {
          await tx
            .update(contentAcquisitionRuns)
            .set({
              status: 'BUDGET_DEFERRED',
              completedAt: dbNow,
              leaseExpiresAt: null,
              checkpointAdvanced: false,
              runMetrics: {
                deferredScope: budget.deferredScope,
                remainingBeforeReservation: budget.remainingBeforeReservation,
              },
            })
            .where(eq(contentAcquisitionRuns.runId, runId));
          await tx
            .update(contentSourceSchedules)
            .set({
              leaseOwner: null,
              leaseExpiresAt: null,
              nextDueAt: new Date(
                dbNow.getTime() + Math.min(30, profile.cadenceMinutes[request.phase]) * 60_000,
              ),
              updatedAt: dbNow,
            })
            .where(eq(contentSourceSchedules.scheduleId, schedule.scheduleId));
          continue;
        }
      }
      await tx
        .update(contentSourceSchedules)
        .set({
          leaseOwner: runId,
          leaseExpiresAt,
          bootstrapCutoffAt,
          circuitState: schedule.circuitState === 'CLOSED' ? 'CLOSED' : 'HALF_OPEN',
          updatedAt: dbNow,
        })
        .where(eq(contentSourceSchedules.scheduleId, schedule.scheduleId));
      const job = acquisitionJobV1Schema.parse({ schemaVersion: 1, runId });
      claimed.push({
        runId,
        scheduleId: schedule.scheduleId,
        scheduleKey: schedule.scheduleKey,
        jobKind: schedule.jobKind,
        queueKind: queueKind(schedule.adapterKind),
        jobId: formalAcquisitionJobId({
          targetId: schedule.scheduleId,
          jobKind: schedule.jobKind,
          windowEnd: requestWindowEnd,
          profileRevision: schedule.profileRevision,
          attemptNo,
          requestHash,
        }),
        job,
        phase: request.phase,
        requestHash,
        priority: schedule.priority,
      });
    }
    return claimed;
  });
}

export async function confirmFormalRunEnqueued(input: {
  runId: string;
  db?: DbHandle;
}): Promise<boolean> {
  const db = input.db ?? (await getDb());
  return db.transaction(async (tx) => {
    const clockRows = await tx.execute<{ dbNow: Date | string }>(sql`SELECT now() AS "dbNow"`);
    const dbNow = dateValue(clockRows[0]?.dbNow);
    if (!dbNow) throw new Error('Database clock is invalid');
    const updated = await tx
      .update(contentAcquisitionRuns)
      .set({ enqueueConfirmedAt: dbNow })
      .where(
        and(
          eq(contentAcquisitionRuns.runId, input.runId),
          inArray(contentAcquisitionRuns.status, ['PENDING', 'RUNNING']),
          isNull(contentAcquisitionRuns.enqueueConfirmedAt),
        ),
      )
      .returning({ runId: contentAcquisitionRuns.runId });
    return updated.length === 1;
  });
}

export async function failFormalRun(input: {
  runId: string;
  failureClass: string;
  errorSummary: string;
  retryDelayMs?: number;
  outputContractFailure?: boolean;
  providerEvidence?: FormalRunProviderEvidence;
  probeEvidence?: FormalRunProbeEvidence;
  supadataFailureEvidence?: SupadataFailureEvidence;
  providerProcessStarted?: boolean;
  releaseExecutionBudgetAfterProbe?: boolean;
  probeReservationIds?: readonly string[];
  probeIncrementedReservationIds?: readonly string[];
  hermesProviderAttempted?: boolean;
  hermesProviderUnits?: number;
  rejections?: readonly FormalRunFailureRejection[];
  db?: DbHandle;
}): Promise<boolean> {
  const db = input.db ?? (await getDb());
  return db.transaction(async (tx) => {
    const clockRows = await tx.execute<{ dbNow: Date | string }>(sql`SELECT now() AS "dbNow"`);
    const dbNow = dateValue(clockRows[0]?.dbNow);
    if (!dbNow) throw new Error('Database clock is invalid');
    const rows = await tx
      .select({
        runId: contentAcquisitionRuns.runId,
        scheduleId: contentAcquisitionRuns.scheduleId,
        endpointId: contentAcquisitionRuns.endpointId,
        partitionId: contentAcquisitionRuns.sourcePartitionId,
        adapterKind: contentAcquisitionRuns.adapterKind,
        windowStart: contentAcquisitionRuns.windowStart,
        windowEnd: contentAcquisitionRuns.windowEnd,
        requestSnapshot: contentAcquisitionRuns.requestSnapshot,
        requestHash: contentAcquisitionRuns.requestHash,
        status: contentAcquisitionRuns.status,
        jobKind: contentAcquisitionRuns.jobKind,
        provider: contentAcquisitionRuns.provider,
        providerJobId: contentAcquisitionRuns.providerJobId,
        providerUnits: contentAcquisitionRuns.providerUnits,
      })
      .from(contentAcquisitionRuns)
      .where(eq(contentAcquisitionRuns.runId, input.runId))
      .for('update')
      .limit(1);
    const run = rows[0];
    if (!run || !['PENDING', 'RUNNING'].includes(run.status)) return false;
    if (
      (input.providerEvidence ? 1 : 0) +
        (input.probeEvidence ? 1 : 0) +
        (input.supadataFailureEvidence ? 1 : 0) +
        (input.hermesProviderAttempted ? 1 : 0) >
      1
    ) {
      if (!input.providerEvidence || !input.probeEvidence) {
        throw new Error('Formal failure cannot contain evidence from multiple providers');
      }
    }
    if (input.probeEvidence && (input.supadataFailureEvidence || input.hermesProviderAttempted)) {
      throw new Error('X probe evidence cannot be combined with non-Grok provider evidence');
    }
    if (
      input.releaseExecutionBudgetAfterProbe &&
      (!input.probeEvidence ||
        input.providerEvidence ||
        input.providerProcessStarted ||
        input.supadataFailureEvidence ||
        input.hermesProviderAttempted ||
        !input.probeReservationIds?.length)
    ) {
      throw new Error('Probe-only budget transition requires probe evidence and no main call');
    }
    if (input.rejections?.length && !input.providerEvidence) {
      throw new Error('Rejected provider items require persisted provider evidence');
    }
    const request = parseFormalRunRequestV1(run.requestSnapshot);
    const xProviderAttempted =
      input.providerEvidence !== undefined ||
      input.probeEvidence !== undefined ||
      input.providerProcessStarted === true;
    const currentXProviderUnits =
      (input.providerEvidence?.providerUnits ?? (input.providerProcessStarted ? 1 : 0)) +
      (input.probeEvidence?.providerUnits ?? 0);
    const currentXCallCount =
      (input.providerEvidence?.providerUnits ?? 0) +
      (input.probeEvidence ? 1 : 0) +
      (!input.providerEvidence && input.providerProcessStarted ? 1 : 0);
    const priorXProviderUnits = Number(run.providerUnits ?? 0);
    if (!Number.isFinite(priorXProviderUnits) || priorXProviderUnits < 0) {
      throw new Error('Failed formal run has invalid persisted X provider units');
    }
    const xProviderUnits = priorXProviderUnits + currentXProviderUnits;
    let priorXCallCount = 0;
    let maximumProviderTraceSequence = -1;
    if (xProviderAttempted) {
      const traceRows = await tx.execute<{
        maximum: number | string | null;
        units: number | string;
      }>(sql`
        SELECT max(sequence) AS maximum,
               COALESCE(sum(provider_units) FILTER (
                 WHERE provider IN ('grok-build', 'tikhub')
               ), 0)::integer AS units
        FROM content.acquisition_provider_traces
        WHERE run_id = ${input.runId}::uuid
      `);
      maximumProviderTraceSequence = Number(traceRows[0]?.maximum ?? -1);
      priorXCallCount = Number(traceRows[0]?.units ?? 0);
      if (
        !Number.isSafeInteger(maximumProviderTraceSequence) ||
        !Number.isSafeInteger(priorXCallCount) ||
        priorXCallCount < 0
      ) {
        throw new Error('Failed formal run has invalid persisted provider trace state');
      }
    }
    if (input.probeEvidence) {
      if (
        !/^[0-9a-f]{64}$/.test(input.probeEvidence.requestMetadataHash) ||
        (input.probeEvidence.responseMetadataHash !== null &&
          !/^[0-9a-f]{64}$/.test(input.probeEvidence.responseMetadataHash)) ||
        (input.probeEvidence.providerJobIdHash !== null &&
          !/^[0-9a-f]{64}$/.test(input.probeEvidence.providerJobIdHash)) ||
        !input.probeEvidence.terminalState.trim()
      ) {
        throw new Error('Failed formal run has invalid X probe evidence');
      }
    }
    let supadataTotalProviderUnits: number | null = null;
    if (input.providerEvidence || input.probeEvidence) {
      if (run.adapterKind !== 'X_ACCOUNT' && run.adapterKind !== 'X_SEMANTIC') {
        throw new Error('X provider evidence is only valid for formal X runs');
      }
      if (input.providerEvidence) {
        const providerMatchesRequest =
          input.providerEvidence.provider === 'grok-build'
            ? 'toolRequest' in request &&
              (!('providerRoute' in request) || request.providerRoute === 'GROK_BUILD') &&
              request.toolRequest.toolName === input.providerEvidence.operation
            : 'providerRoute' in request &&
              request.providerRoute === 'TIKHUB_TIMELINE' &&
              request.jobKind === 'X_KEYWORD_SCAN' &&
              input.providerEvidence.operation === 'fetch_user_post_tweet';
        if (
          !providerMatchesRequest ||
          !/^[0-9a-f]{64}$/.test(input.providerEvidence.requestMetadataHash) ||
          (input.providerEvidence.responseMetadataHash !== null &&
            !/^[0-9a-f]{64}$/.test(input.providerEvidence.responseMetadataHash)) ||
          (input.providerEvidence.providerJobIdHash !== null &&
            !/^[0-9a-f]{64}$/.test(input.providerEvidence.providerJobIdHash)) ||
          !Number.isSafeInteger(input.providerEvidence.providerUnits) ||
          input.providerEvidence.providerUnits < 1 ||
          !input.providerEvidence.terminalState.trim()
        ) {
          throw new Error('Failed formal run has invalid provider evidence');
        }
        if (input.probeEvidence && input.providerEvidence.provider !== 'grok-build') {
          throw new Error('Host Grok probe cannot be combined with another X provider');
        }
      }
      const committedReservations = input.releaseExecutionBudgetAfterProbe
        ? await commitProbeAndReleaseXRunBudgets({
            tx,
            runId: input.runId,
            dbNow,
            probeReservationIds: input.probeReservationIds!,
            probeIncrementedReservationIds: input.probeIncrementedReservationIds,
          })
        : await commitRunBudgets({ tx, runId: input.runId, dbNow });
      if (
        !committedReservations &&
        !(input.probeEvidence && priorXProviderUnits >= input.probeEvidence.providerUnits)
      ) {
        throw new Error('Billed formal X failure has no reserved budget');
      }
      await tx.insert(contentAcquisitionProviderTraces).values([
        ...(input.probeEvidence
          ? [
              {
                traceId: randomUUID(),
                runId: input.runId,
                sequence: maximumProviderTraceSequence + 1,
                provider: input.probeEvidence.provider,
                operation: input.probeEvidence.operation,
                requestMetadataHash: input.probeEvidence.requestMetadataHash,
                responseMetadataHash: input.probeEvidence.responseMetadataHash,
                providerJobIdHash: input.probeEvidence.providerJobIdHash,
                providerUnits: String(input.probeEvidence.providerUnits),
                terminalState: input.probeEvidence.terminalState,
              },
            ]
          : []),
        ...(input.providerEvidence
          ? [
              {
                traceId: randomUUID(),
                runId: input.runId,
                sequence: maximumProviderTraceSequence + 1 + (input.probeEvidence ? 1 : 0),
                provider: input.providerEvidence.provider,
                operation: input.providerEvidence.operation,
                requestMetadataHash: input.providerEvidence.requestMetadataHash,
                responseMetadataHash: input.providerEvidence.responseMetadataHash,
                providerJobIdHash: input.providerEvidence.providerJobIdHash,
                providerUnits: String(input.providerEvidence.providerUnits),
                terminalState: input.providerEvidence.terminalState,
              },
            ]
          : []),
      ]);
    } else if (input.supadataFailureEvidence) {
      const evidence = input.supadataFailureEvidence;
      const expectedOperation = run.providerJobId ? 'transcript.poll' : 'transcript.submit';
      const expectedProviderJobIdHash = run.providerJobId
        ? createHash('sha256').update(run.providerJobId, 'utf8').digest('hex')
        : null;
      const submittedProviderJobIdHash = evidence.providerJobId
        ? createHash('sha256').update(evidence.providerJobId, 'utf8').digest('hex')
        : null;
      if (
        run.jobKind !== 'YOUTUBE_TRANSCRIPT' ||
        run.adapterKind !== 'SUPADATA_TRANSCRIPT' ||
        (run.provider && run.provider !== 'supadata') ||
        evidence.provider !== 'supadata' ||
        evidence.operation !== expectedOperation ||
        (run.providerJobId
          ? evidence.providerJobId !== run.providerJobId ||
            evidence.providerJobIdHash !== expectedProviderJobIdHash
          : evidence.providerJobIdHash !== submittedProviderJobIdHash) ||
        (evidence.providerJobId !== null &&
          (!evidence.providerJobId.trim() || evidence.providerJobId.length > 512)) ||
        !/^[0-9a-f]{64}$/.test(evidence.requestMetadataHash) ||
        !/^[0-9a-f]{64}$/.test(evidence.responseMetadataHash) ||
        !Number.isSafeInteger(evidence.providerUnits) ||
        evidence.providerUnits < 1 ||
        !Number.isSafeInteger(evidence.durationMs) ||
        evidence.durationMs < 0
      ) {
        throw new Error('Failed Supadata run has invalid billable provider evidence');
      }
      const existingProviderUnits = Number(run.providerUnits ?? 0);
      if (!Number.isFinite(existingProviderUnits) || existingProviderUnits < 0) {
        throw new Error('Failed Supadata run has invalid persisted provider units');
      }
      supadataTotalProviderUnits = existingProviderUnits + evidence.providerUnits;
      const reconciled = await reconcileReservedProviderBudget({
        tx,
        runId: input.runId,
        scopeKey: 'SUPADATA_TRANSCRIPT',
        unitKind: 'CREDIT',
        actualUnits: supadataTotalProviderUnits,
        dbNow,
      });
      if (!reconciled) throw new Error('Billed Supadata failure has no reserved credit budget');
      await commitRunBudgets({ tx, runId: input.runId, dbNow });
      const traceRows = await tx
        .select({ maximum: max(contentAcquisitionProviderTraces.sequence) })
        .from(contentAcquisitionProviderTraces)
        .where(eq(contentAcquisitionProviderTraces.runId, input.runId));
      await tx.insert(contentAcquisitionProviderTraces).values({
        traceId: randomUUID(),
        runId: input.runId,
        sequence: Number(traceRows[0]?.maximum ?? -1) + 1,
        provider: evidence.provider,
        operation: evidence.operation,
        requestMetadataHash: evidence.requestMetadataHash,
        responseMetadataHash: evidence.responseMetadataHash,
        providerJobIdHash: evidence.providerJobIdHash,
        providerUnits: String(evidence.providerUnits),
        terminalState: `FAILED:${input.failureClass}`.slice(0, 200),
      });
    } else if (input.hermesProviderAttempted) {
      if (run.jobKind !== 'PODCAST_TRANSCRIPT' || run.adapterKind !== 'HERMES_TRANSCRIPT') {
        throw new Error('Hermes provider evidence is only valid for podcast transcript runs');
      }
      if (
        input.hermesProviderUnits !== undefined &&
        (!Number.isSafeInteger(input.hermesProviderUnits) || input.hermesProviderUnits < 1)
      ) {
        throw new Error('Hermes provider units are invalid');
      }
      const committedReservations = await commitRunBudgets({ tx, runId: input.runId, dbNow });
      if (committedReservations === 0) {
        throw new Error('Billed Hermes failure has no reserved budget');
      }
    } else if (input.providerProcessStarted) {
      const committedReservations = await commitRunBudgets({ tx, runId: input.runId, dbNow });
      if (committedReservations === 0) {
        throw new Error('Started formal X provider process has no reserved budget');
      }
    } else {
      await releaseXRunBudgets({ tx, runId: input.runId, dbNow });
    }
    if (input.rejections?.length) {
      const immutableEndpoints =
        'endpoint' in request ? [request.endpoint] : request.partition.members;
      const immutableEndpointByKey = new Map(
        immutableEndpoints.map((endpoint) => [endpoint.endpointKey, endpoint]),
      );
      const rejectionKeys = [
        ...new Set(input.rejections.map((rejection) => rejection.endpointKey)),
      ];
      const endpointRows = await tx
        .select({
          endpointId: contentSourceEndpoints.endpointId,
          endpointKey: contentSourceEndpoints.endpointKey,
          sourceId: contentSourceEndpoints.sourceId,
        })
        .from(contentSourceEndpoints)
        .where(inArray(contentSourceEndpoints.endpointKey, rejectionKeys));
      const endpointByKey = new Map(
        endpointRows.map((endpoint) => [endpoint.endpointKey, endpoint]),
      );
      if (endpointRows.length !== rejectionKeys.length) {
        throw new Error('Failed formal run rejection references an unknown endpoint');
      }
      const uniqueItems = new Set<string>();
      for (const rejection of input.rejections) {
        const endpoint = endpointByKey.get(rejection.endpointKey);
        const immutableEndpoint = immutableEndpointByKey.get(rejection.endpointKey);
        if (
          !endpoint ||
          !immutableEndpoint ||
          endpoint.endpointId !== immutableEndpoint.endpointId ||
          endpoint.sourceId !== immutableEndpoint.sourceId
        ) {
          throw new Error('Failed formal run rejection escaped its immutable request snapshot');
        }
        if (!rejection.externalItemId.trim() || !rejection.reasonCode.trim()) {
          throw new Error('Failed formal run rejection is incomplete');
        }
        const uniqueItem = `${endpoint.endpointId}\u001f${rejection.externalItemId}`;
        if (uniqueItems.has(uniqueItem)) {
          throw new Error('Failed formal run contains duplicate rejection observations');
        }
        uniqueItems.add(uniqueItem);
        await tx.insert(contentSourceObservations).values({
          observationId: randomUUID(),
          runId: input.runId,
          endpointId: endpoint.endpointId,
          externalItemId: rejection.externalItemId,
          receiptId: null,
          receiptRevisionId: null,
          outcome: 'REJECTED',
          nativeItemHash: rejection.nativeItemHash ?? null,
          reasonCode: rejection.reasonCode,
          observedAt: dbNow,
        });
      }
    }
    let failureStreak = 0;
    let scheduleCheckpoint: JsonRecord = {};
    if (run.scheduleId) {
      const scheduleRows = await tx
        .select({
          failureStreak: contentSourceSchedules.failureStreak,
          checkpoint: contentSourceSchedules.checkpoint,
        })
        .from(contentSourceSchedules)
        .where(eq(contentSourceSchedules.scheduleId, run.scheduleId))
        .for('update')
        .limit(1);
      const schedule = scheduleRows[0];
      if (!schedule) throw new Error('Recurring acquisition schedule disappeared during failure');
      failureStreak = schedule.failureStreak + 1;
      scheduleCheckpoint = asRecord(schedule.checkpoint);
    }
    const currentContractRevision =
      input.providerEvidence &&
      typeof input.providerEvidence.runMetrics.outputContractRevision === 'number'
        ? String(input.providerEvidence.runMetrics.outputContractRevision)
        : null;
    const priorContractFailureRows =
      input.outputContractFailure === true && run.scheduleId && run.requestHash
        ? await tx
            .select({ runId: contentAcquisitionRuns.runId })
            .from(contentAcquisitionRuns)
            .where(
              and(
                eq(contentAcquisitionRuns.scheduleId, run.scheduleId),
                eq(contentAcquisitionRuns.status, 'FAILED'),
                eq(contentAcquisitionRuns.requestHash, run.requestHash),
                sql`${contentAcquisitionRuns.runMetrics} ->> 'outputContractFailure' = 'true'`,
                ...(currentContractRevision
                  ? [
                      sql`${contentAcquisitionRuns.runMetrics} ->> 'outputContractRevision' = ${currentContractRevision}`,
                    ]
                  : []),
              ),
            )
            .limit(1)
        : [];
    const outputContractBlocked =
      input.outputContractFailure === true && priorContractFailureRows.length > 0;
    const exhaustedXWindow =
      run.scheduleId !== null &&
      failureStreak >= 3 &&
      !outputContractBlocked &&
      (run.adapterKind === 'X_ACCOUNT' || run.adapterKind === 'X_SEMANTIC');
    if (exhaustedXWindow && (!run.windowStart || !run.windowEnd)) {
      throw new Error('Exhausted X retry has no immutable acquisition window');
    }
    const failureClass = input.failureClass.slice(0, 200);
    const errorSummary = input.errorSummary.replace(/\s+/g, ' ').trim().slice(0, 1_000);
    await tx
      .update(contentAcquisitionRuns)
      .set({
        status: exhaustedXWindow ? 'GAP' : 'FAILED',
        failureClass,
        failureDetailsHash: sha256CanonicalJson({ failureClass, errorSummary }),
        errorSummary,
        rejectedCount: input.rejections?.length ?? 0,
        provider: input.supadataFailureEvidence
          ? 'supadata'
          : input.hermesProviderAttempted
            ? 'hermes'
            : (input.providerEvidence?.provider ??
              (input.probeEvidence
                ? 'grok-build'
                : xProviderAttempted
                  ? 'providerRoute' in request && request.providerRoute === 'TIKHUB_TIMELINE'
                    ? 'tikhub'
                    : 'grok-build'
                  : undefined)),
        providerJobId: input.supadataFailureEvidence?.providerJobId ?? undefined,
        providerUnits:
          supadataTotalProviderUnits === null
            ? input.hermesProviderUnits !== undefined
              ? String(input.hermesProviderUnits)
              : xProviderAttempted
                ? String(xProviderUnits || 1)
                : undefined
            : String(supadataTotalProviderUnits),
        xCallCount: xProviderAttempted ? priorXCallCount + currentXCallCount : priorXCallCount,
        traceVerified: input.providerEvidence !== undefined,
        runMetrics: sql`${contentAcquisitionRuns.runMetrics} || ${JSON.stringify(
          input.supadataFailureEvidence
            ? {
                billableProviderFailure: true,
                providerFailureOperation: input.supadataFailureEvidence.operation,
                providerFailureDurationMs: input.supadataFailureEvidence.durationMs,
              }
            : {
                ...(input.providerEvidence?.runMetrics ??
                  input.probeEvidence?.runMetrics ??
                  (input.hermesProviderAttempted
                    ? { hermesProviderStarted: true, providerTraceVerified: false }
                    : input.providerProcessStarted
                      ? { providerProcessStarted: true, providerTraceVerified: false }
                      : {})),
                ...(input.outputContractFailure ? { outputContractFailure: true } : {}),
              },
        )}::jsonb`,
        completedAt: dbNow,
        leaseExpiresAt: null,
        checkpointAdvanced: exhaustedXWindow,
      })
      .where(eq(contentAcquisitionRuns.runId, input.runId));
    if (exhaustedXWindow) {
      await tx.insert(contentAcquisitionGaps).values({
        gapId: randomUUID(),
        declaringRunId: input.runId,
        endpointId: run.endpointId,
        partitionId: run.partitionId,
        windowStart: run.windowStart!,
        windowEnd: run.windowEnd!,
        reason: 'RETRY_EXHAUSTED',
        detailsHash: sha256CanonicalJson({ failureClass, failureStreak }),
      });
    }
    if (run.scheduleId) {
      const circuitOpen = outputContractBlocked || failureStreak >= 3;
      const retryDelayMs = circuitOpen
        ? 30 * 60_000
        : (input.retryDelayMs ?? (failureStreak === 1 ? 60_000 : 5 * 60_000));
      await tx
        .update(contentSourceSchedules)
        .set({
          leaseOwner: null,
          leaseExpiresAt: null,
          failureStreak,
          circuitState: circuitOpen ? 'OPEN' : 'CLOSED',
          // Output-contract failures require a new deployed contract before
          // another billable call.  A null probe_after keeps the schedule
          // blocked until the revision-aware rearm operation runs.
          probeAfter:
            circuitOpen && !outputContractBlocked ? new Date(dbNow.getTime() + 30 * 60_000) : null,
          nextDueAt: new Date(dbNow.getTime() + retryDelayMs),
          checkpoint: exhaustedXWindow
            ? {
                ...scheduleCheckpoint,
                checkedAt: dbNow.toISOString(),
                windowEnd: run.windowEnd!.toISOString(),
              }
            : scheduleCheckpoint,
          updatedAt: dbNow,
        })
        .where(eq(contentSourceSchedules.scheduleId, run.scheduleId));
    }
    return true;
  });
}

export async function deferFormalRunForBudget(input: {
  runId: string;
  metrics: Readonly<Record<string, unknown>>;
  db?: DbHandle;
}): Promise<boolean> {
  const db = input.db ?? (await getDb());
  return db.transaction(async (tx) => {
    const clockRows = await tx.execute<{ dbNow: Date | string }>(sql`SELECT now() AS "dbNow"`);
    const dbNow = dateValue(clockRows[0]?.dbNow);
    if (!dbNow) throw new Error('Database clock is invalid');
    const rows = await tx
      .select({
        status: contentAcquisitionRuns.status,
        scheduleId: contentAcquisitionRuns.scheduleId,
      })
      .from(contentAcquisitionRuns)
      .where(eq(contentAcquisitionRuns.runId, input.runId))
      .for('update')
      .limit(1);
    const run = rows[0];
    if (!run || !['PENDING', 'RUNNING'].includes(run.status)) return false;
    if (run.scheduleId) throw new Error('Triggered content budget deferral cannot own a schedule');
    await releaseXRunBudgets({ tx, runId: input.runId, dbNow });
    const suppliedNextEligibleAt = input.metrics.nextEligibleAt;
    const nextEligibleAt =
      typeof suppliedNextEligibleAt === 'string' &&
      Number.isFinite(Date.parse(suppliedNextEligibleAt))
        ? suppliedNextEligibleAt
        : new Date(dbNow.getTime() + 24 * 60 * 60_000).toISOString();
    const updated = await tx
      .update(contentAcquisitionRuns)
      .set({
        status: 'BUDGET_DEFERRED',
        runMetrics: { ...input.metrics, nextEligibleAt },
        completedAt: dbNow,
        leaseExpiresAt: null,
        checkpointAdvanced: false,
      })
      .where(
        and(
          eq(contentAcquisitionRuns.runId, input.runId),
          inArray(contentAcquisitionRuns.status, ['PENDING', 'RUNNING']),
        ),
      )
      .returning({ runId: contentAcquisitionRuns.runId });
    return updated.length === 1;
  });
}

/**
 * Prepare BullMQ jobs while every content queue is paused and the content
 * worker is stopped. The enqueue confirmation marker may be absent for a
 * direct scheduler hand-off whose database audit update failed after queue.add
 * succeeded, so queue membership is established by the caller before this
 * function is invoked. A queued triggered run has no recurring schedule, so it
 * stays PENDING and only loses its short execution lease. A scheduled run is
 * deferred and its schedule lease is released together; otherwise a restarted
 * scheduler could reclaim the schedule and mark the still-queued run
 * LEASE_EXPIRED before the original job is allowed to start.
 */
export async function prepareQueuedFormalRunsForDeployment(input: {
  db?: DbHandle;
  queuedRunIds: ReadonlySet<string>;
}): Promise<number> {
  const queuedRunIds = [...new Set(input.queuedRunIds)];
  if (queuedRunIds.length === 0) return 0;
  const db = input.db ?? (await getDb());
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
    const clockRows = await tx.execute<{ dbNow: Date | string }>(sql`SELECT now() AS "dbNow"`);
    const dbNow = dateValue(clockRows[0]?.dbNow);
    if (!dbNow) throw new Error('Database clock is invalid');
    const rows = await tx
      .select({
        runId: contentAcquisitionRuns.runId,
        scheduleId: contentAcquisitionRuns.scheduleId,
      })
      .from(contentAcquisitionRuns)
      .where(
        and(
          eq(contentAcquisitionRuns.status, 'PENDING'),
          isNotNull(contentAcquisitionRuns.leaseExpiresAt),
          inArray(contentAcquisitionRuns.runId, queuedRunIds),
        ),
      )
      .for('update');
    const deploymentDeferralMetrics = { deferredReason: 'DEPLOYMENT_QUEUE_QUIESCENCE' };
    const deploymentDeferralHash = sha256CanonicalJson(deploymentDeferralMetrics);
    let prepared = 0;

    for (const run of rows) {
      if (run.scheduleId) {
        const schedule = await tx
          .update(contentSourceSchedules)
          .set({
            leaseOwner: null,
            leaseExpiresAt: null,
            nextDueAt: new Date(dbNow.getTime() + 60_000),
            updatedAt: dbNow,
          })
          .where(
            and(
              eq(contentSourceSchedules.scheduleId, run.scheduleId),
              eq(contentSourceSchedules.leaseOwner, run.runId),
            ),
          )
          .returning({ scheduleId: contentSourceSchedules.scheduleId });
        if (schedule.length !== 1) {
          throw new Error(`Formal acquisition schedule lease is not owned by run: ${run.runId}`);
        }
        await releaseXRunBudgets({ tx, runId: run.runId, dbNow });
        const deferred = await tx
          .update(contentAcquisitionRuns)
          .set({
            status: 'BUDGET_DEFERRED',
            failureClass: 'QUEUE_ADMISSION_CLOSED',
            failureDetailsHash: deploymentDeferralHash,
            errorSummary:
              'Formal acquisition deferred while content queues were paused for deployment',
            runMetrics: sql`${contentAcquisitionRuns.runMetrics} || ${JSON.stringify(deploymentDeferralMetrics)}::jsonb`,
            completedAt: dbNow,
            leaseExpiresAt: null,
            checkpointAdvanced: false,
          })
          .where(
            and(
              eq(contentAcquisitionRuns.runId, run.runId),
              eq(contentAcquisitionRuns.status, 'PENDING'),
            ),
          )
          .returning({ runId: contentAcquisitionRuns.runId });
        if (deferred.length !== 1)
          throw new Error(`Formal acquisition deferral was lost: ${run.runId}`);
      } else {
        const released = await tx
          .update(contentAcquisitionRuns)
          .set({ leaseExpiresAt: null })
          .where(
            and(
              eq(contentAcquisitionRuns.runId, run.runId),
              eq(contentAcquisitionRuns.status, 'PENDING'),
            ),
          )
          .returning({ runId: contentAcquisitionRuns.runId });
        if (released.length !== 1)
          throw new Error(`Formal acquisition lease release was lost: ${run.runId}`);
      }
      prepared += 1;
    }
    return prepared;
  });
}

export async function deferFormalRunForCapacity(input: {
  runId: string;
  metrics: Readonly<Record<string, unknown>>;
  probeEvidence?: FormalRunProbeEvidence;
  probeReservationIds?: readonly string[];
  failureClass?: string;
  retryDelayMs?: number;
  db?: DbHandle;
}): Promise<boolean> {
  const db = input.db ?? (await getDb());
  return db.transaction(async (tx) => {
    const clockRows = await tx.execute<{ dbNow: Date | string }>(sql`SELECT now() AS "dbNow"`);
    const dbNow = dateValue(clockRows[0]?.dbNow);
    if (!dbNow) throw new Error('Database clock is invalid');
    const rows = await tx
      .select({
        status: contentAcquisitionRuns.status,
        scheduleId: contentAcquisitionRuns.scheduleId,
        endpointId: contentAcquisitionRuns.endpointId,
        parentRunId: contentAcquisitionRuns.parentRunId,
        sourcePartitionId: contentAcquisitionRuns.sourcePartitionId,
        jobKind: contentAcquisitionRuns.jobKind,
        adapterKind: contentAcquisitionRuns.adapterKind,
        windowStart: contentAcquisitionRuns.windowStart,
        windowEnd: contentAcquisitionRuns.windowEnd,
        providerUnits: contentAcquisitionRuns.providerUnits,
        xCallCount: contentAcquisitionRuns.xCallCount,
      })
      .from(contentAcquisitionRuns)
      .where(eq(contentAcquisitionRuns.runId, input.runId))
      .for('update')
      .limit(1);
    const run = rows[0];
    if (!run || !['PENDING', 'RUNNING'].includes(run.status)) return false;

    const retryDelayMs = Math.max(1_000, input.retryDelayMs ?? 60_000);
    const nextEligibleAtDate = new Date(dbNow.getTime() + retryDelayMs);
    const nextEligibleAt = nextEligibleAtDate.toISOString();
    const deferredFailureClass = (input.failureClass ?? 'RUNNER_CAPACITY').slice(0, 200);
    const metrics = {
      ...input.metrics,
      deferredReason: deferredFailureClass,
      nextEligibleAt,
      ...(input.probeEvidence?.runMetrics ?? {}),
      ...(input.probeEvidence ? { probeCallCount: 1 } : {}),
    };

    let providerUnits = Number(run.providerUnits ?? 0);
    if (!Number.isFinite(providerUnits) || providerUnits < 0) {
      throw new Error('Deferred formal run provider units are invalid');
    }
    if (input.probeEvidence) {
      if (
        (run.adapterKind !== 'X_ACCOUNT' && run.adapterKind !== 'X_SEMANTIC') ||
        !/^[0-9a-f]{64}$/.test(input.probeEvidence.requestMetadataHash) ||
        (input.probeEvidence.responseMetadataHash !== null &&
          !/^[0-9a-f]{64}$/.test(input.probeEvidence.responseMetadataHash)) ||
        (input.probeEvidence.providerJobIdHash !== null &&
          !/^[0-9a-f]{64}$/.test(input.probeEvidence.providerJobIdHash))
      ) {
        throw new Error('Deferred formal run has invalid X probe evidence');
      }
      if (!input.probeReservationIds || input.probeReservationIds.length === 0) {
        throw new Error('Deferred formal run has probe evidence without reserved probe budget');
      }
      const committedProbe = await commitOneXRunBudgetUnit({
        tx,
        runId: input.runId,
        dbNow,
        reservationIds: input.probeReservationIds,
      });
      if (!committedProbe) {
        throw new Error('Deferred formal run probe budget reservation disappeared before commit');
      }
      const traceRows = await tx
        .select({ maximum: max(contentAcquisitionProviderTraces.sequence) })
        .from(contentAcquisitionProviderTraces)
        .where(eq(contentAcquisitionProviderTraces.runId, input.runId));
      await tx.insert(contentAcquisitionProviderTraces).values({
        traceId: randomUUID(),
        runId: input.runId,
        sequence: Number(traceRows[0]?.maximum ?? -1) + 1,
        provider: input.probeEvidence.provider,
        operation: input.probeEvidence.operation,
        requestMetadataHash: input.probeEvidence.requestMetadataHash,
        responseMetadataHash: input.probeEvidence.responseMetadataHash,
        providerJobIdHash: input.probeEvidence.providerJobIdHash,
        providerUnits: String(input.probeEvidence.providerUnits),
        terminalState: input.probeEvidence.terminalState,
      });
      providerUnits += input.probeEvidence.providerUnits;
    }
    const providerPatch = input.probeEvidence
      ? {
          provider: 'grok-build' as const,
          providerUnits: String(providerUnits),
          xCallCount: (run.xCallCount ?? 0) + 1,
          traceVerified: false,
        }
      : {};

    const isTriggeredXSaturationFollowUp =
      run.parentRunId !== null &&
      run.sourcePartitionId !== null &&
      run.scheduleId === null &&
      run.endpointId === null &&
      (run.jobKind === 'X_KEYWORD_SCAN' || run.jobKind === 'X_SEMANTIC_SCAN');

    if (isTriggeredXSaturationFollowUp) {
      const [outbox] = await tx
        .select({
          outboxId: contentAcquisitionJobOutbox.outboxId,
          queueName: contentAcquisitionJobOutbox.queueName,
        })
        .from(contentAcquisitionJobOutbox)
        .where(eq(contentAcquisitionJobOutbox.runId, input.runId))
        .for('update')
        .limit(1);
      const reservations = await tx
        .select({ status: contentAcquisitionBudgetReservations.status })
        .from(contentAcquisitionBudgetReservations)
        .where(eq(contentAcquisitionBudgetReservations.runId, input.runId))
        .for('update');
      const activeReservations = reservations.filter(
        (reservation) => reservation.status !== 'RELEASED',
      );
      const hasReservedBudget =
        activeReservations.length > 0 &&
        activeReservations.some((reservation) => reservation.status === 'RESERVED') &&
        activeReservations.every((reservation) =>
          ['RESERVED', 'COMMITTED'].includes(reservation.status),
        );

      if (outbox?.queueName === 'content-x-scan' && hasReservedBudget) {
        const retryJobId = `content-x-capacity-retry-${sha256CanonicalJson({
          runId: input.runId,
          nextEligibleAt,
        })}`;
        const updated = await tx
          .update(contentAcquisitionRuns)
          .set({
            status: 'PENDING',
            ...providerPatch,
            failureClass: deferredFailureClass,
            failureDetailsHash: sha256CanonicalJson(metrics),
            errorSummary: `Formal acquisition ${deferredFailureClass} occurred; X follow-up will retry`,
            runMetrics: metrics,
            enqueueConfirmedAt: null,
            completedAt: null,
            // The run stays pending until the outbox becomes eligible. Anchor
            // its execution lease to that eligibility time so a retry has the
            // full provider deadline after it can actually be claimed.
            leaseExpiresAt: new Date(nextEligibleAtDate.getTime() + 6 * 60_000),
            checkpointAdvanced: false,
          })
          .where(
            and(
              eq(contentAcquisitionRuns.runId, input.runId),
              inArray(contentAcquisitionRuns.status, ['PENDING', 'RUNNING']),
            ),
          )
          .returning({ runId: contentAcquisitionRuns.runId });
        const reopened = await tx
          .update(contentAcquisitionJobOutbox)
          .set({
            jobId: retryJobId,
            availableAt: nextEligibleAtDate,
            leaseOwner: null,
            leaseExpiresAt: null,
            deliveredAt: null,
            lastErrorHash: sha256CanonicalJson(metrics),
            updatedAt: dbNow,
          })
          .where(eq(contentAcquisitionJobOutbox.outboxId, outbox.outboxId))
          .returning({ outboxId: contentAcquisitionJobOutbox.outboxId });
        if (updated.length !== 1 || reopened.length !== 1) {
          throw new Error('X saturation follow-up capacity retry transition was lost');
        }
        return true;
      }

      await releaseXRunBudgets({ tx, runId: input.runId, dbNow });
      const gapReason = `${deferredFailureClass}_FOLLOWUP_ORPHANED`.slice(0, 200);
      const gapDetails = {
        ...metrics,
        gapReason,
        outboxPresent: Boolean(outbox),
        outboxQueue: outbox?.queueName ?? null,
        reservationStatuses: reservations.map((reservation) => reservation.status),
      };
      const updated = await tx
        .update(contentAcquisitionRuns)
        .set({
          status: 'GAP',
          ...providerPatch,
          failureClass: gapReason,
          failureDetailsHash: sha256CanonicalJson(gapDetails),
          errorSummary: 'X saturation follow-up could not be safely requeued',
          runMetrics: gapDetails,
          completedAt: dbNow,
          leaseExpiresAt: null,
          checkpointAdvanced: false,
        })
        .where(
          and(
            eq(contentAcquisitionRuns.runId, input.runId),
            inArray(contentAcquisitionRuns.status, ['PENDING', 'RUNNING']),
          ),
        )
        .returning({ runId: contentAcquisitionRuns.runId });
      if (updated.length !== 1) throw new Error('X saturation follow-up gap transition was lost');
      if (!run.windowStart || !run.windowEnd) {
        throw new Error('X saturation follow-up gap window is missing');
      }
      await tx.insert(contentAcquisitionGaps).values({
        gapId: randomUUID(),
        declaringRunId: input.runId,
        partitionId: run.sourcePartitionId,
        windowStart: run.windowStart,
        windowEnd: run.windowEnd,
        reason: gapReason,
        detailsHash: sha256CanonicalJson(gapDetails),
        declaredAt: dbNow,
      });
      return true;
    }

    await releaseXRunBudgets({ tx, runId: input.runId, dbNow });
    await tx
      .update(contentAcquisitionRuns)
      .set({
        status: 'BUDGET_DEFERRED',
        ...providerPatch,
        failureClass: deferredFailureClass,
        failureDetailsHash: sha256CanonicalJson(metrics),
        errorSummary: `Formal acquisition ${deferredFailureClass} occurred before provider start`,
        runMetrics: metrics,
        completedAt: dbNow,
        leaseExpiresAt: null,
        checkpointAdvanced: false,
      })
      .where(
        and(
          eq(contentAcquisitionRuns.runId, input.runId),
          inArray(contentAcquisitionRuns.status, ['PENDING', 'RUNNING']),
        ),
      );

    if (run.scheduleId) {
      await tx
        .update(contentSourceSchedules)
        .set({
          leaseOwner: null,
          leaseExpiresAt: null,
          nextDueAt: new Date(dbNow.getTime() + retryDelayMs),
          updatedAt: dbNow,
        })
        .where(eq(contentSourceSchedules.scheduleId, run.scheduleId));
    } else if (run.endpointId) {
      await tx
        .update(contentSourceEndpoints)
        .set({
          identityNextCheckAt: new Date(dbNow.getTime() + retryDelayMs),
          updatedAt: dbNow,
        })
        .where(eq(contentSourceEndpoints.endpointId, run.endpointId));
    }
    return true;
  });
}

export async function deferFormalRunForAdmission(input: {
  runId: string;
  queueName: string;
  retryAfterSeconds: number;
  db?: DbHandle;
}): Promise<boolean> {
  if (
    !Number.isSafeInteger(input.retryAfterSeconds) ||
    input.retryAfterSeconds < 1 ||
    input.retryAfterSeconds > 15 * 60
  ) {
    throw new Error('Queue admission retryAfterSeconds must be an integer from 1 to 900');
  }
  return deferFormalRunForCapacity({
    runId: input.runId,
    metrics: {
      deferredReason: 'QUEUE_ADMISSION_CLOSED',
      queueName: input.queueName,
    },
    failureClass: 'QUEUE_ADMISSION_CLOSED',
    retryDelayMs: input.retryAfterSeconds * 1_000,
    db: input.db,
  });
}

export async function parkFormalRunForProviderPoll(input: {
  runId: string;
  providerJobId: string;
  providerUnits: number;
  nextPollAt: Date;
  trace: Readonly<{
    sequence: number;
    operation: string;
    requestMetadataHash: string;
    responseMetadataHash: string;
    providerJobIdHash: string;
    terminalState: string;
  }>;
  metrics: Readonly<Record<string, unknown>>;
  commitReservedCredits: boolean;
  db?: DbHandle;
}): Promise<boolean> {
  if (!input.providerJobId.trim() || input.providerJobId.length > 512) {
    throw new Error('Provider job ID is invalid');
  }
  if (!Number.isFinite(input.providerUnits) || input.providerUnits < 0) {
    throw new Error('Provider units must be non-negative');
  }
  if (!Number.isSafeInteger(input.trace.sequence) || input.trace.sequence < 0) {
    throw new Error('Provider trace sequence is invalid');
  }
  const db = input.db ?? (await getDb());
  return db.transaction(async (tx) => {
    const clockRows = await tx.execute<{ dbNow: Date | string }>(sql`SELECT now() AS "dbNow"`);
    const dbNow = dateValue(clockRows[0]?.dbNow);
    if (!dbNow) throw new Error('Database clock is invalid');
    if (input.nextPollAt <= dbNow) throw new Error('Provider next poll time must be in the future');
    const rows = await tx
      .select({
        status: contentAcquisitionRuns.status,
        scheduleId: contentAcquisitionRuns.scheduleId,
        jobKind: contentAcquisitionRuns.jobKind,
        provider: contentAcquisitionRuns.provider,
        providerJobId: contentAcquisitionRuns.providerJobId,
        providerUnits: contentAcquisitionRuns.providerUnits,
      })
      .from(contentAcquisitionRuns)
      .where(eq(contentAcquisitionRuns.runId, input.runId))
      .for('update')
      .limit(1);
    const run = rows[0];
    if (!run || run.status !== 'RUNNING') return false;
    if (run.scheduleId || run.jobKind !== 'YOUTUBE_TRANSCRIPT') {
      throw new Error('Only a triggered YouTube transcript run may await a provider job');
    }
    if (run.provider && run.provider !== 'supadata') {
      throw new Error('Formal run is already bound to another provider');
    }
    if (run.providerJobId && run.providerJobId !== input.providerJobId) {
      throw new Error('Formal run cannot be rebound to another provider job');
    }
    const existingUnits = Number(run.providerUnits ?? 0);
    if (!Number.isFinite(existingUnits) || existingUnits < 0) {
      throw new Error('Persisted provider units are invalid');
    }
    if (input.commitReservedCredits) {
      if (run.providerJobId || input.providerUnits <= 0) {
        throw new Error('Only the first billed provider submission may commit reserved credits');
      }
      const reconciled = await reconcileReservedProviderBudget({
        tx,
        runId: input.runId,
        scopeKey: 'SUPADATA_TRANSCRIPT',
        unitKind: 'CREDIT',
        actualUnits: input.providerUnits,
        dbNow,
      });
      if (!reconciled) throw new Error('Supadata submission has no reserved credit budget');
      await commitRunBudgets({ tx, runId: input.runId, dbNow });
    }
    await tx.insert(contentAcquisitionProviderTraces).values({
      traceId: randomUUID(),
      runId: input.runId,
      sequence: input.trace.sequence,
      provider: 'supadata',
      operation: input.trace.operation,
      requestMetadataHash: input.trace.requestMetadataHash,
      responseMetadataHash: input.trace.responseMetadataHash,
      providerJobIdHash: input.trace.providerJobIdHash,
      providerUnits: String(input.providerUnits),
      terminalState: input.trace.terminalState,
    });
    const nextUnits = existingUnits + input.providerUnits;
    const updated = await tx
      .update(contentAcquisitionRuns)
      .set({
        status: 'PENDING',
        provider: 'supadata',
        providerJobId: input.providerJobId,
        providerUnits: String(nextUnits),
        runMetrics: sql`${contentAcquisitionRuns.runMetrics} || ${JSON.stringify(
          input.metrics,
        )}::jsonb`,
        leaseExpiresAt: null,
      })
      .where(
        and(
          eq(contentAcquisitionRuns.runId, input.runId),
          eq(contentAcquisitionRuns.status, 'RUNNING'),
        ),
      )
      .returning({ runId: contentAcquisitionRuns.runId });
    if (updated.length !== 1) throw new Error('Provider poll transition was lost');
    const pollJobId = `content-provider-poll-${sha256CanonicalJson({
      runId: input.runId,
      sequence: input.trace.sequence,
      nextPollAt: input.nextPollAt.toISOString(),
    })}`;
    const reopened = await tx
      .update(contentAcquisitionJobOutbox)
      .set({
        jobId: pollJobId,
        availableAt: input.nextPollAt,
        leaseOwner: null,
        leaseExpiresAt: null,
        deliveredAt: null,
        lastErrorHash: null,
        updatedAt: dbNow,
      })
      .where(eq(contentAcquisitionJobOutbox.runId, input.runId))
      .returning({ outboxId: contentAcquisitionJobOutbox.outboxId });
    if (reopened.length !== 1) throw new Error('Provider poll outbox row is missing');
    return true;
  });
}

export async function beginFormalRun(input: {
  runId: string;
  db?: DbHandle;
}): Promise<BegunFormalRun> {
  const db = input.db ?? (await getDb());
  return db.transaction(async (tx) => {
    const clockRows = await tx.execute<{ dbNow: Date | string }>(sql`SELECT now() AS "dbNow"`);
    const dbNow = dateValue(clockRows[0]?.dbNow);
    if (!dbNow) throw new Error('Database clock is invalid');
    const rows = await tx
      .select({
        runId: contentAcquisitionRuns.runId,
        scheduleId: contentAcquisitionRuns.scheduleId,
        parentRunId: contentAcquisitionRuns.parentRunId,
        status: contentAcquisitionRuns.status,
        requestSnapshot: contentAcquisitionRuns.requestSnapshot,
        leaseExpiresAt: contentAcquisitionRuns.leaseExpiresAt,
        providerJobId: contentAcquisitionRuns.providerJobId,
        providerUnits: contentAcquisitionRuns.providerUnits,
      })
      .from(contentAcquisitionRuns)
      .where(eq(contentAcquisitionRuns.runId, input.runId))
      .for('update')
      .limit(1);
    const run = rows[0];
    if (!run) throw new Error(`Formal acquisition run not found: ${input.runId}`);
    const scheduleKey = run.scheduleId
      ? ((
          await tx
            .select({ scheduleKey: contentSourceSchedules.scheduleKey })
            .from(contentSourceSchedules)
            .where(eq(contentSourceSchedules.scheduleId, run.scheduleId))
            .limit(1)
        )[0]?.scheduleKey ?? null)
      : null;
    const request = parseFormalRunRequestV1(run.requestSnapshot);
    const traceRows = await tx
      .select({ maximum: max(contentAcquisitionProviderTraces.sequence) })
      .from(contentAcquisitionProviderTraces)
      .where(eq(contentAcquisitionProviderTraces.runId, input.runId));
    const providerTraceSequence = Number(traceRows[0]?.maximum ?? -1) + 1;
    const providerUnits = Number(run.providerUnits ?? 0);
    if (!Number.isFinite(providerUnits) || providerUnits < 0) {
      throw new Error('Formal acquisition provider units are invalid');
    }
    if (run.status !== 'PENDING') {
      return {
        runId: run.runId,
        scheduleId: run.scheduleId,
        scheduleKey,
        parentRunId: run.parentRunId,
        request,
        providerJobId: run.providerJobId,
        providerUnits,
        providerTraceSequence,
        status: 'TERMINAL',
      };
    }
    if (run.leaseExpiresAt && run.leaseExpiresAt <= dbNow) {
      throw new Error('Formal acquisition run lease expired before worker start');
    }
    const updated = await tx
      .update(contentAcquisitionRuns)
      .set({ status: 'RUNNING', startedAt: dbNow })
      .where(
        and(
          eq(contentAcquisitionRuns.runId, input.runId),
          eq(contentAcquisitionRuns.status, 'PENDING'),
        ),
      )
      .returning({ runId: contentAcquisitionRuns.runId });
    if (updated.length !== 1) throw new Error('Formal acquisition run start transition was lost');
    return {
      runId: run.runId,
      scheduleId: run.scheduleId,
      scheduleKey,
      parentRunId: run.parentRunId,
      request,
      providerJobId: run.providerJobId,
      providerUnits,
      providerTraceSequence,
      status: 'RUNNING',
    };
  });
}

export async function loadFormalRunRequest(input: {
  runId: string;
  db?: DbHandle;
}): Promise<FormalRunRequestV1> {
  const db = input.db ?? (await getDb());
  const rows = await db
    .select({ requestSnapshot: contentAcquisitionRuns.requestSnapshot })
    .from(contentAcquisitionRuns)
    .where(eq(contentAcquisitionRuns.runId, input.runId))
    .limit(1);
  const run = rows[0];
  if (!run) throw new Error(`Formal acquisition run not found: ${input.runId}`);
  return parseFormalRunRequestV1(run.requestSnapshot);
}
