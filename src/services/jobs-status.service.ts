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
import { schedulerRegistry } from '../scheduler/job-registry';
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
import { dataContractRegistry } from '../domain/data-contracts';
import { MAINTENANCE_JOB_LANES } from '../jobs/maintenance.jobs';
import { getConfig } from '../utils/config';
import { calculateBurnRate } from '../domain/freshness-slo';

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

function asContext(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
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

export type JobsStatusWindow = '1h' | '6h' | '3d' | '28d';

export async function getJobsStatus(
  window: JobsStatusWindow = '1h',
): Promise<Record<string, unknown>> {
  const season = await seasonRepository.findCurrent();
  const windowMs: Record<JobsStatusWindow, number> = {
    '1h': 60 * 60_000,
    '6h': 6 * 60 * 60_000,
    '3d': 3 * 24 * 60 * 60_000,
    '28d': 28 * 24 * 60 * 60_000,
  };
  const since = new Date(Date.now() - windowMs[window]);
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
      limit: Math.min(
        1_000_000,
        Math.max(1_000, allQueueNames.length * Math.ceil(windowMs[window] / 60_000) + 100),
      ),
    }).catch(() => []),
    countGovernanceCases().catch(() => 0),
  ]);
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
        : ageMs <= PRICE_CHANGE_MAX_AGE_MS
          ? 'STALE'
          : 'UNAVAILABLE';
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
    status: priceChangeStatus,
    dbRedisParity: publicationConsistency[PRICE_CHANGE_DATASET] ?? false,
    overdue: priceChangeObligation.overdue,
    consecutiveUnsuccessfulCycles: priceChangeObligation.consecutiveUnsuccessfulCycles,
    schedulerObligation: {
      name: 'price-change-predictions',
      cadence: schedulerRegistry.find(
        (definition) => definition.name === 'price-change-predictions',
      )?.cadence,
      criticality: schedulerRegistry.find(
        (definition) => definition.name === 'price-change-predictions',
      )?.criticality,
      latest: priceChangeObligation.latest,
      summary: obligations,
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
        lastError: lane.lastError,
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
          : getConfig().QUEUE_LANES_V2_ENABLED && definition.queueName === 'maintenance'
            ? (MAINTENANCE_JOB_LANES[definition.name as keyof typeof MAINTENANCE_JOB_LANES] ??
              'maintenance')
            : definition.queueName,
      executionPolicy: definition.executionPolicy?.kind ?? null,
      successPredicate: definition.successPredicate,
      contractKey: dataContractRegistry.find((contract) =>
        (contract.schedulerJobs as readonly string[]).includes(definition.name),
      )?.contractKey,
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
    priceChanges,
    schedulerLanes,
    queues,
    schedulerProgress: {
      healthy: schedulerProgress ? isSchedulerProgressHealthy(schedulerProgress) : false,
      value: schedulerProgress,
    },
    window,
    queueHealthWindows,
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
    admissions: queues
      .filter((queue) => queue.admission)
      .map((queue) => ({ name: queue.name, admission: queue.admission })),
  };
}
