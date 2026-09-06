import { Queue } from 'bullmq';

import {
  readActiveDataPublication,
  type DataPublicationDeliveryItem,
  type DataPublicationManifest,
  type DataPublicationReadResult,
} from '../cache/data-publication';
import { loadDataPublicationDelivery } from '../repositories/data-publication-outbox';
import {
  PRICE_CHANGE_DATASET,
  PRICE_CHANGE_MAX_AGE_MS,
  PRICE_CHANGE_READY_MS,
} from './price-change-predictions.service';
import { seasonRepository } from '../repositories/seasons';
import { eventRepository } from '../repositories/events';
import { syncOperationsRepository } from '../repositories/sync-operations';
import { allQueueNames } from '../queues/names';
import { getQueueConnection } from '../utils/queue';
import { checkRuntimeHeartbeat, readRuntimeHeartbeat } from '../utils/runtime-heartbeat';
import {
  liveFinalRetentionObligationStatuses,
  schedulerObligationRecoveryMatches,
  schedulerObligationStatus,
  schedulerObligationSummary,
} from '../repositories/scheduler-obligations';
import { getSchedulerLaneTargets, listSchedulerLanes } from '../repositories/scheduler-lanes';
import { schedulerQueueLaneOverride, schedulerRegistry } from '../scheduler/job-registry';
import {
  getActiveMyFplPublication,
  getActiveMyFplSnapshotRedisManifest,
  getMyFplSnapshotControlStatus,
  isMyFplSnapshotRedisManifestForPublication,
} from './my-fpl-snapshot-publication.service';
import { getTournamentReviewV2OperationalStatus } from './tournament-review-publication.service';
import { readSchedulerProgress, isSchedulerProgressHealthy } from '../scheduler/scheduler-progress';
import { readQueueAdmission, readQueueHealthSnapshot } from './queue-governance.service';
import {
  listFreshnessWindows,
  listGovernanceCases,
  listQueueHealthWindows,
  countGovernanceCases,
} from './data-governance.service';
import { dataContractRegistry, findDataContract } from '../domain/data-contracts';
import { MAINTENANCE_JOB_LANES } from '../jobs/maintenance.jobs';
import { getConfig } from '../utils/config';
import { calculateBurnRate } from '../domain/freshness-slo';
import { safePersistedDataErrorCode } from '../domain/error-classification';
import { CLIENT_SIGNAL_WINDOW_MS, getClientSignalSummary } from './client-signals.service';
import { resolveQueueHealthState } from './queue-governance.service';
import {
  effectiveLiveFinalRetentionTtl,
  LIVE_FINAL_RETENTION_CRITICAL_TTL_MS,
  LIVE_FINAL_RETENTION_EVIDENCE_SCHEMA_VERSION,
  LIVE_FINAL_RETENTION_LEASE_MS,
  LIVE_FINAL_RETENTION_POLICY_VERSION,
  LIVE_FINAL_RETENTION_PROOF_MAX_AGE_MS,
  LIVE_FINAL_RETENTION_RENEW_THRESHOLD_MS,
  LIVE_FINAL_RETENTION_STATUS_SCHEMA_VERSION,
} from '../domain/live-final-retention-policy';
import { readPriceChangeHotSnapshotMetadata } from './price-change-hot.service';
import {
  FPL_BULK_MAX_INFLIGHT_HARD_CAP,
  readFplAdmissionStats,
  readFplAdmissionTelemetry,
  type FplRequestPriority,
} from '../utils/fpl-admission';

type ActivePublication = Readonly<{ publicationId: string; revision: number }>;
type PublicationDelivery = Readonly<{
  manifest: DataPublicationManifest;
  items: readonly DataPublicationDeliveryItem[];
}>;

type PriceChangeContextSelection = Readonly<{
  context: Record<string, unknown> | null;
  publicationId: string | null;
  source: 'redis' | 'database' | 'none';
}>;

/**
 * `/jobs/status` is an operational aggregate, not an error-log endpoint.
 * Scheduler lane errors are persisted for the protected governance workflow,
 * but they can contain provider URLs, identifiers, or driver diagnostics.
 * Expose only a stable classification here; operators can use the separately
 * authenticated governance case endpoint for the redacted case metadata.
 */
export function safeSchedulerLaneErrorCode(lastError: string | null): string | null {
  return safePersistedDataErrorCode(lastError);
}

type QueueHealthSnapshot = Awaited<ReturnType<typeof readQueueHealthSnapshot>>;

const QUEUE_PAUSE_OWNER_STATES = new Set([
  'NONE',
  'DEPLOYMENT',
  'ACQUIRING',
  'OPERATOR',
  'RELEASING',
]);

function queuePauseEvidence(
  snapshot: QueueHealthSnapshot,
): Readonly<{ consumerPaused: boolean; pausedCount: number; pauseOwnerState: string }> | null {
  if (!snapshot) return null;
  const candidate = snapshot as unknown as Record<string, unknown>;
  return typeof candidate.consumerPaused === 'boolean' &&
    typeof candidate.pausedCount === 'number' &&
    Number.isSafeInteger(candidate.pausedCount) &&
    candidate.pausedCount >= 0 &&
    typeof candidate.pauseOwnerState === 'string' &&
    QUEUE_PAUSE_OWNER_STATES.has(candidate.pauseOwnerState)
    ? {
        consumerPaused: candidate.consumerPaused,
        pausedCount: candidate.pausedCount,
        pauseOwnerState: candidate.pauseOwnerState,
      }
    : null;
}

/** Keep direct Bull pause evidence visible when the richer monitor snapshot expired. */
export function resolveQueuePauseProjection(
  snapshot: QueueHealthSnapshot,
  bullPausedCount: number,
): Readonly<{ consumerPaused: boolean; pausedCount: number; pauseOwnerState: string }> {
  const directPausedCount =
    Number.isSafeInteger(bullPausedCount) && bullPausedCount >= 0 ? bullPausedCount : 0;
  const snapshotPause = queuePauseEvidence(snapshot);
  if (snapshotPause) {
    const pausedCount = Math.max(snapshotPause.pausedCount, directPausedCount);
    return {
      consumerPaused: snapshotPause.consumerPaused || pausedCount > 0,
      pausedCount,
      pauseOwnerState: snapshotPause.pauseOwnerState,
    };
  }
  return {
    consumerPaused: directPausedCount > 0,
    pausedCount: directPausedCount,
    pauseOwnerState: 'UNAVAILABLE',
  };
}

type SchedulerObligationLatest = NonNullable<
  Awaited<ReturnType<typeof schedulerObligationStatus>>['latest']
>;
type SchedulerObligationLatestInput = Pick<
  SchedulerObligationLatest,
  | 'obligationId'
  | 'periodKey'
  | 'status'
  | 'dueAt'
  | 'generation'
  | 'attempts'
  | 'lastError'
  | 'nextAttemptAt'
> &
  Partial<Pick<SchedulerObligationLatest, 'completedAt' | 'evidence'>>;

