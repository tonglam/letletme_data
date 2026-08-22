import { createHash, randomUUID } from 'node:crypto';

import { and, asc, desc, eq, inArray, isNull, lte, max, or, sql } from 'drizzle-orm';

import {
  contentAcquisitionGaps,
  contentAcquisitionJobOutbox,
  contentAcquisitionProviderTraces,
  contentAcquisitionRuns,
  contentSourceEndpoints,
  contentSourcePartitionMembers,
  contentSourcePartitions,
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
  commitRunBudgets,
  reconcileReservedProviderBudget,
  releaseXRunBudgets,
  reserveXRunBudgets,
  type XBudgetPolicy,
} from './x-budget';

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
  parentRunId: string | null;
  request: FormalRunRequestV1;
  providerJobId: string | null;
  providerUnits: number;
  providerTraceSequence: number;
  status: 'RUNNING' | 'TERMINAL';
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

function jobId(input: {
  targetId: string;
  jobKind: string;
  windowEnd: Date;
  profileRevision: number;
  attemptNo: number;
}): string {
  const value = [
    input.targetId,
    input.jobKind,
    input.windowEnd.getTime(),
    input.profileRevision,
    input.attemptNo,
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
  dbNow: Date;
  checkpoint: JsonRecord;
  bootstrapCutoffAt: Date;
  bootstrapEnabled: boolean;
  lookbackMinutes: number;
}): { windowStart: Date; windowEnd: Date } {
  if (input.adapterKind === 'X_ACCOUNT' || input.adapterKind === 'X_SEMANTIC') {
    const windowEnd = new Date(input.dbNow.getTime() - 60_000);
    const checkpointEnd = dateValue(asString(input.checkpoint.windowEnd));
    const defaultStart = new Date(windowEnd.getTime() - input.lookbackMinutes * 60_000);
    const overlapped = checkpointEnd ? new Date(checkpointEnd.getTime() - 120_000) : defaultStart;
    const maximumStart = new Date(windowEnd.getTime() - 24 * 60 * 60_000);
    return {
      windowStart: overlapped < maximumStart ? maximumStart : overlapped,
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
    const phase = resolveFormalAcquisitionPhase({
      now: dbNow,
      nextDeadline: dateValue(clockRows[0]?.nextDeadline),
    });
    const dueEndpoints = await tx
      .select({ endpointId: contentSourceEndpoints.endpointId })
      .from(contentSourceEndpoints)
      .innerJoin(contentSources, eq(contentSources.sourceId, contentSourceEndpoints.sourceId))
      .where(
        and(
          eq(contentSourceEndpoints.adapterKind, 'X_ACCOUNT'),
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
      .limit(input.claimLimit)
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
        jobId: jobId({
          targetId: endpoint.endpointId,
          jobKind: request.jobKind,
          windowEnd: dbNow,
          profileRevision: request.profileRevision,
          attemptNo,
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
      .limit(input.claimLimit)
      .for('update', { skipLocked: true });

    const claimed: ClaimedFormalRun[] = [];
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
        dbNow,
        checkpoint: asRecord(schedule.checkpoint),
        bootstrapCutoffAt,
        bootstrapEnabled,
        lookbackMinutes: profile.bootstrap.lookbackMinutes,
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
          (endpoint.identityStatus !== 'VERIFIED' &&
            endpoint.adapterKind !== 'RSS_ATOM' &&
            endpoint.adapterKind !== 'PODCAST_FEED')
        ) {
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
              member.identityStatus !== 'VERIFIED' ||
              member.endpointStatus !== 'active' ||
              member.sourceStatus !== 'active' ||
              member.adapterKind !== partition.adapterKind ||
              member.profileKey !== partition.profileKey,
          )
        ) {
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
        continue;
      }

      let sourceSnapshotRevision = schedule.scheduleId;
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
          sourceSnapshot = retry.sourceSnapshot.map((item) => asRecord(item));
          endpointSnapshotValue = asRecord(retry.endpointSnapshot);
          sourceSnapshotRevision = retry.sourceSnapshotRevision ?? schedule.scheduleId;
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
            ? 'GROK_ATTESTED_FINAL'
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
        jobId: jobId({
          targetId: schedule.scheduleId,
          jobKind: schedule.jobKind,
          windowEnd: requestWindowEnd,
          profileRevision: schedule.profileRevision,
          attemptNo,
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
        status: contentAcquisitionRuns.status,
      })
      .from(contentAcquisitionRuns)
      .where(eq(contentAcquisitionRuns.runId, input.runId))
      .for('update')
      .limit(1);
    const run = rows[0];
    if (!run || !['PENDING', 'RUNNING'].includes(run.status)) return false;
    await releaseXRunBudgets({ tx, runId: input.runId, dbNow });
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
    const exhaustedXWindow =
      run.scheduleId !== null &&
      failureStreak >= 3 &&
      (run.adapterKind === 'X_ACCOUNT' || run.adapterKind === 'X_SEMANTIC');
    if (exhaustedXWindow && (!run.windowStart || !run.windowEnd)) {
      throw new Error('Exhausted X retry has no immutable acquisition window');
    }
    const failureClass = input.failureClass.slice(0, 200);
    await tx
      .update(contentAcquisitionRuns)
      .set({
        status: exhaustedXWindow ? 'GAP' : 'FAILED',
        failureClass,
        errorSummary: input.errorSummary.replace(/\s+/g, ' ').trim().slice(0, 1_000),
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
      const circuitOpen = failureStreak >= 3;
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
          probeAfter: circuitOpen ? new Date(dbNow.getTime() + 30 * 60_000) : null,
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
    const updated = await tx
      .update(contentAcquisitionRuns)
      .set({
        status: 'BUDGET_DEFERRED',
        runMetrics: input.metrics,
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
      parentRunId: run.parentRunId,
      request,
      providerJobId: run.providerJobId,
      providerUnits,
      providerTraceSequence,
      status: 'RUNNING',
    };
  });
}
