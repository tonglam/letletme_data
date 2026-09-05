import { sql } from 'drizzle-orm';
import { Queue } from 'bullmq';

import {
  readActiveDataPublicationManifest,
  type DataPublicationDataset,
  type DataPublicationManifest,
} from '../cache/data-publication';
import { getDb } from '../db/singleton';
import { queueRedisSingleton } from '../queues/redis';
import { createSeasonRepository, type FplSeasonRecord } from '../repositories/seasons';
import {
  schedulerObligationStatus,
  schedulerOrphanState,
} from '../repositories/scheduler-obligations';
import { allQueueNames } from '../queues/names';
import { getQueueConnection } from '../utils/queue';
import { createSyncOperationsRepository } from '../repositories/sync-operations';
import {
  isRuntimeHeartbeatHealthy,
  readRuntimeHeartbeat,
  type RuntimeHeartbeat,
  type RuntimeRole,
} from '../utils/runtime-heartbeat';
import { isSchedulerProgressHealthy, readSchedulerProgress } from '../scheduler/scheduler-progress';
import {
  getActiveMyFplPublication,
  getActiveMyFplSnapshotRedisManifest,
  getMyFplSnapshotControlStatus,
  isMyFplSnapshotRedisManifestForPublication,
} from './my-fpl-snapshot-publication.service';
import { getTournamentReviewV2OperationalStatus } from './tournament-review-publication.service';
import {
  getLiveFinalRetentionOperationalStatus,
  safeSchedulerObligationLatest,
  type JobsStatusWindow,
} from './jobs-status.service';
import { CLIENT_SIGNAL_WINDOW_MS, getClientSignalSummary } from './client-signals.service';
import { LIVE_FINAL_RETENTION_STATUS_SCHEMA_VERSION } from '../domain/live-final-retention-policy';
import {
  queueConsumerMetaKey,
  queueConsumerPauseOwnerState,
  readQueueConsumerPauseOwner,
} from './queue-governance.service';

export const JOBS_STATUS_SECTIONS = [
  'myFplIntegrity',
  'tournamentReviewV2',
  'liveFinalRetention',
  'clientSignals',
] as const;

export type JobsStatusSection = (typeof JOBS_STATUS_SECTIONS)[number];

const CONTROL_STATEMENT_TIMEOUT_MS = 2_000;
const TOURNAMENT_STATUS_STATEMENT_TIMEOUT_MS = 25_000;

const PUBLICATION_SCOPES: readonly Readonly<{
  dataset: DataPublicationDataset;
  eventId?: number;
}>[] = [{ dataset: 'fpl:core' }, { dataset: 'fpl:market' }, { dataset: 'fpl:price-changes' }];

type PublicationIdentity = Readonly<{
  publicationId: string;
  revision: number;
}> | null;

type ControlDatabaseState = Readonly<{
  season: FplSeasonRecord;
  publications: ReadonlyMap<DataPublicationDataset, PublicationIdentity>;
}>;

