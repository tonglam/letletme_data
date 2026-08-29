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
import { syncOperationsRepository } from '../repositories/sync-operations';
import { allQueueNames } from '../queues/names';
import { getQueueConnection } from '../utils/queue';
import { checkRuntimeHeartbeat, readRuntimeHeartbeat } from '../utils/runtime-heartbeat';
import {
  schedulerObligationStatus,
  schedulerObligationSummary,
} from '../repositories/scheduler-obligations';
import { getSchedulerLaneTargets, listSchedulerLanes } from '../repositories/scheduler-lanes';
import { schedulerQueueLaneOverride, schedulerRegistry } from '../scheduler/job-registry';
import { eventRepository } from '../repositories/events';
import { getMyFplSnapshotOperationalStatus } from './my-fpl-snapshot-publication.service';
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
import { readPriceChangeHotSnapshotMetadata } from './price-change-hot.service';
import {
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

type SchedulerObligationLatest = NonNullable<
  Awaited<ReturnType<typeof schedulerObligationStatus>>['latest']
>;

/**
 * Keep the price-change operational summary useful without leaking the
 * persisted scheduler error text.  The detailed error belongs to the
 * protected governance case feed and is never part of `/jobs/status`.
 */
export function safeSchedulerObligationLatest(
  latest: SchedulerObligationLatest | null,
): (Omit<SchedulerObligationLatest, 'lastError'> & { lastErrorCode: string | null }) | null {
  if (!latest) return null;
  return {
    periodKey: latest.periodKey,
    status: latest.status,
    dueAt: latest.dueAt,
    generation: latest.generation,
    attempts: latest.attempts,
    lastErrorCode: safeSchedulerLaneErrorCode(latest.lastError),
  };
}

function asContext(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
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
    getMyFplSnapshotOperationalStatus(season),
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
      bulkMaxInflight: getConfig().FPL_BULK_MAX_INFLIGHT_DURING_LIVE,
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
  const currentEvent = await eventRepository.findCurrent(season);
  const publicationScopes = [
    { dataset: 'fpl:core' as const },
    { dataset: 'fpl:market' as const },
    { dataset: PRICE_CHANGE_DATASET },
    ...(currentEvent ? [{ dataset: 'fpl:live' as const, eventId: currentEvent.id }] : []),
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
        return {
          name,
          counts: await queue.getJobCounts(
            'waiting',
            'paused',
            'active',
            'delayed',
            'prioritized',
            'completed',
            'failed',
          ),
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
