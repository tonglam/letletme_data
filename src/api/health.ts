import { redisSingleton } from '../cache/singleton';
import { databaseSingleton } from '../db/singleton';
import { queueRedisSingleton } from '../queues/redis';
import { seasonRepository } from '../repositories/seasons';
import { getConfig, isBugReportScreenshotStorageConfigured } from '../utils/config';
import { checkRuntimeHeartbeat, isRuntimeRoleRequired } from '../utils/runtime-heartbeat';
import { readActiveDataPublication } from '../cache/data-publication';
import { readLivePublicationV2 } from '../cache/live-publication-v2';
import { syncOperationsRepository } from '../repositories/sync-operations';
import { loadDataPublicationDelivery } from '../repositories/data-publication-outbox';
import { eventRepository } from '../repositories/events';
import { fixtureRepository } from '../repositories/fixtures';
import { readLivePublicationV2Checkpoint } from '../services/live-publication-v2-checkpoint.service';
import { readLiveCheckpointDesiredV2 } from '../cache/live-publication-v2';
import { LIVE_SCORE_CHECKPOINT_INTERVAL_MS } from '../domain/job-schedules';

export type ReadinessResult = {
  ready: boolean;
  dependencies: {
    postgres: boolean;
    cacheRedis: boolean;
    queueRedis: boolean;
    activeSeason: boolean;
    screenshotRetentionConfigured: boolean;
    scheduler?: boolean;
    queueWorker?: boolean;
    contentWorker?: boolean;
    mediaWorker?: boolean;
    livePicksWorker?: boolean;
    officialH2HWorker?: boolean;
    publicationConsistency?: boolean;
  };
};

type DependencyProbe = () => Promise<boolean>;
export const READINESS_PROBE_TIMEOUT_MS = 5000;

const postgresProbe: DependencyProbe = async () => {
  await databaseSingleton.connect();
  return databaseSingleton.healthCheck();
};

const cacheRedisProbe: DependencyProbe = async () => {
  await redisSingleton.connect();
  return redisSingleton.healthCheck();
};

const queueRedisProbe: DependencyProbe = () => queueRedisSingleton.healthCheck();

let lastKnownActiveSeasonCode: string | null = null;

async function activeSeasonFromRedis(): Promise<string | null> {
  const redis = await redisSingleton.getClient();
  if (lastKnownActiveSeasonCode) {
    const active = await readActiveDataPublication({
      dataset: 'fpl:core',
      seasonCode: lastKnownActiveSeasonCode,
    }).catch(() => null);
    if (active) return lastKnownActiveSeasonCode;
  }

  let cursor = '0';
  do {
    const [nextCursor, keys] = await redis.scan(
      cursor,
      'MATCH',
      'llm:data:fpl:core:*:active',
      'COUNT',
      '32',
    );
    cursor = nextCursor;
    for (const key of keys) {
      const match = key.match(/^llm:data:fpl:core:(\d{4}):active$/);
      if (!match) continue;
      const active = await readActiveDataPublication({
        dataset: 'fpl:core',
        seasonCode: match[1]!,
      }).catch(() => null);
      if (active) {
        lastKnownActiveSeasonCode = match[1]!;
        return lastKnownActiveSeasonCode;
      }
    }
  } while (cursor !== '0');
  return null;
}

const activeSeasonProbe: DependencyProbe = async () => {
  try {
    const season = await seasonRepository.findCurrent();
    if (/^\d{4}$/.test(season.seasonCode)) {
      lastKnownActiveSeasonCode = season.seasonCode;
      return true;
    }
  } catch {
    // Hot readiness must not disappear solely because PostgreSQL is degraded.
  }
  return (await activeSeasonFromRedis()) !== null;
};

const screenshotRetentionConfiguredProbe: DependencyProbe = async () => {
  const config = getConfig();
  return config.NODE_ENV !== 'production' || isBugReportScreenshotStorageConfigured(config);
};