async function readControlDatabaseState(): Promise<ControlDatabaseState> {
  const db = await getDb();
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT set_config('statement_timeout', ${`${CONTROL_STATEMENT_TIMEOUT_MS}ms`}, true)`,
    );
    const season = await createSeasonRepository(tx).findCurrent();
    const publications = new Map<DataPublicationDataset, PublicationIdentity>();
    const repository = createSyncOperationsRepository(tx);
    for (const scope of PUBLICATION_SCOPES) {
      const active = await repository.findActivePublication(scope.dataset, season, scope.eventId);
      publications.set(
        scope.dataset,
        active ? { publicationId: active.publicationId, revision: active.revision } : null,
      );
    }
    return { season, publications };
  });
}

async function readPublicationIdentityParity(
  state: ControlDatabaseState,
): Promise<Record<string, boolean>> {
  const manifests = await Promise.all(
    PUBLICATION_SCOPES.map((scope) =>
      readActiveDataPublicationManifest({
        dataset: scope.dataset,
        seasonCode: state.season.seasonCode,
        ...(scope.eventId === undefined ? {} : { eventId: scope.eventId }),
      }),
    ),
  );
  return Object.fromEntries(
    PUBLICATION_SCOPES.map((scope, index) => {
      const database = state.publications.get(scope.dataset) ?? null;
      const redis = manifests[index] as DataPublicationManifest | null | undefined;
      return [
        scope.eventId === undefined ? scope.dataset : `${scope.dataset}:e${scope.eventId}`,
        Boolean(database) === Boolean(redis) &&
          (!database ||
            !redis ||
            (database.publicationId === redis.publicationId &&
              database.revision === redis.revision)),
      ];
    }),
  );
}

const RUNTIME_ROLES = [
  'scheduler',
  'queueWorker',
  'livePicksWorker',
  'officialH2HWorker',
  'contentWorker',
  'mediaWorker',
] as const satisfies readonly RuntimeRole[];

async function readRuntimeControlStatus(): Promise<
  Record<string, Readonly<{ healthy: boolean; heartbeat: RuntimeHeartbeat | null }>>
> {
  const heartbeats = await Promise.all(RUNTIME_ROLES.map((role) => readRuntimeHeartbeat(role)));
  return Object.fromEntries(
    RUNTIME_ROLES.map((role, index) => [
      role,
      {
        healthy: Boolean(heartbeats[index] && isRuntimeHeartbeatHealthy(heartbeats[index])),
        heartbeat: heartbeats[index] ?? null,
      },
    ]),
  );
}

async function readQueuePauseStatus(): Promise<readonly Record<string, unknown>[]> {
  const connection = getQueueConnection();
  return Promise.all(
    allQueueNames.map(async (name) => {
      const queue = new Queue(name, { connection });
      try {
        const redis = await queueRedisSingleton.getClient();
        const [counts, owner, pauseMarker] = await Promise.all([
          queue.getJobCounts('paused'),
          readQueueConsumerPauseOwner(name),
          redis.hget(queueConsumerMetaKey(name), 'paused'),
        ]);
        const pausedCount = counts.paused ?? 0;
        const ownerState = queueConsumerPauseOwnerState(owner);
        return {
          queueName: name,
          consumerPaused: pauseMarker === '1' || pausedCount > 0,
          pausedCount,
          pauseOwnerState: ownerState,
        };
      } finally {
        await queue.close();
      }
    }),
  );
}

async function readMyFplIntegrity(
  season: FplSeasonRecord,
): Promise<Record<string, unknown> | null> {
  const snapshots = await getMyFplSnapshotControlStatus(season);
  const target =
    [...snapshots]
      .filter(
        (snapshot) => snapshot.activeRevision !== null || snapshot.dataChecked || snapshot.finished,
      )
      .sort((left, right) => right.eventId - left.eventId)[0] ?? null;
  if (!target) return null;

  const [obligation, publication, redisManifest] = await Promise.all([
    schedulerObligationStatus({
      jobName: 'my-fpl-finalization',
      scopeKey: `${season.seasonCode}:event:${target.eventId}`,
      statementTimeoutMs: CONTROL_STATEMENT_TIMEOUT_MS,
    }).catch(() => ({ latest: null, overdue: true, consecutiveUnsuccessfulCycles: 0 })),
    getActiveMyFplPublication(season, target.eventId).catch(() => null),
    target.activeRevision === null
      ? Promise.resolve(null)
      : getActiveMyFplSnapshotRedisManifest(season.seasonCode, target.eventId).catch(() => null),
  ]);
  const redisParity = Boolean(
    isMyFplSnapshotRedisManifestForPublication(
      redisManifest,
      publication,
      season.seasonCode,
      target.eventId,
    ),
  );
  return {
    eventId: target.eventId,
    settlementState: target.settlementState,
    coverageState: target.coverageState,
    timelinessState: target.timelinessState,
    finalizationDueAt: target.finalizationDueAt,
    activeRevision: target.activeRevision,
    activeKind: target.activeKind,
    activeContentSha256: target.activeContentSha256,
    expectedEntryCount: target.expectedEntryCount,
    observedEntryCount: target.observedEntryCount,
    expectedTournamentCount: target.expectedTournamentCount,
    observedTournamentCount: target.observedTournamentCount,
    expectedEntryScopeSha256: target.expectedEntryScopeSha256,
    observedEntryScopeSha256: target.observedEntryScopeSha256,
    expectedTournamentScopeSha256: target.expectedTournamentScopeSha256,
    observedTournamentScopeSha256: target.observedTournamentScopeSha256,
    redisRevision: redisManifest?.revision ?? null,
    redisParity,
    scopeVerification: target.scopeVerification ?? 'UNVERIFIED',
    scopeGenerationInstalled: target.scopeGenerationInstalled ?? false,
    scopeState: target.scopeState ?? {
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
      latest: safeSchedulerObligationLatest(obligation.latest),
      overdue: obligation.overdue,
      consecutiveUnsuccessfulCycles: obligation.consecutiveUnsuccessfulCycles,
    },
  };
}

const WINDOW_MS: Record<JobsStatusWindow, number> = {
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '6h': 6 * 60 * 60_000,
  '24h': 24 * 60 * 60_000,
  '3d': 3 * 24 * 60 * 60_000,
  '7d': 7 * 24 * 60 * 60_000,
  '28d': 28 * 24 * 60 * 60_000,
};

async function readClientSignals(window: JobsStatusWindow): Promise<Record<string, unknown>> {
  const nowMs = Date.now();
  const since = new Date(
    Math.floor((nowMs - WINDOW_MS[window]) / CLIENT_SIGNAL_WINDOW_MS) * CLIENT_SIGNAL_WINDOW_MS,
  );
  const until = new Date(
    (Math.floor(nowMs / CLIENT_SIGNAL_WINDOW_MS) + 1) * CLIENT_SIGNAL_WINDOW_MS,
  );
  return getClientSignalSummary(since, until).catch(() => ({
    windowStart: since.toISOString(),
    windowEnd: until.toISOString(),
    sampleCount: 0,
    groups: [],
    unavailable: true,
  }));
}

/**
 * Lightweight, sectioned control projection for the frequent `/jobs/status`
 * probes. The default response reads only current identities and heartbeats.
 * Historical SLO windows, governance cases, queue history, full publication
 * payloads and semantic tournament audits remain on the explicit governance
 * endpoint and are never reached by this function.
 */
export async function getJobsControlStatus(
  window: JobsStatusWindow = '1h',
  section?: JobsStatusSection,
  watchEntryId?: number,
): Promise<Record<string, unknown>> {
  const [databaseState, runtime, schedulerProgress, queuePause, orphanState] = await Promise.all([
    readControlDatabaseState(),
    readRuntimeControlStatus(),
    readSchedulerProgress(),
    readQueuePauseStatus(),
    schedulerOrphanState(),
  ]);
  const publicationConsistency = await readPublicationIdentityParity(databaseState);
  const base: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    season: databaseState.season.seasonCode,
    window,
    section: section ?? 'control',
    runtime,
    publicationConsistency,
    publicationConsistencyMode: 'IDENTITY_ONLY',
    schedulerProgress: {
      healthy: schedulerProgress ? isSchedulerProgressHealthy(schedulerProgress) : false,
      value: schedulerProgress,
    },
    queuePause,
    obligations: orphanState,
  };

  switch (section) {
    case undefined:
      return base;
    case 'myFplIntegrity':
      return {
        ...base,
        myFplIntegrity: await readMyFplIntegrity(databaseState.season).catch(() => null),
      };
    case 'tournamentReviewV2':
      return {
        ...base,
        tournamentReviewV2: await getTournamentReviewV2OperationalStatus(
          databaseState.season,
          watchEntryId,
          new Date(),
          { statementTimeoutMs: TOURNAMENT_STATUS_STATEMENT_TIMEOUT_MS },
        ).catch(() => ({
          schemaVersion: 'my-tournament-review-v2.1',
          metricVersion: 'settled-review-v2',
          season: databaseState.season.seasonCode,
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
      };
    case 'liveFinalRetention':
      return {
        ...base,
        liveFinalRetention: await getLiveFinalRetentionOperationalStatus(
          databaseState.season,
        ).catch(() => ({
          schemaVersion: LIVE_FINAL_RETENTION_STATUS_SCHEMA_VERSION,
          seasonCode: databaseState.season.seasonCode,
          checkedAt: new Date().toISOString(),
          policy: null,
          state: 'UNAVAILABLE',
          coverage: null,
          events: [],
          minRemainingTtlMs: null,
          oldestProofAt: null,
          families: {},
          schedulerObligation: null,
          reasonCodes: ['RETENTION_STATUS_UNAVAILABLE'],
        })),
      };
    case 'clientSignals':
      return { ...base, clientSignals: await readClientSignals(window) };
  }
}
