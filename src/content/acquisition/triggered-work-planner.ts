import { createHash, randomUUID } from 'node:crypto';

import { and, asc, desc, eq, inArray, isNull, lte, max, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import {
  contentAcquisitionJobOutbox,
  contentAcquisitionRuns,
  contentSourceEndpoints,
  contentSourceReceiptRevisions,
  contentSourceReceipts,
  contentSources,
} from '../../db/schemas/content.schema';
import { getDb, type DbHandle, type TransactionHandle } from '../../db/singleton';
import { parseCanonicalAcquisitionItemV1, type AcquisitionItemV1 } from './acquisition-contract';
import { getAcquisitionProfile, type AcquisitionPhase } from './acquisition-profiles';
import { ARTICLE_PROFILE_KEY, ARTICLE_PROFILE_REVISION } from './article-adapter';
import { sha256CanonicalJson } from './canonicalization';
import { parseFormalRunRequestV1, type FormalRunRequestV1 } from './formal-run-contract';
import { resolveFormalAcquisitionPhase } from './formal-run-repository';
import { PODCAST_TRANSCRIPT_POLICY_V1 } from './podcast-transcript-adapter';
import {
  YOUTUBE_METADATA_POLICY_V1,
  YOUTUBE_TRANSCRIPT_POLICY_V1,
} from './youtube-metadata-client';
import type { ContentRuntimeFlags } from '../config';

type TerminalRun = Readonly<{
  runId: string;
  jobKind: string | null;
  status: string;
  requestSnapshot: unknown;
  runMetrics: unknown;
  providerJobId: string | null;
  completedAt: Date | null;
  createdAt: Date;
}>;

type Candidate = Readonly<{
  receiptId: string;
  receiptRevisionId: string;
  revisionRunId: string;
  contentKind: string;
  payload: unknown;
  endpointId: string;
  endpointKey: string;
  endpointAdapterKind: string;
  profileKey: string;
  locator: unknown;
  stableExternalId: string | null;
  endpointRightsPolicy: unknown;
  sourceId: string;
  sourceKey: string;
  sourceRightsPolicy: unknown;
}>;

type Plan = Readonly<{
  request: FormalRunRequestV1;
  queueName: 'content-http-acquisition' | 'content-media-transcript';
  evidenceMode: 'HTTP_DETERMINISTIC' | 'PROVIDER_ATTESTED' | 'HERMES_TIMESTAMPED';
  parentRunId: string;
  priority: number;
}>;

export type TriggeredWorkPlannerResult = Readonly<{
  scanned: number;
  planned: number;
  reclaimed: number;
  providerPollRecovered: number;
  byJobKind: Readonly<Record<string, number>>;
}>;

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

function date(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const result = value instanceof Date ? value : new Date(value);
  return Number.isFinite(result.getTime()) ? result : null;
}

function endpointSnapshot(candidate: Candidate) {
  return {
    endpointId: candidate.endpointId,
    endpointKey: candidate.endpointKey,
    sourceId: candidate.sourceId,
    sourceKey: candidate.sourceKey,
    adapterKind: candidate.endpointAdapterKind as 'RSS_ATOM' | 'PODCAST_FEED' | 'YOUTUBE_CHANNEL',
    profileKey: candidate.profileKey,
    locator: record(candidate.locator) as Record<string, string>,
    stableExternalId: candidate.stableExternalId,
    rightsPolicy: {
      source: record(candidate.sourceRightsPolicy),
      endpoint: record(candidate.endpointRightsPolicy),
    },
  };
}

function latestRun(runs: readonly TerminalRun[], jobKind: string): TerminalRun | null {
  return runs.find((run) => run.jobKind === jobKind) ?? null;
}

function runNextEligibleAt(run: TerminalRun | null, fallbackDelayMs: number): Date | null {
  if (!run) return null;
  const metrics = record(run.runMetrics);
  const explicit = typeof metrics.nextEligibleAt === 'string' ? date(metrics.nextEligibleAt) : null;
  if (explicit) return explicit;
  const completedAt = run.completedAt ?? run.createdAt;
  if (run.status === 'BUDGET_DEFERRED') {
    // Provider ledgers are rolling 24-hour windows. A short retry cadence can
    // exhaust the bounded attempt count before capacity returns, so a legacy
    // deferral without an explicit provider reset hint waits out the window.
    return new Date(completedAt.getTime() + 24 * 60 * 60_000);
  }
  if (run.status === 'FAILED') return new Date(completedAt.getTime() + fallbackDelayMs);
  return new Date(completedAt.getTime() + fallbackDelayMs);
}

function finishedAt(item: AcquisitionItemV1): Date | null {
  return date(item.video?.actualEndAt ?? item.publishedAt);
}

export function articleSourceMatchesEndpointOrigin(input: {
  locator: unknown;
  sourceUrl: string;
}): boolean {
  const endpointUrl = record(input.locator).url;
  if (typeof endpointUrl !== 'string') return false;
  try {
    return new URL(endpointUrl).origin === new URL(input.sourceUrl).origin;
  } catch {
    return false;
  }
}

function transcriptStage(run: TerminalRun): 'NATIVE_FIRST' | 'NATIVE_SECOND' | 'GENERATED' | null {
  if (run.jobKind !== 'YOUTUBE_TRANSCRIPT') return null;
  const request = parseFormalRunRequestV1(run.requestSnapshot);
  return request.jobKind === 'YOUTUBE_TRANSCRIPT' ? request.attemptStage : null;
}

function retryFailureCount(runs: readonly TerminalRun[], jobKind: string): number {
  return runs.filter((run) => run.jobKind === jobKind && run.status === 'FAILED').length;
}

function planForCandidate(input: {
  candidate: Candidate;
  item: AcquisitionItemV1;
  runs: readonly TerminalRun[];
  flags: ContentRuntimeFlags;
  phase: AcquisitionPhase;
  dbNow: Date;
}): Plan | null {
  const { candidate, item, runs, flags, phase, dbNow } = input;
  const profile = getAcquisitionProfile(candidate.profileKey);
  if (!profile) throw new Error(`Unknown acquisition profile ${candidate.profileKey}`);
  const endpoint = endpointSnapshot(candidate);
  const common = {
    schemaVersion: 1 as const,
    phase,
    profileKey: profile.profileKey,
    profileRevision: profile.revision,
    windowStart: dbNow.toISOString(),
    windowEnd: dbNow.toISOString(),
    endpoint,
    discoveryItem: item,
  };

  if (
    candidate.contentKind === 'ARTICLE' &&
    item.body.availability !== 'FULL' &&
    item.linkAvailability === 'DIRECT' &&
    item.sourceUrl !== null &&
    articleSourceMatchesEndpointOrigin({ locator: candidate.locator, sourceUrl: item.sourceUrl }) &&
    flags.httpAcquisitionEnabled
  ) {
    const latest = latestRun(runs, 'ARTICLE_FETCH');
    const failures = retryFailureCount(runs, 'ARTICLE_FETCH');
    if (latest && !['FAILED', 'BUDGET_DEFERRED'].includes(latest.status)) return null;
    if (failures >= 3) return null;
    const due = runNextEligibleAt(latest, failures <= 1 ? 60_000 : 5 * 60_000);
    if (due && due > dbNow) return null;
    return {
      request: parseFormalRunRequestV1({
        ...common,
        jobKind: 'ARTICLE_FETCH',
        adapterKind: 'ARTICLE_HTTP',
        profileKey: ARTICLE_PROFILE_KEY,
        profileRevision: ARTICLE_PROFILE_REVISION,
        allowedOrigins: [new URL(item.sourceUrl).origin],
        validator: { etag: null, lastModified: null },
      }),
      queueName: 'content-http-acquisition',
      evidenceMode: 'HTTP_DETERMINISTIC',
      parentRunId: latest?.runId ?? candidate.revisionRunId,
      priority: profile.priority,
    };
  }

  if (
    candidate.contentKind === 'EPISODE' &&
    item.transcript.status === 'PENDING' &&
    flags.podcastTranscriptEnabled
  ) {
    const latest = latestRun(runs, 'PODCAST_TRANSCRIPT');
    const failures = retryFailureCount(runs, 'PODCAST_TRANSCRIPT');
    if (latest && !['FAILED', 'BUDGET_DEFERRED'].includes(latest.status)) return null;
    if (failures >= 3) return null;
    const due = runNextEligibleAt(latest, failures <= 1 ? 60_000 : 5 * 60_000);
    if (due && due > dbNow) return null;
    return {
      request: parseFormalRunRequestV1({
        ...common,
        jobKind: 'PODCAST_TRANSCRIPT',
        adapterKind: 'HERMES_TRANSCRIPT',
        policy: PODCAST_TRANSCRIPT_POLICY_V1,
      }),
      queueName: 'content-media-transcript',
      evidenceMode: 'HERMES_TIMESTAMPED',
      parentRunId: latest?.runId ?? candidate.revisionRunId,
      priority: profile.priority,
    };
  }

  if (
    candidate.contentKind !== 'VIDEO' ||
    !flags.youtubeNativeEnabled ||
    !['PENDING', 'DEFERRED'].includes(item.transcript.status)
  ) {
    return null;
  }
  if (!item.video || item.video.lifecycleState !== 'FINISHED') {
    if (item.transcript.status !== 'PENDING') return null;
    const latest = latestRun(runs, 'YOUTUBE_METADATA');
    const failures = retryFailureCount(runs, 'YOUTUBE_METADATA');
    if (latest && !['FAILED', 'BUDGET_DEFERRED', 'CONTENT_DEFERRED'].includes(latest.status)) {
      return null;
    }
    if (failures >= 3) return null;
    const due = runNextEligibleAt(latest, failures <= 1 ? 60_000 : 5 * 60_000);
    if (due && due > dbNow) return null;
    return {
      request: parseFormalRunRequestV1({
        ...common,
        jobKind: 'YOUTUBE_METADATA',
        adapterKind: 'YOUTUBE_CHANNEL',
        policy: YOUTUBE_METADATA_POLICY_V1,
      }),
      queueName: 'content-http-acquisition',
      evidenceMode: 'PROVIDER_ATTESTED',
      parentRunId: latest?.runId ?? candidate.revisionRunId,
      priority: profile.priority,
    };
  }

  const completedAt = finishedAt(item);
  if (!completedAt || item.video.durationSeconds === null) return null;
  const contentAgeMinutes = Math.max(0, (dbNow.getTime() - completedAt.getTime()) / 60_000);
  const transcriptRuns = runs.filter((run) => run.jobKind === 'YOUTUBE_TRANSCRIPT');
  const byStage = new Map<string, TerminalRun>();
  for (const run of transcriptRuns) {
    const stage = transcriptStage(run);
    if (stage && !byStage.has(stage)) byStage.set(stage, run);
  }

  let stage: 'NATIVE_FIRST' | 'NATIVE_SECOND' | 'GENERATED';
  let mode: 'NATIVE' | 'AUTO';
  let latest: TerminalRun | null;
  const first = byStage.get('NATIVE_FIRST') ?? null;
  const second = byStage.get('NATIVE_SECOND') ?? null;
  const generated = byStage.get('GENERATED') ?? null;
  if (!first) {
    stage = 'NATIVE_FIRST';
    mode = 'NATIVE';
    latest = null;
    if (new Date(completedAt.getTime() + 10 * 60_000) > dbNow) return null;
  } else if (['FAILED', 'BUDGET_DEFERRED'].includes(first.status)) {
    if (
      transcriptRuns.filter(
        (run) => transcriptStage(run) === 'NATIVE_FIRST' && run.status === 'FAILED',
      ).length >= 3
    ) {
      return null;
    }
    stage = 'NATIVE_FIRST';
    mode = 'NATIVE';
    latest = first;
  } else if (!second) {
    if (first.status !== 'CONTENT_DEFERRED') return null;
    stage = 'NATIVE_SECOND';
    mode = 'NATIVE';
    latest = first;
  } else if (['FAILED', 'BUDGET_DEFERRED'].includes(second.status)) {
    if (
      transcriptRuns.filter(
        (run) => transcriptStage(run) === 'NATIVE_SECOND' && run.status === 'FAILED',
      ).length >= 3
    ) {
      return null;
    }
    stage = 'NATIVE_SECOND';
    mode = 'NATIVE';
    latest = second;
  } else {
    if (generated && ['FAILED', 'BUDGET_DEFERRED'].includes(generated.status)) {
      const generatedRuns = transcriptRuns.filter((run) => transcriptStage(run) === 'GENERATED');
      if (
        generated.providerJobId ||
        generatedRuns.filter((run) => run.status === 'FAILED').length >= 3
      ) {
        return null;
      }
      stage = 'GENERATED';
      mode = 'AUTO';
      latest = generated;
    } else {
      if (
        !flags.youtubeGeneratedEnabled ||
        generated ||
        second.status !== 'CONTENT_DEFERRED' ||
        contentAgeMinutes > YOUTUBE_TRANSCRIPT_POLICY_V1.maximumContentAgeMinutes ||
        item.video.durationSeconds > YOUTUBE_TRANSCRIPT_POLICY_V1.maximumDurationSeconds
      ) {
        return null;
      }
      stage = 'GENERATED';
      mode = 'AUTO';
      latest = second;
    }
  }
  const due = runNextEligibleAt(latest, 5 * 60_000);
  if (due && due > dbNow) return null;
  return {
    request: parseFormalRunRequestV1({
      ...common,
      jobKind: 'YOUTUBE_TRANSCRIPT',
      adapterKind: 'SUPADATA_TRANSCRIPT',
      mode,
      attemptStage: stage,
      policy: YOUTUBE_TRANSCRIPT_POLICY_V1,
    }),
    queueName: 'content-http-acquisition',
    evidenceMode: 'PROVIDER_ATTESTED',
    parentRunId: latest?.runId ?? candidate.revisionRunId,
    priority: profile.priority,
  };
}

async function nextAttemptNumber(
  tx: TransactionHandle,
  request: FormalRunRequestV1,
  requestHash: string,
): Promise<number> {
  const rows = await tx
    .select({ maximum: max(contentAcquisitionRuns.attemptNo) })
    .from(contentAcquisitionRuns)
    .where(
      and(
        eq(contentAcquisitionRuns.jobKind, request.jobKind),
        eq(contentAcquisitionRuns.requestHash, requestHash),
      ),
    );
  return Number(rows[0]?.maximum ?? 0) + 1;
}

async function recoverStaleTriggeredRuns(tx: TransactionHandle, dbNow: Date): Promise<number> {
  const stale = await tx
    .select({ runId: contentAcquisitionRuns.runId })
    .from(contentAcquisitionRuns)
    .where(
      and(
        isNull(contentAcquisitionRuns.scheduleId),
        ne(contentAcquisitionRuns.jobKind, 'X_IDENTITY'),
        inArray(contentAcquisitionRuns.status, ['PENDING', 'RUNNING']),
        lte(contentAcquisitionRuns.leaseExpiresAt, dbNow),
      ),
    )
    .orderBy(asc(contentAcquisitionRuns.leaseExpiresAt))
    .limit(20)
    .for('update', { skipLocked: true });
  for (const row of stale) {
    const recoveryId = createHash('sha256')
      .update(`${row.runId}\u001f${dbNow.toISOString()}`, 'utf8')
      .digest('hex');
    await tx
      .update(contentAcquisitionRuns)
      .set({
        status: 'PENDING',
        leaseExpiresAt: null,
        completedAt: null,
        runMetrics: sql`${contentAcquisitionRuns.runMetrics} || ${JSON.stringify({
          recoveredAfterLeaseExpiryAt: dbNow.toISOString(),
        })}::jsonb`,
      })
      .where(eq(contentAcquisitionRuns.runId, row.runId));
    await tx
      .update(contentAcquisitionJobOutbox)
      .set({
        jobId: `content-trigger-recovery-${recoveryId}`,
        availableAt: dbNow,
        leaseOwner: null,
        leaseExpiresAt: null,
        deliveredAt: null,
        updatedAt: dbNow,
      })
      .where(eq(contentAcquisitionJobOutbox.runId, row.runId));
  }
  return stale.length;
}

async function recoverFailedProviderPoll(
  tx: TransactionHandle,
  run: TerminalRun,
  dbNow: Date,
): Promise<boolean> {
  if (run.status !== 'FAILED' || !run.providerJobId || run.jobKind !== 'YOUTUBE_TRANSCRIPT') {
    return false;
  }
  const metrics = record(run.runMetrics);
  const recoveries =
    typeof metrics.providerPollRecoveries === 'number' ? metrics.providerPollRecoveries : 0;
  if (!Number.isSafeInteger(recoveries)) return false;
  if (recoveries >= 2) {
    await tx
      .update(contentAcquisitionRuns)
      .set({
        failureClass: 'PROVIDER_POLL_RETRY_EXHAUSTED',
        runMetrics: sql`${contentAcquisitionRuns.runMetrics} || ${JSON.stringify({
          providerPollTerminalState: 'POLL_RETRY_EXHAUSTED',
          providerPollExhaustedAt: dbNow.toISOString(),
        })}::jsonb`,
      })
      .where(
        and(
          eq(contentAcquisitionRuns.runId, run.runId),
          eq(contentAcquisitionRuns.status, 'FAILED'),
        ),
      );
    return false;
  }
  const due = new Date((run.completedAt ?? run.createdAt).getTime() + (recoveries + 1) * 60_000);
  if (due > dbNow) return false;
  const recoveryId = createHash('sha256')
    .update(`${run.runId}\u001fprovider-poll\u001f${recoveries + 1}`, 'utf8')
    .digest('hex');
  const updated = await tx
    .update(contentAcquisitionRuns)
    .set({
      status: 'PENDING',
      completedAt: null,
      leaseExpiresAt: null,
      runMetrics: sql`${contentAcquisitionRuns.runMetrics} || ${JSON.stringify({
        providerPollRecoveries: recoveries + 1,
        providerPollRecoveredAt: dbNow.toISOString(),
      })}::jsonb`,
    })
    .where(
      and(eq(contentAcquisitionRuns.runId, run.runId), eq(contentAcquisitionRuns.status, 'FAILED')),
    )
    .returning({ runId: contentAcquisitionRuns.runId });
  if (updated.length !== 1) return false;
  await tx
    .update(contentAcquisitionJobOutbox)
    .set({
      jobId: `content-provider-recovery-${recoveryId}`,
      availableAt: dbNow,
      leaseOwner: null,
      leaseExpiresAt: null,
      deliveredAt: null,
      updatedAt: dbNow,
    })
    .where(eq(contentAcquisitionJobOutbox.runId, run.runId));
  return true;
}

export async function planTriggeredContentWork(input: {
  flags: ContentRuntimeFlags;
  limit?: number;
  db?: DbHandle;
}): Promise<TriggeredWorkPlannerResult> {
  const limit = input.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('Triggered work planner limit must be an integer from 1 to 100');
  }
  if (!input.flags.pipelineEnabled) {
    return { scanned: 0, planned: 0, reclaimed: 0, providerPollRecovered: 0, byJobKind: {} };
  }
  const db = input.db ?? (await getDb());
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('briefing-triggered-planner-v1'))`);
    const clockRows = await tx.execute<{
      dbNow: Date | string;
      nextDeadline: Date | string | null;
    }>(
      sql`SELECT now() AS "dbNow", (SELECT min(deadline_time) FROM fpl.events WHERE deadline_time > now()) AS "nextDeadline"`,
    );
    const dbNow = date(clockRows[0]?.dbNow);
    if (!dbNow) throw new Error('Database clock is invalid');
    const phase = resolveFormalAcquisitionPhase({
      now: dbNow,
      nextDeadline: date(clockRows[0]?.nextDeadline),
    });
    const reclaimed = await recoverStaleTriggeredRuns(tx, dbNow);
    // PostgreSQL requires an unqualified relation name in `FOR UPDATE OF`.
    // Drizzle emits the schema-qualified name for a base table, so use an
    // explicit alias to keep the lock scoped to the mutable receipt relation.
    const plannerReceipts = alias(contentSourceReceipts, 'planner_receipts');
    const candidates = await tx
      .select({
        receiptId: plannerReceipts.receiptId,
        receiptRevisionId: contentSourceReceiptRevisions.receiptRevisionId,
        revisionRunId: contentSourceReceiptRevisions.runId,
        contentKind: plannerReceipts.contentKind,
        payload: contentSourceReceiptRevisions.payload,
        endpointId: contentSourceEndpoints.endpointId,
        endpointKey: contentSourceEndpoints.endpointKey,
        endpointAdapterKind: contentSourceEndpoints.adapterKind,
        profileKey: contentSourceEndpoints.profileKey,
        locator: contentSourceEndpoints.locator,
        stableExternalId: contentSourceEndpoints.stableExternalId,
        endpointRightsPolicy: contentSourceEndpoints.rightsPolicy,
        sourceId: contentSources.sourceId,
        sourceKey: contentSources.sourceKey,
        sourceRightsPolicy: contentSources.rightsPolicy,
      })
      .from(plannerReceipts)
      .innerJoin(
        contentSourceReceiptRevisions,
        eq(contentSourceReceiptRevisions.receiptRevisionId, plannerReceipts.currentRevisionId),
      )
      .innerJoin(
        contentSourceEndpoints,
        eq(contentSourceEndpoints.endpointId, plannerReceipts.primaryEndpointId),
      )
      .innerJoin(contentSources, eq(contentSources.sourceId, plannerReceipts.sourceId))
      .where(
        and(
          inArray(plannerReceipts.contentKind, ['ARTICLE', 'EPISODE', 'VIDEO']),
          eq(contentSourceEndpoints.status, 'active'),
          eq(contentSources.status, 'active'),
        ),
      )
      .orderBy(
        sql`${plannerReceipts.workPlannerCheckedAt} ASC NULLS FIRST`,
        desc(contentSourceReceiptRevisions.createdAt),
      )
      .limit(limit)
      // Only the mutable receipt row is claimed here.  The joined revision is
      // intentionally immutable and the runtime role is not granted UPDATE
      // on it; a plain FOR UPDATE would implicitly lock every joined table
      // and fail with 42501 before any content work could be planned.
      .for('update', { of: plannerReceipts, skipLocked: true });

    if (candidates.length > 0) {
      await tx
        .update(contentSourceReceipts)
        .set({ workPlannerCheckedAt: dbNow })
        .where(
          inArray(
            contentSourceReceipts.receiptId,
            candidates.map((candidate) => candidate.receiptId),
          ),
        );
    }

    let planned = 0;
    let providerPollRecovered = 0;
    const byJobKind: Record<string, number> = {};
    for (const candidate of candidates as Candidate[]) {
      const item = parseCanonicalAcquisitionItemV1(candidate.payload);
      const runs = await tx
        .select({
          runId: contentAcquisitionRuns.runId,
          jobKind: contentAcquisitionRuns.jobKind,
          status: contentAcquisitionRuns.status,
          requestSnapshot: contentAcquisitionRuns.requestSnapshot,
          runMetrics: contentAcquisitionRuns.runMetrics,
          providerJobId: contentAcquisitionRuns.providerJobId,
          completedAt: contentAcquisitionRuns.completedAt,
          createdAt: contentAcquisitionRuns.createdAt,
        })
        .from(contentAcquisitionRuns)
        .where(eq(contentAcquisitionRuns.targetReceiptId, candidate.receiptId))
        .orderBy(desc(contentAcquisitionRuns.createdAt))
        .limit(20);
      if (runs.some((run) => ['PENDING', 'RUNNING'].includes(run.status))) continue;
      const failedProviderRun = runs.find(
        (run) =>
          run.jobKind === 'YOUTUBE_TRANSCRIPT' && run.providerJobId && run.status === 'FAILED',
      );
      if (failedProviderRun) {
        if (await recoverFailedProviderPoll(tx, failedProviderRun, dbNow)) {
          providerPollRecovered += 1;
        }
        continue;
      }
      const plan = planForCandidate({ candidate, item, runs, flags: input.flags, phase, dbNow });
      if (!plan) continue;
      const requestHash = sha256CanonicalJson(plan.request);
      const attemptNo = await nextAttemptNumber(tx, plan.request, requestHash);
      const runId = randomUUID();
      await tx.insert(contentAcquisitionRuns).values({
        runId,
        endpointId: candidate.endpointId,
        parentRunId: plan.parentRunId,
        targetReceiptId: candidate.receiptId,
        targetReceiptRevisionId: candidate.receiptRevisionId,
        jobKind: plan.request.jobKind,
        adapterKind: plan.request.adapterKind,
        profileKey: plan.request.profileKey,
        profileRevision: plan.request.profileRevision,
        windowStart: dbNow,
        windowEnd: dbNow,
        idempotencyKey: `briefing-planner:${requestHash}:${attemptNo}`,
        status: 'PENDING',
        requestSnapshot: plan.request,
        requestHash,
        sourceSnapshot: [
          {
            sourceId: candidate.sourceId,
            sourceKey: candidate.sourceKey,
            rightsPolicy: record(candidate.sourceRightsPolicy),
          },
        ],
        endpointSnapshot: endpointSnapshot(candidate),
        sourceSnapshotRevision: candidate.receiptRevisionId,
        attemptNo,
        evidenceMode: plan.evidenceMode,
      });
      const jobHash = createHash('sha256')
        .update(`${runId}\u001f${requestHash}\u001f${attemptNo}`, 'utf8')
        .digest('hex');
      await tx.insert(contentAcquisitionJobOutbox).values({
        outboxId: randomUUID(),
        runId,
        queueName: plan.queueName,
        jobId: `content-planner-${jobHash}`,
        priority: plan.priority,
        availableAt: dbNow,
      });
      planned += 1;
      byJobKind[plan.request.jobKind] = (byJobKind[plan.request.jobKind] ?? 0) + 1;
    }
    return {
      scanned: candidates.length,
      planned,
      reclaimed,
      providerPollRecovered,
      byJobKind,
    };
  });
}