const schedulerProbe: DependencyProbe = () => checkRuntimeHeartbeat('scheduler');
const queueWorkerProbe: DependencyProbe = () => checkRuntimeHeartbeat('queueWorker');
const contentWorkerProbe: DependencyProbe = () => checkRuntimeHeartbeat('contentWorker');
const mediaWorkerProbe: DependencyProbe = () => checkRuntimeHeartbeat('mediaWorker');
const livePicksWorkerProbe: DependencyProbe = () => checkRuntimeHeartbeat('livePicksWorker');
const officialH2HWorkerProbe: DependencyProbe = () => checkRuntimeHeartbeat('officialH2HWorker');

/**
 * Source-media is deployed independently because its worker performs external
 * Storage I/O during startup. The general Data release sets this flag to
 * false; the default keeps local and dedicated rollouts strict.
 */
export function isMediaWorkerRequired(): boolean {
  return isRuntimeRoleRequired('mediaWorker');
}

const PUBLICATION_MISMATCH_GRACE_MS = 120_000;
const publicationMismatchSince = new Map<string, number>();

/**
 * Mutable Live Points score revisions deliberately checkpoint at most once per
 * ten minutes. Give that obligation one normal coalescing interval plus the
 * existing execution margin, while keeping every other publication mismatch
 * on the strict two-minute boundary.
 */
export const publicationMismatchGraceMs = (key: string): number =>
  key.startsWith('live-points-v2:')
    ? LIVE_SCORE_CHECKPOINT_INTERVAL_MS + PUBLICATION_MISMATCH_GRACE_MS
    : PUBLICATION_MISMATCH_GRACE_MS;

/**
 * Keep a restarted API from granting a fresh grace window to an already-aged
 * Redis checkpoint obligation. The durable requestedAt is the earliest known
 * evidence for the mismatch; only an obligation without an evidence time may
 * start its grace window at the current process time.
 */
export const mismatchSinceForPublication = (
  existingSince: number | undefined,
  durableAnchor: number | undefined,
  now = Date.now(),
): number => {
  const safeNow = Number.isFinite(now) ? now : Date.now();
  const anchor = Number.isFinite(durableAnchor)
    ? Math.min(durableAnchor as number, safeNow)
    : safeNow;
  return Number.isFinite(existingSince) ? Math.min(existingSince as number, anchor) : anchor;
};

/**
 * The FPL event deadline can precede the first fixture kickoff by hours. A
 * missing Live Points publication is therefore expected until the fixture
 * cohort has actually started (or a publication/checkpoint obligation exists).
 * Keep this check tied to the current event's provider fixture state; a
 * scheduled kickoff alone is not start evidence.
 */
export const hasStartedOrFinishedFixture = (value: unknown, eventId: number): boolean => {
  if (!Array.isArray(value) || !Number.isInteger(eventId)) return false;
  return value.some((candidate) => {
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      return false;
    }
    const fixture = candidate as Record<string, unknown>;
    return (
      fixture.event === eventId &&
      (fixture.started === true ||
        fixture.finished === true ||
        fixture.finishedProvisional === true)
    );
  });
};