type SchedulerRecoverySummary = Readonly<{
  status: 'succeeded';
  recoveredAt: string;
  recoveryRevision: string;
  obligationId: string;
  periodKey: string;
  generation: number;
}>;

/**
 * Keep the operational scheduler summary useful without leaking persisted
 * error text or manual-recovery provenance. The detailed error, actor and
 * reason are never part of `/jobs/status`.
 */
export function safeSchedulerObligationLatest(latest: SchedulerObligationLatestInput | null):
  | (Omit<SchedulerObligationLatestInput, 'lastError' | 'completedAt' | 'evidence'> & {
      lastErrorCode: string | null;
      schedulerRecovery: SchedulerRecoverySummary | null;
    })
  | null {
  if (!latest) return null;
  const recovery = schedulerObligationRecoveryMatches(latest.evidence, {
    obligationId: latest.obligationId,
    periodKey: latest.periodKey,
    generation: latest.generation,
  });
  return {
    obligationId: latest.obligationId,
    periodKey: latest.periodKey,
    status: latest.status,
    dueAt: latest.dueAt,
    generation: latest.generation,
    attempts: latest.attempts,
    nextAttemptAt: latest.nextAttemptAt,
    lastErrorCode: safeSchedulerLaneErrorCode(latest.lastError),
    schedulerRecovery: recovery
      ? {
          status: recovery.status,
          recoveredAt: recovery.recoveredAt,
          recoveryRevision: recovery.recoveryRevision,
          obligationId: recovery.obligationId,
          periodKey: recovery.periodKey,
          generation: recovery.generation,
        }
      : null,
  };
}

function asContext(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

const LIVE_FINAL_RETENTION_FAMILIES = [
  'global',
  'matchDesk',
  'matchDetail',
  'entry',
  'league',
] as const;

function retentionFamilyStatus(value: unknown): Record<string, unknown> {
  const family = asContext(value);
  if (!family) {
    return { checked: 0, renewed: 0, restored: 0, failed: 0, minRemainingTtlMs: null };
  }
  const integer = (key: string): number =>
    typeof family[key] === 'number' && Number.isSafeInteger(family[key]) && family[key] >= 0
      ? family[key]
      : 0;
  const minRemainingTtlMs =
    typeof family.minRemainingTtlMs === 'number' && Number.isFinite(family.minRemainingTtlMs)
      ? family.minRemainingTtlMs
      : null;
  return {
    checked: integer('checked'),
    renewed: integer('renewed'),
    restored: integer('restored'),
    failed: integer('failed'),
    minRemainingTtlMs,
  };
}

function retentionDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function retentionNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

export function retentionEvidenceCountsAreCoherent(value: Record<string, unknown> | null): boolean {
  if (!value) return false;
  const families = asContext(value.families);
  const requiredArtifacts = value.requiredArtifacts;
  const failed = value.failed;
  if (
    !families ||
    typeof requiredArtifacts !== 'number' ||
    !Number.isSafeInteger(requiredArtifacts) ||
    requiredArtifacts <= 0 ||
    typeof failed !== 'number' ||
    !Number.isSafeInteger(failed) ||
    failed < 0
  ) {
    return false;
  }
  let checkedTotal = 0;
  let failedTotal = 0;
  for (const name of LIVE_FINAL_RETENTION_FAMILIES) {
    const family = asContext(families[name]);
    if (!family) return false;
    for (const key of ['checked', 'renewed', 'restored', 'failed'] as const) {
      if (
        typeof family[key] !== 'number' ||
        !Number.isSafeInteger(family[key]) ||
        family[key] < 0
      ) {
        return false;
      }
    }
    const checked = Number(family.checked);
    const familyFailed = Number(family.failed);
    if (checked > 0 && retentionNumber(family.minRemainingTtlMs) === null) return false;
    checkedTotal += checked;
    failedTotal += familyFailed;
  }
  return checkedTotal === requiredArtifacts && failedTotal === failed;
}

function agedRetentionFamilyStatus(
  value: unknown,
  observedAt: Date | null,
  now: Date,
): Record<string, unknown> {
  const family = retentionFamilyStatus(value);
  return {
    ...family,
    minRemainingTtlMs: effectiveLiveFinalRetentionTtl({
      observedTtlMs: retentionNumber(family.minRemainingTtlMs),
      observedAt,
      now,
    }),
  };
}

function emptyRetentionFamilies(): Record<string, Record<string, unknown>> {
  return Object.fromEntries(
    LIVE_FINAL_RETENTION_FAMILIES.map((family) => [
      family,
      { checked: 0, renewed: 0, restored: 0, failed: 0, minRemainingTtlMs: null },
    ]),
  );
}

function mergeRetentionFamilies(
  aggregate: Record<string, Record<string, unknown>>,
  families: Record<string, Record<string, unknown>>,
): void {
  for (const family of LIVE_FINAL_RETENTION_FAMILIES) {
    const target = aggregate[family]!;
    const source = families[family]!;
    for (const key of ['checked', 'renewed', 'restored', 'failed'] as const) {
      target[key] = Number(target[key] ?? 0) + Number(source[key] ?? 0);
    }
    const candidate = retentionNumber(source.minRemainingTtlMs);
    const current = retentionNumber(target.minRemainingTtlMs);
    target.minRemainingTtlMs =
      candidate === null ? current : current === null ? candidate : Math.min(current, candidate);
  }
}

export async function getLiveFinalRetentionOperationalStatus(
  season: Awaited<ReturnType<typeof seasonRepository.findCurrent>>,
): Promise<Record<string, unknown>> {
  const now = new Date();
  const checkedAt = now.toISOString();
  const finalizedEvents = (await eventRepository.findAll(season)).filter(
    (event) =>
      event.finished &&
      event.dataChecked &&
      event.dataCheckedAt !== null &&
      Number.isFinite(event.dataCheckedAt.getTime()),
  );
  const policy = {
    mode: 'ACTIVE_SEASON_ALL_FINALIZED',
    version: LIVE_FINAL_RETENTION_POLICY_VERSION,
    evidenceSchemaVersion: LIVE_FINAL_RETENTION_EVIDENCE_SCHEMA_VERSION,
    leaseTtlMs: LIVE_FINAL_RETENTION_LEASE_MS,
    renewThresholdMs: LIVE_FINAL_RETENTION_RENEW_THRESHOLD_MS,
    criticalTtlMs: LIVE_FINAL_RETENTION_CRITICAL_TTL_MS,
    proofMaxAgeMs: LIVE_FINAL_RETENTION_PROOF_MAX_AGE_MS,
    cadence: 'daily-per-finalized-event',
  };
  if (finalizedEvents.length === 0) {
    return {
      schemaVersion: LIVE_FINAL_RETENTION_STATUS_SCHEMA_VERSION,
      seasonCode: season.seasonCode,
      checkedAt,
      policy,
      state: 'NOT_APPLICABLE',
      coverage: {
        expectedFinalizedEvents: 0,
        certifiedEvents: 0,
        readyEvents: 0,
        warningEvents: 0,
        criticalEvents: 0,
        missingEventIds: [],
      },
      events: [],
      minRemainingTtlMs: null,
      oldestProofAt: null,
      families: emptyRetentionFamilies(),
      reasonCodes: ['NO_FINALIZED_EVENTS'],
    };
  }

  const scopeKeys = finalizedEvents.map((event) => `${season.seasonCode}:event:${event.id}`);
  const obligationByScope = await liveFinalRetentionObligationStatuses({
    scopeKeys,
    policyVersion: LIVE_FINAL_RETENTION_POLICY_VERSION,
    evidenceSchemaVersion: LIVE_FINAL_RETENTION_EVIDENCE_SCHEMA_VERSION,
    statementTimeoutMs: 1_500,
  });
  const aggregateFamilies = emptyRetentionFamilies();
  const eventStatuses = finalizedEvents.map((event) => {
    const scopeKey = `${season.seasonCode}:event:${event.id}`;
    const obligation = obligationByScope.get(scopeKey) ?? {
      latest: null,
      latestSuccess: null,
      firstSucceededAt: null,
      lastSucceededAt: null,
      overdue: false,
      consecutiveUnsuccessfulCycles: 0,
    };
    const latestRunEvidence = asContext(obligation.latest?.evidence);
    const latestRunRetention = asContext(latestRunEvidence?.retention);
    const latestSuccessEvidence = asContext(obligation.latestSuccess?.evidence);
    const latestSuccessRetention = asContext(latestSuccessEvidence?.retention);
    // Failed runs carry the bounded family evidence produced by the actual
    // pass. Surface that evidence instead of masking it with an older success.
    // A pending run has no result yet, so the latest success remains the best
    // current lease observation while the scheduler state is shown separately.
    const retention = latestRunRetention ?? latestSuccessRetention;
    const observedAt = retentionDate(retention?.checkedAt);
    const latestSuccessObservedAt = retentionDate(latestSuccessRetention?.checkedAt);
    const observedMinTtlMs = retentionNumber(retention?.minRemainingTtlMs);
    const minRemainingTtlMs = effectiveLiveFinalRetentionTtl({
      observedTtlMs: observedMinTtlMs,
      observedAt,
      now,
    });
    const familySource = asContext(retention?.families);
    const families = Object.fromEntries(
      LIVE_FINAL_RETENTION_FAMILIES.map((family) => [
        family,
        agedRetentionFamilyStatus(familySource?.[family], observedAt, now),
      ]),
    );
    mergeRetentionFamilies(aggregateFamilies, families);

    const evidenceMatchesContract = (value: Record<string, unknown> | null): boolean =>
      value !== null &&
      value.eventId === event.id &&
      value.schemaVersion === LIVE_FINAL_RETENTION_EVIDENCE_SCHEMA_VERSION &&
      value.policyVersion === LIVE_FINAL_RETENTION_POLICY_VERSION;
    const identityMismatch = retention !== null && retention.eventId !== event.id;
    const schemaMismatch = retention !== null && !evidenceMatchesContract(retention);
    const failed = retentionNumber(retention?.failed);
    const requiredArtifacts = retentionNumber(retention?.requiredArtifacts);
    const completeEvidence =
      retention !== null &&
      evidenceMatchesContract(retention) &&
      retentionEvidenceCountsAreCoherent(retention) &&
      retention.complete === true &&
      failed === 0 &&
      requiredArtifacts !== null &&
      requiredArtifacts > 0 &&
      observedAt !== null &&
      minRemainingTtlMs !== null;
    const latestSuccessMinTtlMs = effectiveLiveFinalRetentionTtl({
      observedTtlMs: retentionNumber(latestSuccessRetention?.minRemainingTtlMs),
      observedAt: latestSuccessObservedAt,
      now,
    });
    const latestSuccessProofAgeMs = latestSuccessObservedAt
      ? Math.max(0, now.getTime() - latestSuccessObservedAt.getTime())
      : null;
    const certified =
      latestSuccessRetention !== null &&
      evidenceMatchesContract(latestSuccessRetention) &&
      retentionEvidenceCountsAreCoherent(latestSuccessRetention) &&
      latestSuccessRetention.complete === true &&
      retentionNumber(latestSuccessRetention.failed) === 0 &&
      retentionNumber(latestSuccessRetention.requiredArtifacts) !== null &&
      retentionNumber(latestSuccessRetention.requiredArtifacts)! > 0 &&
      latestSuccessObservedAt !== null &&
      latestSuccessProofAgeMs !== null &&
      latestSuccessProofAgeMs <= LIVE_FINAL_RETENTION_PROOF_MAX_AGE_MS &&
      latestSuccessMinTtlMs !== null &&
      latestSuccessMinTtlMs >= LIVE_FINAL_RETENTION_CRITICAL_TTL_MS;
    const lastVerifiedAt = latestSuccessObservedAt ?? obligation.lastSucceededAt;
    const proofAgeMs = lastVerifiedAt
      ? Math.max(0, now.getTime() - lastVerifiedAt.getTime())
      : null;
    const latestFailed =
      obligation.latest?.status === 'failed' || obligation.latest?.status === 'irrecoverable';
    const critical =
      !completeEvidence ||
      latestFailed ||
      obligation.consecutiveUnsuccessfulCycles >= 2 ||
      minRemainingTtlMs === null ||
      minRemainingTtlMs < LIVE_FINAL_RETENTION_CRITICAL_TTL_MS ||
      proofAgeMs === null ||
      proofAgeMs > LIVE_FINAL_RETENTION_PROOF_MAX_AGE_MS;
    const warning =
      !critical &&
      (obligation.overdue || minRemainingTtlMs <= LIVE_FINAL_RETENTION_RENEW_THRESHOLD_MS);
    const state = critical ? 'CRITICAL' : warning ? 'WARNING' : 'READY';
    const reasonCodes = [
      ...(!retention ? ['RETENTION_RESULT_MISSING'] : []),
      ...(identityMismatch ? ['EVENT_IDENTITY_MISMATCH'] : []),
      ...(schemaMismatch ? ['RETENTION_EVIDENCE_SCHEMA_MISMATCH'] : []),
      ...(retention && retention.complete !== true ? ['RETENTION_INCOMPLETE'] : []),
      ...(retention && failed === null ? ['RETENTION_FAILED_COUNT_UNAVAILABLE'] : []),
      ...(failed !== null && failed > 0 ? ['RETENTION_PUBLICATION_FAILURE'] : []),
      ...(retention && requiredArtifacts === null ? ['RETENTION_ARTIFACT_COUNT_UNAVAILABLE'] : []),
      ...(requiredArtifacts === 0 ? ['RETENTION_ARTIFACT_SET_EMPTY'] : []),
      ...(minRemainingTtlMs === null ? ['RETENTION_TTL_UNAVAILABLE'] : []),
      ...(minRemainingTtlMs !== null && minRemainingTtlMs < LIVE_FINAL_RETENTION_CRITICAL_TTL_MS
        ? ['RETENTION_TTL_CRITICAL']
        : []),
      ...(minRemainingTtlMs !== null &&
      minRemainingTtlMs >= LIVE_FINAL_RETENTION_CRITICAL_TTL_MS &&
      minRemainingTtlMs <= LIVE_FINAL_RETENTION_RENEW_THRESHOLD_MS
        ? ['RETENTION_TTL_WARNING']
        : []),
      ...(proofAgeMs === null ? ['RETENTION_PROOF_TIMESTAMP_UNAVAILABLE'] : []),
      ...(proofAgeMs !== null && proofAgeMs > LIVE_FINAL_RETENTION_PROOF_MAX_AGE_MS
        ? ['RETENTION_PROOF_STALE']
        : []),
      ...(latestFailed ? ['RETENTION_LATEST_CYCLE_FAILED'] : []),
      ...(obligation.overdue ? ['RETENTION_JOB_OVERDUE'] : []),
      ...(obligation.consecutiveUnsuccessfulCycles >= 2
        ? ['RETENTION_TWO_UNSUCCESSFUL_CYCLES']
        : []),
    ];
    return {
      eventId: event.id,
      dataCheckedAt: event.dataCheckedAt!.toISOString(),
      state,
      firstCertifiedAt: obligation.firstSucceededAt?.toISOString() ?? null,
      lastVerifiedAt: lastVerifiedAt?.toISOString() ?? null,
      lastRunAt: observedAt?.toISOString() ?? obligation.latest?.completedAt?.toISOString() ?? null,
      proofAgeMs,
      leaseValidUntil:
        observedAt && observedMinTtlMs !== null
          ? new Date(observedAt.getTime() + observedMinTtlMs).toISOString()
          : null,
      minRemainingTtlMs,
      overdue: obligation.overdue,
      consecutiveUnsuccessfulCycles: obligation.consecutiveUnsuccessfulCycles,
      families,
      schedulerObligation: {
        scopeKey,
        latest: safeSchedulerObligationLatest(obligation.latest),
      },
      reasonCodes,
      certified,
    };
  });
  const readyEvents = eventStatuses.filter((event) => event.state === 'READY').length;
  const warningEvents = eventStatuses.filter((event) => event.state === 'WARNING').length;
  const criticalEvents = eventStatuses.filter((event) => event.state === 'CRITICAL').length;
  const certifiedEvents = eventStatuses.filter((event) => event.certified).length;
  const observedTtls = eventStatuses
    .map((event) => event.minRemainingTtlMs)
    .filter((value): value is number => value !== null);
  const proofTimes = eventStatuses
    .map((event) => retentionDate(event.lastVerifiedAt)?.getTime() ?? null)
    .filter((value): value is number => value !== null);
  const state = criticalEvents > 0 ? 'CRITICAL' : warningEvents > 0 ? 'WARNING' : 'READY';
  const missingEventIds = eventStatuses
    .filter((event) => !event.certified)
    .map((event) => event.eventId);
  return {
    schemaVersion: LIVE_FINAL_RETENTION_STATUS_SCHEMA_VERSION,
    seasonCode: season.seasonCode,
    checkedAt,
    policy,
    state,
    coverage: {
      expectedFinalizedEvents: finalizedEvents.length,
      certifiedEvents,
      readyEvents,
      warningEvents,
      criticalEvents,
      missingEventIds,
    },
    events: eventStatuses,
    minRemainingTtlMs: observedTtls.length > 0 ? Math.min(...observedTtls) : null,
    oldestProofAt: proofTimes.length > 0 ? new Date(Math.min(...proofTimes)).toISOString() : null,
    families: aggregateFamilies,
    schedulerObligation: {
      name: 'live-final-retention',
      cadence: schedulerRegistry.find((definition) => definition.name === 'live-final-retention')
        ?.cadence,
      criticality: schedulerRegistry.find(
        (definition) => definition.name === 'live-final-retention',
      )?.criticality,
    },
    reasonCodes: [...new Set(eventStatuses.flatMap((event) => event.reasonCodes))],
  };
}

function priceChangeEventSummary(
  context: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const event = asContext(context?.latestEvent);
  if (!event) return null;
  return {
    deadline: typeof event.deadline === 'string' ? event.deadline : null,
    changeDate: typeof event.changeDate === 'string' ? event.changeDate : null,
    observedAt: typeof event.observedAt === 'string' ? event.observedAt : null,
    outcome: typeof event.outcome === 'string' ? event.outcome : null,
    changedPlayerCount:
      typeof event.changedPlayerCount === 'number' ? event.changedPlayerCount : null,
  };
}

function readDeliveryContext(delivery: PublicationDelivery | null): Record<string, unknown> | null {
  const contextItem = delivery?.items.find((item) => item.manifest.name === 'context');
  if (!contextItem) return null;
  try {
    return asContext(JSON.parse(contextItem.payload));
  } catch {
    return null;
  }
}

function redisMatchesActivePublication(
  dbActive: ActivePublication | null,
  redisActive: Pick<DataPublicationReadResult, 'manifest'> | null,
): boolean {
  return Boolean(
    dbActive &&
      redisActive &&
      redisActive.manifest.publicationId === dbActive.publicationId &&
      redisActive.manifest.revision === dbActive.revision,
  );
}

export function selectCanonicalPriceChangeContext(input: {
  dbActive: ActivePublication | null;
  redisActive: DataPublicationReadResult | null;
  dbDelivery: PublicationDelivery | null;
}): PriceChangeContextSelection {
  if (redisMatchesActivePublication(input.dbActive, input.redisActive)) {
    return {
      context: asContext(input.redisActive?.items.context),
      publicationId: input.dbActive?.publicationId ?? null,
      source: 'redis',
    };
  }

  const databaseContext =
    input.dbActive &&
    input.dbDelivery?.manifest.dataset === PRICE_CHANGE_DATASET &&
    input.dbDelivery.manifest.publicationId === input.dbActive.publicationId &&
    input.dbDelivery.manifest.revision === input.dbActive.revision
      ? readDeliveryContext(input.dbDelivery)
      : null;
  if (databaseContext) {
    return {
      context: databaseContext,
      publicationId: input.dbActive?.publicationId ?? null,
      source: 'database',
    };
  }

  return {
    context: null,
    publicationId: input.dbActive?.publicationId ?? null,
    source: 'none',
  };
}

export type JobsStatusWindow = '15m' | '1h' | '6h' | '24h' | '3d' | '7d' | '28d';

export async function getJobsStatus(
  window: JobsStatusWindow = '1h',
  watchEntryId?: number,
): Promise<Record<string, unknown>> {
  const season = await seasonRepository.findCurrent();
  const windowMs: Record<JobsStatusWindow, number> = {
    '15m': 15 * 60_000,
    '1h': 60 * 60_000,
    '6h': 6 * 60 * 60_000,
    '24h': 24 * 60 * 60_000,
    '3d': 3 * 24 * 60 * 60_000,
    '7d': 7 * 24 * 60 * 60_000,
    '28d': 28 * 24 * 60 * 60_000,
  };
  const nowMs = Date.now();
  const since = new Date(nowMs - windowMs[window]);
  const clientSignalSince = new Date(
    Math.floor((nowMs - windowMs[window]) / CLIENT_SIGNAL_WINDOW_MS) * CLIENT_SIGNAL_WINDOW_MS,
  );
  // Include the current five-minute bucket, whose samples are still arriving,
  // while keeping both query boundaries aligned to stored window_start values.
  const clientSignalUntil = new Date(
    (Math.floor(nowMs / CLIENT_SIGNAL_WINDOW_MS) + 1) * CLIENT_SIGNAL_WINDOW_MS,
  );
  const [
    obligations,
    schedulerHeartbeat,
    queueWorkerHeartbeat,
    contentWorkerHeartbeat,
    mediaWorkerHeartbeat,
    livePicksWorkerHeartbeat,
    officialH2HWorkerHeartbeat,
    myFplSnapshots,
    tournamentReviewV2,
    schedulerProgress,
    freshnessWindows,
    governanceCases,
    queueHealthWindows,
    governanceCaseCount,
    clientSignals,
    priceChangeHotCursor,
  ] = await Promise.all([
    schedulerObligationSummary(),
    readRuntimeHeartbeat('scheduler'),
    readRuntimeHeartbeat('queueWorker'),
    readRuntimeHeartbeat('contentWorker'),
    readRuntimeHeartbeat('mediaWorker'),
    readRuntimeHeartbeat('livePicksWorker'),
    readRuntimeHeartbeat('officialH2HWorker'),
    // `/jobs/status` is a monitoring read path. It must use the bounded
    // control projection and never trigger the worker-only canonical scope
    // audit. Before scope generations are installed the projection marks
    // scope verification as UNVERIFIED; it must not claim COMPLETE.
    getMyFplSnapshotControlStatus(season),
    getTournamentReviewV2OperationalStatus(season, watchEntryId).catch(() => ({
      schemaVersion: 'my-tournament-review-v2.1' as const,
      metricVersion: 'settled-review-v2',
      season: season.seasonCode,
      checkedAt: new Date().toISOString(),
      eligibleCount: 0,
      stateCounts: { pending: 0, waitingSource: 0, processing: 0, ready: 0, degraded: 0 },
      publication: {
        readyWithCoherentHead: 0,
        readyWithIncoherentHead: 0,
        readyWithIncompleteChunks: 0,
      },
      oldestActiveEligibleAt: null,
      oldestDegradedAt: null,
      latestUpdatedAt: null,
      watch: null,
      unavailable: true,
    })),
    readSchedulerProgress(),
    // Query the requested SLO window at the database boundary. The table is
    // ordered by due time; fetching the first 500 rows without a lower bound
    // would silently drop the newest evidence after a high-volume live day.
    listFreshnessWindows({
      dueAfter: since,
      dueBefore: new Date(),
      // One row per queue/minute is expected. Keep the requested window
      // intact instead of returning an arbitrary first page on 28-day views.
      limit: Math.min(
        1_000_000,
        Math.max(5_000, allQueueNames.length * Math.ceil(windowMs[window] / 60_000) + 100),
      ),
    }).catch(() => []),
    listGovernanceCases({ limit: 100 }).catch(() => []),
    listQueueHealthWindows({
      since,
      // Raw one-minute samples are useful for short incident windows.  A
      // 28-day view is deliberately reduced to one SQL row per queue/hour so
      // the status endpoint cannot build a million-row JSON response.
      ...(['7d', '28d'].includes(window) ? { bucket: 'hour' as const } : {}),
      limit: ['7d', '28d'].includes(window)
        ? Math.min(100_000, allQueueNames.length * Math.ceil(windowMs[window] / 3_600_000) + 100)
        : Math.min(
            100_000,
            Math.max(1_000, allQueueNames.length * Math.ceil(windowMs[window] / 60_000) + 100),
          ),
    }).catch(() => []),
    countGovernanceCases().catch(() => 0),
    getClientSignalSummary(clientSignalSince, clientSignalUntil).catch(() => ({
      windowStart: clientSignalSince.toISOString(),
      windowEnd: clientSignalUntil.toISOString(),
      sampleCount: 0,
      groups: [],
      unavailable: true,
    })),
    readPriceChangeHotSnapshotMetadata(season.seasonCode).catch(() => null),
  ]);
  const [fplAdmissionStats, fplAdmissionTelemetry, fplUnattributedTelemetry] = await Promise.all([
    readFplAdmissionStats().catch(() => null),
    readFplAdmissionTelemetry().catch(() => null),
    readFplAdmissionTelemetry(Date.now(), 'unattributed').catch(() => null),
  ]);
  const fplAdmissionPriorities: readonly FplRequestPriority[] = [
    'deadline-critical',
    'live',
    'bulk',
  ];
  const fplAdmission = {
    policyVersion: fplAdmissionStats?.policyVersion ?? 'unavailable',
    hardCaps: {
      maxInflight: getConfig().FPL_MAX_INFLIGHT,
      criticalMaxInflight: 1,
      bulkMaxInflight: FPL_BULK_MAX_INFLIGHT_HARD_CAP,
      requestsPerSecond: getConfig().FPL_REQUESTS_PER_SECOND,
      tokenBucketCapacity: getConfig().FPL_REQUESTS_PER_SECOND,
      leaseMs: getConfig().FPL_ADMISSION_LEASE_MS,
    },
    current: fplAdmissionStats
      ? {
          tokens: fplAdmissionStats.tokens,
          inflight: fplAdmissionStats.inflight,
          liveInflight: fplAdmissionStats.liveInflight,
          criticalInflight: fplAdmissionStats.criticalInflight,
          bulkInflight: fplAdmissionStats.bulkInflight,
          adaptiveBulkMaxInflight: fplAdmissionStats.bulkMaxInflight,
          queued: fplAdmissionStats.queued,
          queuedByPriority: fplAdmissionStats.queuedByPriority,
          distributed: fplAdmissionStats.distributed,
        }
      : null,
    criticalWindow: fplAdmissionStats?.criticalWindow ?? null,
    byPriority: Object.fromEntries(
      fplAdmissionPriorities.map((priority) => {
        const telemetry = fplAdmissionTelemetry?.byPriority[priority];
        return [
          priority,
          {
            queued: fplAdmissionStats?.queuedByPriority[priority] ?? 0,
            inflight:
              priority === 'deadline-critical'
                ? (fplAdmissionStats?.criticalInflight ?? 0)
                : priority === 'live'
                  ? (fplAdmissionStats?.liveInflight ?? 0)
                  : (fplAdmissionStats?.bulkInflight ?? 0),
            waitP50Ms: telemetry?.waitP50Ms ?? null,
            waitP95Ms: telemetry?.waitP95Ms ?? null,
            waitP99Ms: telemetry?.waitP99Ms ?? null,
            waitSamples: telemetry?.waitSamples ?? 0,
            grants: telemetry?.grants ?? 0,
            deadlineExceeded: telemetry?.deadlineExceeded ?? 0,
            storeUnavailable: telemetry?.storeUnavailable ?? 0,
            cancelled: telemetry?.cancelled ?? 0,
            providerDurationP50Ms: telemetry?.providerDurationP50Ms ?? null,
            providerDurationP95Ms: telemetry?.providerDurationP95Ms ?? null,
            providerDurationP99Ms: telemetry?.providerDurationP99Ms ?? null,
            providerDurationSamples: telemetry?.providerDurationSamples ?? 0,
            responseSamples: telemetry?.responseSamples ?? 0,
            response429: telemetry?.response429 ?? 0,
            response5xx: telemetry?.response5xx ?? 0,
            networkErrors: telemetry?.networkErrors ?? 0,
          },
        ];
      }),
    ),
    provider: {
      responseSamples: fplAdmissionTelemetry?.responseSamples ?? 0,
      response429Rate: fplAdmissionTelemetry?.response429Rate ?? null,
      response5xxRate: fplAdmissionTelemetry?.response5xxRate ?? null,
      networkErrorRate: fplAdmissionTelemetry?.networkErrorRate ?? null,
    },
    unattributed: {
      waitSamples: fplUnattributedTelemetry?.waitSamples ?? 0,
      grants: fplUnattributedTelemetry?.grants ?? 0,
      deadlineExceeded: fplUnattributedTelemetry?.deadlineExceeded ?? 0,
      storeUnavailable: fplUnattributedTelemetry?.storeUnavailable ?? 0,
      cancelled: fplUnattributedTelemetry?.cancelled ?? 0,
      responseSamples: fplUnattributedTelemetry?.responseSamples ?? 0,
      response429: fplUnattributedTelemetry?.byPriority
        ? fplAdmissionPriorities.reduce(
            (sum, priority) =>
              sum + (fplUnattributedTelemetry.byPriority[priority]?.response429 ?? 0),
            0,
          )
        : 0,
    },
  };
  const scheduler = Boolean(schedulerHeartbeat && (await checkRuntimeHeartbeat('scheduler')));
  const queueWorker = Boolean(queueWorkerHeartbeat && (await checkRuntimeHeartbeat('queueWorker')));
  const contentWorker = Boolean(
    contentWorkerHeartbeat && (await checkRuntimeHeartbeat('contentWorker')),
  );
  const mediaWorker = Boolean(mediaWorkerHeartbeat && (await checkRuntimeHeartbeat('mediaWorker')));
  const livePicksWorker = Boolean(
    livePicksWorkerHeartbeat && (await checkRuntimeHeartbeat('livePicksWorker')),
  );
  const officialH2HWorker = Boolean(
    officialH2HWorkerHeartbeat && (await checkRuntimeHeartbeat('officialH2HWorker')),
  );
  const publicationConsistency: Record<string, boolean> = {};
  const publicationScopes = [
    { dataset: 'fpl:core' as const, eventId: undefined },
    { dataset: 'fpl:market' as const, eventId: undefined },
    { dataset: PRICE_CHANGE_DATASET, eventId: undefined },
  ];
  let priceChangeDbActive: Awaited<
    ReturnType<typeof syncOperationsRepository.findActivePublication>
  > = null;
  let priceChangeRedisActive: Awaited<ReturnType<typeof readActiveDataPublication>> = null;
  for (const scope of publicationScopes) {
    const dbActive = await syncOperationsRepository.findActivePublication(
      scope.dataset,
      season,
      scope.eventId,
    );
    const redisActive = await readActiveDataPublication({
      dataset: scope.dataset,
      seasonCode: season.seasonCode,
      ...(scope.eventId === undefined ? {} : { eventId: scope.eventId }),
    });
    if (scope.dataset === PRICE_CHANGE_DATASET) {
      priceChangeDbActive = dbActive;
      priceChangeRedisActive = redisActive;
    }
    const key = scope.eventId === undefined ? scope.dataset : `${scope.dataset}:e${scope.eventId}`;
    publicationConsistency[key] =
      Boolean(dbActive) === Boolean(redisActive) &&
      (!dbActive ||
        !redisActive ||
        (dbActive.publicationId === redisActive.manifest.publicationId &&
          dbActive.revision === redisActive.manifest.revision));
  }

  const priceChangeRedisMatches = redisMatchesActivePublication(
    priceChangeDbActive,
    priceChangeRedisActive,
  );
  const priceChangeDbDelivery =
    priceChangeDbActive && !priceChangeRedisMatches
      ? await loadDataPublicationDelivery(priceChangeDbActive.publicationId).catch(() => null)
      : null;
  const priceChangeSelection = selectCanonicalPriceChangeContext({
    dbActive: priceChangeDbActive,
    redisActive: priceChangeRedisActive,
    dbDelivery: priceChangeDbDelivery,
  });
  const priceChangeContext = priceChangeSelection.context;
  const fetchedAtValue =
    typeof priceChangeContext?.fetchedAt === 'string' ? priceChangeContext.fetchedAt : null;
  const fetchedAtMs = fetchedAtValue ? Date.parse(fetchedAtValue) : Number.NaN;
  const ageMs = Number.isFinite(fetchedAtMs) ? Math.max(0, Date.now() - fetchedAtMs) : null;
  const priceChangeStatus =
    ageMs === null
      ? 'UNAVAILABLE'
      : ageMs < PRICE_CHANGE_READY_MS
        ? 'READY'
        : ageMs < PRICE_CHANGE_MAX_AGE_MS
          ? 'STALE'
          : 'UNAVAILABLE';
  const latestEvent = priceChangeEventSummary(priceChangeContext);
  const priceChangeObligation = await schedulerObligationStatus({
    jobName: 'price-change-predictions',
    scopeKey: season.seasonCode,
  }).catch(() => ({
    latest: null,
    overdue: false,
    consecutiveUnsuccessfulCycles: 0,
  }));
  const priceChanges = {
    dataset: PRICE_CHANGE_DATASET,
    revision: priceChangeSelection.publicationId,
    fetchedAt: fetchedAtValue,
    ageSeconds: ageMs === null ? null : Math.floor(ageMs / 1000),
    expectedPlayerCount:
      typeof priceChangeContext?.expectedPlayerCount === 'number'
        ? priceChangeContext.expectedPlayerCount
        : 0,
    observedPlayerCount:
      typeof priceChangeContext?.observedPlayerCount === 'number'
        ? priceChangeContext.observedPlayerCount
        : 0,
    latestEvent,
    eventAgeSeconds: (() => {
      const observedAt =
        latestEvent && typeof latestEvent.observedAt === 'string'
          ? Date.parse(latestEvent.observedAt)
          : Number.NaN;
      return Number.isFinite(observedAt)
        ? Math.floor(Math.max(0, Date.now() - observedAt) / 1000)
        : null;
    })(),
    status: priceChangeStatus,
    dbRedisParity: publicationConsistency[PRICE_CHANGE_DATASET] ?? false,
    // A price-change obligation is a five-minute production lane. Two
    // consecutive unsuccessful cycles are overdue even when the latest row
    // is already terminally skipped rather than still pending/failed.
    overdue:
      priceChangeObligation.overdue || priceChangeObligation.consecutiveUnsuccessfulCycles >= 2,
    consecutiveUnsuccessfulCycles: priceChangeObligation.consecutiveUnsuccessfulCycles,
    schedulerObligation: {
      name: 'price-change-predictions',
      cadence: schedulerRegistry.find(
        (definition) => definition.name === 'price-change-predictions',
      )?.cadence,
      criticality: schedulerRegistry.find(
        (definition) => definition.name === 'price-change-predictions',
      )?.criticality,
      latest: safeSchedulerObligationLatest(priceChangeObligation.latest),
      summary: obligations,
    },
    hotWatch: {
      revision: priceChangeHotCursor?.revision ?? null,
      state:
        priceChangeHotCursor?.reconciliation.state === 'failed'
          ? 'FAILED'
          : priceChangeHotCursor?.reconciliation.state === 'reconciled'
            ? 'RECONCILED'
            : priceChangeHotCursor
              ? Date.now() - Date.parse(priceChangeHotCursor.fetchedAt) >= PRICE_CHANGE_READY_MS
                ? 'STALE'
                : 'PROVISIONAL'
              : 'NONE',
      detectedAt: priceChangeHotCursor?.detectedAt ?? null,
      fetchedAt: priceChangeHotCursor?.fetchedAt ?? null,
      expiresAt: priceChangeHotCursor?.expiresAt ?? null,
      reconciliationErrorCode: priceChangeHotCursor?.reconciliation.error
        ? safePersistedDataErrorCode(priceChangeHotCursor.reconciliation.error)
        : null,
      ageMs: priceChangeHotCursor
        ? Math.max(0, Date.now() - Date.parse(priceChangeHotCursor.detectedAt))
        : null,
    },
  };

  const eligibleWindows = freshnessWindows.filter((item) => item.status !== 'NOT_APPLICABLE');
  const burnByContract = Object.fromEntries(
    dataContractRegistry.map((contract) => {
      const windowsForContract = eligibleWindows.filter(
        (item) => item.contractKey === contract.contractKey,
      );
      const breached = windowsForContract.filter(
        (item) => item.status === 'BREACHED' || item.status === 'INVALID',
      ).length;
      return [
        contract.contractKey,
        {
          eligible: windowsForContract.length,
          breached,
          burnRate: calculateBurnRate(breached, windowsForContract.length),
        },
      ];
    }),
  );

  // `/jobs/status` is consumed by lightweight health tooling and must remain
  // safe to expose behind the service API key.  Keep the detailed governance
  // case feed on `/ops/data-governance/cases`; only return bounded aggregate
  // buckets here so a scope key (which may contain an entry identifier) or a
  // raw provider/error message can never leak through the status endpoint.
  const governanceCaseBuckets = new Map<
    string,
    {
      contractKey: string;
      lane: string;
      status: string;
      errorClass: string;
      errorCode: string;
      count: number;
    }
  >();
  for (const item of governanceCases) {
    const key = [item.contractKey, item.lane, item.status, item.errorClass, item.errorCode].join(
      '|',
    );
    const current = governanceCaseBuckets.get(key);
    if (current) {
      current.count += 1;
      continue;
    }
    governanceCaseBuckets.set(key, {
      contractKey: item.contractKey,
      lane: item.lane,
      status: item.status,
      errorClass: item.errorClass,
      errorCode: item.errorCode,
      count: 1,
    });
  }

  const liveFinalRetention = await getLiveFinalRetentionOperationalStatus(season).catch(() => ({
    schemaVersion: LIVE_FINAL_RETENTION_STATUS_SCHEMA_VERSION,
    seasonCode: season.seasonCode,
    checkedAt: new Date().toISOString(),
    policy: null,
    state: 'UNAVAILABLE',
    coverage: null,
    events: [],
    minRemainingTtlMs: null,
    oldestProofAt: null,
    families: emptyRetentionFamilies(),
    schedulerObligation: null,
    reasonCodes: ['RETENTION_STATUS_UNAVAILABLE'],
  }));

  const connection = getQueueConnection();
  const queues = await Promise.all(
    allQueueNames.map(async (name) => {
      const queue = new Queue(name, { connection });
      try {
        const healthSnapshot = await readQueueHealthSnapshot(name);
        const admission = await readQueueAdmission(name);
        // Optional content monitors report their actual state in the content
        // worker's shared Redis heartbeat. Never read the API process's env
        // here: a rollout can recreate content-worker without recreating API.
        const monitorState = contentWorkerHeartbeat?.queueMonitors?.[name];
        const healthState = resolveQueueHealthState({
          snapshot: healthSnapshot,
          monitorState,
        });
        const counts = await queue.getJobCounts(
          'waiting',
          'paused',
          'active',
          'delayed',
          'prioritized',
          'completed',
          'failed',
        );
        const pause = resolveQueuePauseProjection(healthSnapshot, counts.paused);
        return {
          name,
          counts,
          ...pause,
          health: healthSnapshot,
          healthState,
          monitorState: monitorState ?? null,
          admission,
        };
      } finally {
        await queue.close();
      }
    }),
  );
  const schedulerLanes = await Promise.all(
    (await listSchedulerLanes()).map(async (lane) => {
      const targets = await getSchedulerLaneTargets({ laneId: lane.laneId });
      const queue = new Queue(lane.queueName, { connection });
      let bullState: string | null = null;
      let bullTimestamp: number | null = null;
      try {
        if (lane.bullJobId) {
          const job = await queue.getJob(lane.bullJobId);
          bullState = job ? await job.getState() : 'missing';
          bullTimestamp = job?.timestamp ?? null;
        }
      } finally {
        await queue.close();
      }
      // The lane stores the immutable scheduled waterline. Obligation.dueAt
      // may be moved by retry/backoff and must not redefine the period.
      const desiredDueAt = lane.desiredDueAt;
      return {
        laneId: lane.laneId,
        laneKey: lane.laneKey,
        jobName: lane.jobName,
        scopeKey: lane.scopeKey,
        queueName: lane.queueName,
        state: lane.state,
        desiredPeriod: targets?.desired?.periodKey ?? null,
        desiredDueAt: desiredDueAt.toISOString(),
        activePeriod: targets?.active?.periodKey ?? null,
        bullJobId: lane.bullJobId,
        bullState,
        waitingMs: bullTimestamp === null ? null : Math.max(0, Date.now() - bullTimestamp),
        lastProgressAt: lane.lastProgressAt.toISOString(),
        progressAgeMs: Math.max(0, Date.now() - lane.lastProgressAt.getTime()),
        publicationLagMs: ageMs,
        generation: lane.dispatchGeneration,
        supersededCount: lane.supersededCount,
        blockerJobId: lane.blockerJobId,
        retryNotBefore: lane.retryNotBefore?.toISOString() ?? null,
        lastErrorCode: safeSchedulerLaneErrorCode(lane.lastError),
      };
    }),
  );
  const myFplTarget =
    [...myFplSnapshots]
      .filter(
        (snapshot) => snapshot.activeRevision !== null || snapshot.dataChecked || snapshot.finished,
      )
      .sort((left, right) => right.eventId - left.eventId)[0] ?? null;
  const [myFplFinalizationObligation, myFplPublication, myFplRedisManifest] = myFplTarget
    ? await Promise.all([
        schedulerObligationStatus({
          jobName: 'my-fpl-finalization',
          scopeKey: `${season.seasonCode}:event:${myFplTarget.eventId}`,
        }).catch(() => ({ latest: null, overdue: false, consecutiveUnsuccessfulCycles: 0 })),
        getActiveMyFplPublication(season, myFplTarget.eventId).catch(() => null),
        myFplTarget.activeRevision === null
          ? Promise.resolve(null)
          : getActiveMyFplSnapshotRedisManifest(season.seasonCode, myFplTarget.eventId).catch(
              () => null,
            ),
      ])
    : [{ latest: null, overdue: false, consecutiveUnsuccessfulCycles: 0 }, null, null];
  const myFplRedisParity = Boolean(
    myFplTarget &&
      isMyFplSnapshotRedisManifestForPublication(
        myFplRedisManifest,
        myFplPublication,
        season.seasonCode,
        myFplTarget.eventId,
      ),
  );
  const myFplIntegrity = myFplTarget
    ? {
        eventId: myFplTarget.eventId,
        settlementState: myFplTarget.settlementState,
        coverageState: myFplTarget.coverageState,
        timelinessState: myFplTarget.timelinessState,
        finalizationDueAt: myFplTarget.finalizationDueAt,
        activeRevision: myFplTarget.activeRevision,
        activeKind: myFplTarget.activeKind,
        activeContentSha256: myFplTarget.activeContentSha256,
        expectedEntryCount: myFplTarget.expectedEntryCount,
        observedEntryCount: myFplTarget.observedEntryCount,
        expectedTournamentCount: myFplTarget.expectedTournamentCount,
        observedTournamentCount: myFplTarget.observedTournamentCount,
        expectedEntryScopeSha256: myFplTarget.expectedEntryScopeSha256,
        observedEntryScopeSha256: myFplTarget.observedEntryScopeSha256,
        expectedTournamentScopeSha256: myFplTarget.expectedTournamentScopeSha256,
        observedTournamentScopeSha256: myFplTarget.observedTournamentScopeSha256,
        redisRevision: myFplRedisManifest?.revision ?? null,
        redisParity: myFplRedisParity,
        scopeVerification: myFplTarget.scopeVerification ?? 'UNVERIFIED',
        scopeGenerationInstalled: myFplTarget.scopeGenerationInstalled ?? false,
        scopeState: myFplTarget.scopeState ?? {
          entryDesired: null,
          entryVerified: null,
          tournamentDesired: null,
          tournamentVerified: null,
          entryDirtySince: null,
          tournamentDirtySince: null,
          verifiedRevision: null,
          state: 'UNAVAILABLE',
        },
        schedulerObligation: {
          latest: safeSchedulerObligationLatest(myFplFinalizationObligation.latest),
          overdue: myFplFinalizationObligation.overdue,
          consecutiveUnsuccessfulCycles: myFplFinalizationObligation.consecutiveUnsuccessfulCycles,
        },
      }
    : null;
  return {
    generatedAt: new Date().toISOString(),
    season: season.seasonCode,
    registry: schedulerRegistry.map((definition) => ({
      name: definition.name,
      cadence: definition.cadence,
      timezone: definition.timezone,
      catchUpPolicy: definition.catchUpPolicy,
      criticality: definition.criticality,
      queueName:
        getConfig().QUEUE_LANES_V2_ENABLED && definition.name === 'tournament-official-h2h-live'
          ? 'official-h2h-live'
          : getConfig().QUEUE_LANES_V2_ENABLED && schedulerQueueLaneOverride(definition.name)
            ? schedulerQueueLaneOverride(definition.name)
            : getConfig().QUEUE_LANES_V2_ENABLED && definition.queueName === 'maintenance'
              ? (MAINTENANCE_JOB_LANES[definition.name as keyof typeof MAINTENANCE_JOB_LANES] ??
                'maintenance')
              : definition.queueName,
      executionPolicy: definition.executionPolicy?.kind ?? null,
      successPredicate: definition.successPredicate,
      ...(() => {
        const contract = findDataContract(
          dataContractRegistry.find((item) =>
            (item.schedulerJobs as readonly string[]).includes(definition.name),
          )?.contractKey ?? '',
        );
        return {
          contractKey: contract?.contractKey,
          visibility: contract?.visibility ?? null,
          visibilityReason: contract?.visibilityReason ?? null,
        };
      })(),
    })),
    runtime: {
      scheduler: { healthy: scheduler, heartbeat: schedulerHeartbeat },
      queueWorker: { healthy: queueWorker, heartbeat: queueWorkerHeartbeat },
      livePicksWorker: { healthy: livePicksWorker, heartbeat: livePicksWorkerHeartbeat },
      officialH2HWorker: { healthy: officialH2HWorker, heartbeat: officialH2HWorkerHeartbeat },
      contentWorker: { healthy: contentWorker, heartbeat: contentWorkerHeartbeat },
      mediaWorker: { healthy: mediaWorker, heartbeat: mediaWorkerHeartbeat },
    },
    obligations,
    myFplSnapshots,
    myFplIntegrity,
    tournamentReviewV2,
    liveFinalRetention,
    publicationConsistency,
    fplAdmission,
    priceChanges,
    schedulerLanes,
    queues,
    schedulerProgress: {
      healthy: schedulerProgress ? isSchedulerProgressHealthy(schedulerProgress) : false,
      value: schedulerProgress,
    },
    window,
    queueHealthWindows,
    queueHealthWindowGranularity: ['7d', '28d'].includes(window) ? 'hour' : 'raw',
    errorBudgetBurn: {
      target: 0.99,
      eligible: eligibleWindows.length,
      breached: eligibleWindows.filter(
        (item) => item.status === 'BREACHED' || item.status === 'INVALID',
      ).length,
      burnRate: calculateBurnRate(
        eligibleWindows.filter((item) => item.status === 'BREACHED' || item.status === 'INVALID')
          .length,
        eligibleWindows.length,
      ),
      byContract: burnByContract,
    },
    freshness: {
      mode: getConfig().FRESHNESS_SLO_MODE,
      pending: freshnessWindows.filter((window) => window.status === 'PENDING').length,
      breached: freshnessWindows.filter((window) => window.status === 'BREACHED').length,
      invalid: freshnessWindows.filter((window) => window.status === 'INVALID').length,
      notApplicable: freshnessWindows.filter((window) => window.status === 'NOT_APPLICABLE').length,
      oldestPendingDueAt:
        freshnessWindows
          .filter((window) => window.status === 'PENDING')
          .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime())[0]?.dueAt ?? null,
    },
    governanceCases: [...governanceCaseBuckets.values()],
    governanceCaseCount,
    clientSignals,
    admissions: queues
      .filter((queue) => queue.admission)
      .map((queue) => ({ name: queue.name, admission: queue.admission })),
  };
}