const publicationConsistencyProbe: DependencyProbe = async () => {
  const season = await seasonRepository.findCurrent();
  let consistent = true;
  let coreRedisActive: Awaited<ReturnType<typeof readActiveDataPublication>> = null;
  const currentEvent = await eventRepository.findCurrent(season);
  const scopes = [
    { dataset: 'fpl:core' as const, seasonCode: season.seasonCode, eventId: undefined },
    { dataset: 'fpl:market' as const, seasonCode: season.seasonCode, eventId: undefined },
  ];
  for (const scope of scopes) {
    const key = `${scope.dataset}:${season.seasonCode}:${scope.eventId ?? ''}`;
    const dbActive = await syncOperationsRepository.findActivePublication(
      scope.dataset,
      season,
      scope.eventId,
    );
    const redisActive = await readActiveDataPublication(scope);
    if (scope.dataset === 'fpl:core') coreRedisActive = redisActive;
    const durableEvidence = dbActive
      ? await loadDataPublicationDelivery(dbActive.publicationId).catch(() => null)
      : null;
    const matches =
      Boolean(dbActive) === Boolean(durableEvidence) &&
      Boolean(dbActive) === Boolean(redisActive) &&
      (!dbActive ||
        !redisActive ||
        (dbActive.publicationId === redisActive.manifest.publicationId &&
          dbActive.revision === redisActive.manifest.revision));
    if (!matches) {
      consistent = false;
      publicationMismatchSince.set(key, publicationMismatchSince.get(key) ?? Date.now());
      continue;
    }
    publicationMismatchSince.delete(key);
  }
  const currentEventBeforeDeadline = Boolean(
    currentEvent?.deadlineTimeEpoch !== null &&
      currentEvent?.deadlineTimeEpoch !== undefined &&
      currentEvent.deadlineTimeEpoch * 1000 > Date.now(),
  );
  const currentLiveKey =
    currentEvent && !currentEventBeforeDeadline
      ? `live-points-v2:${season.seasonCode}:${currentEvent.id}`
      : null;
  // This map is process-local diagnostic state. Remove old event scopes before
  // evaluating the grace window so a previous GW cannot keep deploy readiness
  // degraded after the current event has moved on.
  const liveKeyPrefix = `live-points-v2:${season.seasonCode}:`;
  for (const key of publicationMismatchSince.keys()) {
    if (key.startsWith(liveKeyPrefix) && key !== currentLiveKey) {
      publicationMismatchSince.delete(key);
    }
  }
  if (currentEvent && !currentEventBeforeDeadline) {
    const liveKey = currentLiveKey as string;
    const [redisLive, checkpointLive, desiredLive, canonicalFixtures] = await Promise.all([
      readLivePublicationV2({ season: season.seasonCode, eventId: currentEvent.id }).catch(
        () => null,
      ),
      readLivePublicationV2Checkpoint(season, currentEvent.id).catch(() => null),
      readLiveCheckpointDesiredV2({
        season: season.seasonCode,
        eventId: currentEvent.id,
      }).catch(() => null),
      fixtureRepository.findByEvent(season, currentEvent.id).catch(() => null),
    ]);
    // The FPL deadline is a picks cutoff, not the first kickoff. During the
    // gap between those moments event-live may legitimately return 503 while
    // the scheduler remains in PICKS_PROBE. Do not age that expected absence
    // into a deploy failure; once fixture state or a V2 obligation exists, the
    // normal publication/checkpoint fence below applies.
    const liveWindowStarted =
      hasStartedOrFinishedFixture(canonicalFixtures, currentEvent.id) ||
      hasStartedOrFinishedFixture(coreRedisActive?.items.fixtures, currentEvent.id);
    const liveConsistencyRequired = Boolean(
      redisLive || desiredLive || checkpointLive || liveWindowStarted || canonicalFixtures === null,
    );
    if (!liveConsistencyRequired) {
      publicationMismatchSince.delete(liveKey);
    } else {
      // A Redis-first publication may legitimately be ahead of PostgreSQL while
      // its merged checkpoint obligation is pending.  Once Redis marks a
      // publication checkpointed, however, both authorities must identify the
      // same immutable generation.
      // The desired pointer preserves the first outstanding obligation time.
      // Use it as the grace anchor so a new heartbeat/publication cannot keep a
      // broken checkpoint path green indefinitely. If the obligation pointer was
      // itself unavailable, the current publication is the only bounded anchor.
      const pendingCheckpointStartedAt = Date.parse(
        desiredLive?.requestedAt ?? redisLive?.publication.publishedAt ?? '',
      );
      const pendingCheckpointWithinGrace =
        Number.isFinite(pendingCheckpointStartedAt) &&
        Date.now() - pendingCheckpointStartedAt <= publicationMismatchGraceMs(liveKey);
      const liveMatches =
        Boolean(redisLive) &&
        redisLive !== null &&
        (redisLive.publication.checkpointedAt === null
          ? pendingCheckpointWithinGrace
          : checkpointLive !== null &&
            checkpointLive.publication.publicationId === redisLive.publication.publicationId &&
            checkpointLive.publication.generation === redisLive.publication.generation);
      if (!liveMatches) {
        consistent = false;
        publicationMismatchSince.set(
          liveKey,
          mismatchSinceForPublication(
            publicationMismatchSince.get(liveKey),
            pendingCheckpointStartedAt,
          ),
        );
      } else {
        publicationMismatchSince.delete(liveKey);
      }
    }
  }
  if (consistent) return true;
  const now = Date.now();
  return [...publicationMismatchSince.entries()].every(
    ([key, firstSeenAt]) => now - firstSeenAt <= publicationMismatchGraceMs(key),
  );
};

async function safeProbe(
  probe: DependencyProbe,
  timeoutMs = READINESS_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      probe(),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } catch {
    return false;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function checkReadiness(
  probes?: Partial<{
    postgres: DependencyProbe;
    cacheRedis: DependencyProbe;
    queueRedis: DependencyProbe;
    activeSeason: DependencyProbe;
    screenshotRetentionConfigured: DependencyProbe;
    scheduler: DependencyProbe;
    queueWorker: DependencyProbe;
    contentWorker: DependencyProbe;
    mediaWorker: DependencyProbe;
    livePicksWorker: DependencyProbe;
    officialH2HWorker: DependencyProbe;
    publicationConsistency: DependencyProbe;
    includeRuntimeDependencies: boolean;
    strict: boolean;
    probeTimeoutMs: number;
  }>,
): Promise<ReadinessResult> {
  const includeRuntimeDependencies = probes?.includeRuntimeDependencies === true;
  const strict = probes?.strict === true;
  const configured = {
    postgres: postgresProbe,
    cacheRedis: cacheRedisProbe,
    queueRedis: queueRedisProbe,
    activeSeason: activeSeasonProbe,
    screenshotRetentionConfigured: screenshotRetentionConfiguredProbe,
    scheduler: schedulerProbe,
    queueWorker: queueWorkerProbe,
    contentWorker: contentWorkerProbe,
    mediaWorker: mediaWorkerProbe,
    livePicksWorker: livePicksWorkerProbe,
    officialH2HWorker: officialH2HWorkerProbe,
    publicationConsistency: publicationConsistencyProbe,
    ...probes,
  };
  const probeTimeoutMs = probes?.probeTimeoutMs ?? READINESS_PROBE_TIMEOUT_MS;
  const [postgres, cacheRedis, queueRedis, activeSeason, screenshotRetentionConfigured] =
    await Promise.all([
      safeProbe(configured.postgres, probeTimeoutMs),
      safeProbe(configured.cacheRedis, probeTimeoutMs),
      safeProbe(configured.queueRedis, probeTimeoutMs),
      safeProbe(configured.activeSeason, probeTimeoutMs),
      safeProbe(configured.screenshotRetentionConfigured, probeTimeoutMs),
    ]);
  const baseDependencies = {
    postgres,
    cacheRedis,
    queueRedis,
    activeSeason,
    screenshotRetentionConfigured,
  };
  if (!includeRuntimeDependencies) {
    return {
      ready: strict
        ? postgres && cacheRedis && queueRedis && activeSeason && screenshotRetentionConfigured
        : cacheRedis && activeSeason,
      dependencies: baseDependencies,
    };
  }
  const [
    scheduler,
    queueWorker,
    contentWorker,
    mediaWorker,
    livePicksWorker,
    officialH2HWorker,
    publicationConsistency,
  ] = await Promise.all([
    safeProbe(configured.scheduler, probeTimeoutMs),
    safeProbe(configured.queueWorker, probeTimeoutMs),
    safeProbe(configured.contentWorker, probeTimeoutMs),
    safeProbe(configured.mediaWorker, probeTimeoutMs),
    safeProbe(configured.livePicksWorker, probeTimeoutMs),
    safeProbe(configured.officialH2HWorker, probeTimeoutMs),
    safeProbe(configured.publicationConsistency, probeTimeoutMs),
  ]);
  const mediaWorkerRequired = isMediaWorkerRequired();
  return {
    ready: strict
      ? postgres &&
        cacheRedis &&
        queueRedis &&
        activeSeason &&
        screenshotRetentionConfigured &&
        scheduler &&
        queueWorker &&
        contentWorker &&
        (!mediaWorkerRequired || mediaWorker) &&
        livePicksWorker &&
        officialH2HWorker &&
        publicationConsistency
      : cacheRedis && activeSeason,
    dependencies: {
      ...baseDependencies,
      scheduler,
      queueWorker,
      contentWorker,
      mediaWorker,
      livePicksWorker,
      officialH2HWorker,
      publicationConsistency,
    },
  };
}
