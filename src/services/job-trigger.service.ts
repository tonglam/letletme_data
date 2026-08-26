import {
  enqueueCoreSnapshotJob,
  enqueuePlayerPricesSyncJob,
  enqueuePlayerStatsSyncJob,
  enqueuePlayerValuesSyncJob,
  enqueuePriceChangePredictionsJob,
} from '../jobs/data-sync-enqueue';
import {
  enqueueEntryInfoSyncJob,
  enqueueEntryPicksSyncJob,
  enqueueEntryTransfersSyncJob,
} from '../jobs/entry-sync-enqueue';
import { runManualEventCurrentRefresh } from '../jobs/event-current-refresh.job';
import { runLeagueEventResultsSync } from '../jobs/league-event-results.jobs';
import { enqueueLiveSnapshot } from '../jobs/live-data.jobs';
import { runPostMatchConsolidation } from '../jobs/live.jobs';
import { runTournamentEventResultsSync } from '../jobs/tournament-event-results.jobs';
import { runTournamentInfoSync } from '../jobs/tournament-info.jobs';
import { getCurrentEvent } from './events.service';
import { eventRepository } from '../repositories/events';
import { seasonRepository } from '../repositories/seasons';
import { refreshTournamentMaterializedViews } from './tournament-materialized-views.service';
import { syncTournamentSelectionStats } from './tournament-selection-stats.service';
import { logInfo } from '../utils/logger';
import { ValidationError } from '../utils/errors';
import { schedulerRegistry } from '../scheduler/job-registry';
import { triggerPriceChangeLane } from '../scheduler/scheduler.service';
import {
  enqueueBugReportCleanup,
  enqueueBugReportScreenshotRetention,
  enqueueLaunchMonitor,
  enqueuePlayerMarketFreshness,
  enqueuePlayerSeasonSummaryRepair,
  enqueuePostMatchConsolidation,
  enqueueMyFplSnapshot,
  enqueueMyFplSnapshotOutbox,
  enqueueTournamentTrendsRepair,
} from '../jobs/maintenance.jobs';
import { MAINTENANCE_JOBS } from '../queues/maintenance.queue';

export type TriggerableJobInfo = {
  name: string;
  description: string;
  schedule: string;
};

export class JobNotFoundError extends Error {
  constructor(name: string) {
    super(`Job '${name}' not found`);
    this.name = 'JobNotFoundError';
  }
}

export type JobTriggerResult =
  | {
      kind: 'event-current-refresh';
      refreshed: boolean;
      eventsSyncJobId?: string;
      message: string;
    }
  | {
      kind: 'enqueued';
      jobId: string | number | undefined;
      message: string;
    }
  | {
      kind: 'pending';
      jobId?: string | number;
      message: string;
    }
  | {
      kind: 'executed';
      message: string;
    };

/**
 * Manual names kept for API compatibility with older clients. The scheduler
 * registry is the only source of truth for cadence and catch-up semantics;
 * aliases deliberately expose no second copy of those schedules.
 */
const COMPATIBILITY_MANUAL_ALIASES: TriggerableJobInfo[] = [
  'core-snapshot-sync',
  'event-current-refresh',
  'player-prices',
  'player-stats-sync',
  'player-values-sync',
  'entry-info-daily',
  'entry-event-results-daily',
  'league-event-results-sync',
  'tournament-event-results-sync',
  'tournament-selection-stats-sync',
  'tournament-info-sync',
  'tournament-materialized-views-refresh',
].map((name) => ({
  name,
  description: `Manual compatibility alias for ${name}`,
  schedule: 'manual compatibility alias; schedule is owned by the registry',
}));

function requirePlayerPricesChangeDate(input: unknown): string {
  const changeDate =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>).changeDate
      : undefined;
  if (typeof changeDate !== 'string' || !/^\d{8}$/.test(changeDate)) {
    throw new ValidationError(
      'Job player-prices requires a changeDate in YYYYMMDD format',
      'PLAYER_PRICES_CHANGE_DATE_REQUIRED',
    );
  }
  return changeDate;
}

function readMarketSourceDay(input: unknown): string | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError(
      'Market daily input must be an object with sourceDay in YYYYMMDD format',
      'MARKET_SOURCE_DAY_INVALID',
    );
  }
  const value = input as Record<string, unknown>;
  const sourceDay = value.sourceDay ?? value.changeDate;
  if (sourceDay === undefined) return undefined;
  if (typeof sourceDay !== 'string' || !/^\d{8}$/.test(sourceDay)) {
    throw new ValidationError(
      'Market daily sourceDay must use YYYYMMDD format',
      'MARKET_SOURCE_DAY_INVALID',
    );
  }
  return sourceDay;
}

type MyFplManualSnapshotInput = {
  eventId?: number;
  snapshotKind?: 'PROVISIONAL' | 'FINAL';
  snapshotActor?: string;
  snapshotReason?: string;
  snapshotIdempotencyKey?: string;
};

function readMyFplManualSnapshotInput(input: unknown): MyFplManualSnapshotInput {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError(
      'My FPL snapshot input must be an object',
      'MY_FPL_SNAPSHOT_INPUT_INVALID',
    );
  }
  const value = input as Record<string, unknown>;
  const eventId = value.eventId;
  if (eventId !== undefined && (!Number.isSafeInteger(eventId) || Number(eventId) <= 0)) {
    throw new ValidationError(
      'My FPL snapshot eventId must be a positive integer',
      'MY_FPL_SNAPSHOT_EVENT_INVALID',
    );
  }
  const snapshotKind = value.snapshotKind ?? 'PROVISIONAL';
  if (snapshotKind !== 'PROVISIONAL' && snapshotKind !== 'FINAL') {
    throw new ValidationError(
      'My FPL snapshotKind must be PROVISIONAL or FINAL',
      'MY_FPL_SNAPSHOT_KIND_INVALID',
    );
  }
  const readText = (key: string): string | undefined => {
    const candidate = value[key];
    if (candidate === undefined) return undefined;
    if (typeof candidate !== 'string' || candidate.trim() === '') {
      throw new ValidationError(
        `My FPL ${key} must be a non-empty string`,
        'MY_FPL_SNAPSHOT_OVERRIDE_INVALID',
      );
    }
    return candidate.trim();
  };
  const result = {
    ...(eventId === undefined ? {} : { eventId: eventId as number }),
    snapshotKind,
    ...(readText('snapshotActor') ? { snapshotActor: readText('snapshotActor') } : {}),
    ...(readText('snapshotReason') ? { snapshotReason: readText('snapshotReason') } : {}),
    ...(readText('snapshotIdempotencyKey')
      ? { snapshotIdempotencyKey: readText('snapshotIdempotencyKey') }
      : {}),
  } satisfies MyFplManualSnapshotInput;
  const overrideKeys = [
    result.snapshotActor,
    result.snapshotReason,
    result.snapshotIdempotencyKey,
  ].filter((candidate) => candidate !== undefined);
  if (overrideKeys.length > 0 && (snapshotKind !== 'FINAL' || overrideKeys.length !== 3)) {
    throw new ValidationError(
      'My FPL final override requires snapshotActor, snapshotReason, and snapshotIdempotencyKey',
      'MY_FPL_SNAPSHOT_OVERRIDE_INVALID',
    );
  }
  return result;
}

function requireManualFinalOverride(input: MyFplManualSnapshotInput): void {
  if (
    input.snapshotKind === 'FINAL' &&
    (!input.snapshotActor || !input.snapshotReason || !input.snapshotIdempotencyKey)
  ) {
    throw new ValidationError(
      'Manual My FPL FINAL requires snapshotActor, snapshotReason, and snapshotIdempotencyKey',
      'MY_FPL_SNAPSHOT_OVERRIDE_REQUIRED',
    );
  }
}

function buildJobMap(input?: unknown): Record<string, () => Promise<unknown>> {
  return {
    'event-current-refresh': () => runManualEventCurrentRefresh(),
    'core-current-reconcile': () => runManualEventCurrentRefresh(),
    'core-snapshot-sync': async () => {
      const season = await seasonRepository.findCurrent();
      return enqueueCoreSnapshotJob(season, 'manual');
    },
    'core-snapshot': async () => {
      const season = await seasonRepository.findCurrent();
      return enqueueCoreSnapshotJob(season, 'manual');
    },
    'player-prices': async () => {
      const season = await seasonRepository.findCurrent();
      return enqueuePlayerPricesSyncJob(season, 'manual', {
        changeDate: requirePlayerPricesChangeDate(input),
      });
    },
    'player-stats-sync': async () => {
      const season = await seasonRepository.findCurrent();
      return enqueuePlayerStatsSyncJob(season, 'manual');
    },
    'player-season-summary-repair': async () => {
      const season = await seasonRepository.findCurrent();
      return enqueuePlayerSeasonSummaryRepair(season, 'manual');
    },
    [MAINTENANCE_JOBS.PLAYER_MARKET_FRESHNESS]: async () => {
      const season = await seasonRepository.findCurrent();
      return enqueuePlayerMarketFreshness(season, 'manual');
    },
    [MAINTENANCE_JOBS.TOURNAMENT_TRENDS]: async () => {
      const season = await seasonRepository.findCurrent();
      return enqueueTournamentTrendsRepair(season, 'manual');
    },
    [MAINTENANCE_JOBS.BUG_REPORT_CLEANUP]: async () => {
      const season = await seasonRepository.findCurrent();
      return enqueueBugReportCleanup(season, 'manual');
    },
    [MAINTENANCE_JOBS.BUG_REPORT_SCREENSHOT_RETENTION]: async () => {
      const season = await seasonRepository.findCurrent();
      return enqueueBugReportScreenshotRetention(season, 'manual');
    },
    [MAINTENANCE_JOBS.LAUNCH_MONITOR]: async () => {
      const season = await seasonRepository.findCurrent();
      return enqueueLaunchMonitor(season, 'manual');
    },
    [MAINTENANCE_JOBS.POST_MATCH_CONSOLIDATION]: async () => {
      const season = await seasonRepository.findCurrent();
      return enqueuePostMatchConsolidation(season, 'manual');
    },
    'player-values-sync': async () => {
      const season = await seasonRepository.findCurrent();
      return enqueuePlayerValuesSyncJob(season, 'manual', {
        changeDate: readMarketSourceDay(input),
      });
    },
    'market-daily': async () => {
      const season = await seasonRepository.findCurrent();
      return enqueuePlayerValuesSyncJob(season, 'manual', {
        changeDate: readMarketSourceDay(input),
      });
    },
    'player-stats': async () => {
      const season = await seasonRepository.findCurrent();
      return enqueuePlayerStatsSyncJob(season, 'manual');
    },
    'price-change-predictions': async () => {
      if (
        schedulerRegistry.find((definition) => definition.name === 'price-change-predictions')
          ?.executionPolicy
      ) {
        return triggerPriceChangeLane();
      }
      const season = await seasonRepository.findCurrent();
      return enqueuePriceChangePredictionsJob(season, 'manual');
    },
    'entry-info-daily': async () => {
      const season = await seasonRepository.findCurrent();
      const targetEventId = (await eventRepository.findLatestFinalized(season))?.id ?? 0;
      return enqueueEntryInfoSyncJob(season, 'manual', { eventId: targetEventId });
    },
    'entry-event-results-daily': async () => {
      const season = await seasonRepository.findCurrent();
      const requested = readMyFplManualSnapshotInput(input);
      requireManualFinalOverride(requested);
      const currentEvent = requested.eventId
        ? await eventRepository.findById(season, requested.eventId)
        : await getCurrentEvent(season);
      if (!currentEvent) {
        throw new Error('No current event found');
      }
      return enqueueMyFplSnapshot(season, 'manual', {
        eventId: currentEvent.id,
        snapshotKind: requested.snapshotKind ?? 'PROVISIONAL',
        jobId: `manual-entry-event-results-daily-${currentEvent.id}-${Date.now()}`,
        ...(requested.snapshotActor ? { snapshotActor: requested.snapshotActor } : {}),
        ...(requested.snapshotReason ? { snapshotReason: requested.snapshotReason } : {}),
        ...(requested.snapshotIdempotencyKey
          ? { snapshotIdempotencyKey: requested.snapshotIdempotencyKey }
          : {}),
      });
    },
    'my-fpl-snapshot': async () => {
      const season = await seasonRepository.findCurrent();
      const requested = readMyFplManualSnapshotInput(input);
      requireManualFinalOverride(requested);
      const currentEvent = requested.eventId
        ? await eventRepository.findById(season, requested.eventId)
        : await getCurrentEvent(season);
      if (!currentEvent) throw new Error('No current event found');
      return enqueueMyFplSnapshot(season, 'manual', {
        eventId: currentEvent.id,
        snapshotKind: requested.snapshotKind ?? 'PROVISIONAL',
        jobId: `manual-my-fpl-snapshot-${currentEvent.id}-${Date.now()}`,
        ...(requested.snapshotActor ? { snapshotActor: requested.snapshotActor } : {}),
        ...(requested.snapshotReason ? { snapshotReason: requested.snapshotReason } : {}),
        ...(requested.snapshotIdempotencyKey
          ? { snapshotIdempotencyKey: requested.snapshotIdempotencyKey }
          : {}),
      });
    },
    'my-fpl-snapshot-outbox': async () => {
      const season = await seasonRepository.findCurrent();
      return enqueueMyFplSnapshotOutbox(season, 'manual', {
        jobId: `manual-my-fpl-snapshot-outbox-${Date.now()}`,
      });
    },
    'my-fpl-finalization': async () => {
      const requested = readMyFplManualSnapshotInput({
        ...(input && typeof input === 'object' && !Array.isArray(input) ? input : {}),
        snapshotKind: 'FINAL',
      });
      requireManualFinalOverride(requested);
      const season = await seasonRepository.findCurrent();
      const event = requested.eventId
        ? await eventRepository.findById(season, requested.eventId)
        : await eventRepository.findLatestFinalized(season);
      if (!event) throw new Error('No finalized event found');
      return enqueueMyFplSnapshot(season, 'manual', {
        eventId: event.id,
        snapshotKind: 'FINAL',
        jobId: `manual-my-fpl-finalization-${event.id}-${Date.now()}`,
        snapshotActor: requested.snapshotActor!,
        snapshotReason: requested.snapshotReason!,
        snapshotIdempotencyKey: requested.snapshotIdempotencyKey!,
      });
    },
    'entry-picks': async () => {
      const season = await seasonRepository.findCurrent();
      const currentEvent = await getCurrentEvent(season);
      if (!currentEvent) throw new Error('No current event found');
      return enqueueEntryPicksSyncJob(season, 'manual', { eventId: currentEvent.id });
    },
    'entry-transfers': async () => {
      const season = await seasonRepository.findCurrent();
      const currentEvent = await getCurrentEvent(season);
      if (!currentEvent) throw new Error('No current event found');
      return enqueueEntryTransfersSyncJob(season, 'manual', { eventId: currentEvent.id });
    },
    'league-event-results-sync': async () => {
      await runLeagueEventResultsSync({
        source: 'manual',
        skipMatchWindowCheck: true,
      });
    },
    'tournament-event-results-sync': async () => {
      await runTournamentEventResultsSync();
    },
    'tournament-selection-stats-sync': async () => {
      const season = await seasonRepository.findCurrent();
      const currentEvent = await getCurrentEvent(season);
      if (!currentEvent) {
        throw new Error('No current event found');
      }
      await syncTournamentSelectionStats(season, currentEvent.id);
    },
    'tournament-info-sync': async () => {
      await runTournamentInfoSync();
    },
    'tournament-materialized-views-refresh': async () => {
      await refreshTournamentMaterializedViews();
    },
    'live-snapshot': async () => {
      const season = await seasonRepository.findCurrent();
      const currentEvent = await getCurrentEvent(season);
      if (!currentEvent) {
        throw new Error('No current event found');
      }
      return enqueueLiveSnapshot(season, currentEvent.id, 'manual', {
        persistEventLives: false,
      });
    },
    'live-finalization': runPostMatchConsolidation,
  };
}

export function listTriggerableJobs(): TriggerableJobInfo[] {
  const registered = schedulerRegistry
    .filter((definition) => definition.manualTrigger !== false)
    .map((definition) => ({
      name: definition.name,
      description: definition.successPredicate,
      schedule: `${definition.cadence} (${definition.timezone}); catch-up=${definition.catchUpPolicy}`,
    }));
  const byName = new Map(
    [...registered, ...COMPATIBILITY_MANUAL_ALIASES].map((job) => [job.name, job]),
  );
  return [...byName.values()];
}

export async function triggerJob(name: string, input?: unknown): Promise<JobTriggerResult> {
  // Validate request-owned input before resolving mutable platform state. A
  // malformed manual request must fail as a 4xx even when the database is
  // unavailable.
  if (name === 'player-prices') {
    requirePlayerPricesChangeDate(input);
  }
  if (name === 'player-values-sync' || name === 'market-daily') {
    readMarketSourceDay(input);
  }
  const jobMap = buildJobMap(input);
  const job = jobMap[name];
  if (!job) {
    throw new JobNotFoundError(name);
  }

  logInfo(`Manual job trigger: ${name}`);
  const result = await job();

  if (name === 'event-current-refresh' && result && typeof result === 'object') {
    const typed = result as { refreshed: boolean; eventsSyncJobId?: string };
    logInfo(`Manual job finished: ${name}`, {
      refreshed: typed.refreshed,
      eventsSyncJobId: typed.eventsSyncJobId,
    });
    return {
      kind: 'event-current-refresh',
      refreshed: typed.refreshed,
      ...(typed.eventsSyncJobId !== undefined ? { eventsSyncJobId: typed.eventsSyncJobId } : {}),
      message: typed.refreshed
        ? 'current-event mismatch found; core-snapshot job enqueued'
        : 'active core publication already matches the database current event',
    };
  }

  // Latest-wins manual refreshes may join a dispatch that is still being
  // reconciled (including a short dispatch lease with no Bull ID yet). Keep
  // that state explicit instead of reporting a synchronous execution.
  if (
    result &&
    typeof result === 'object' &&
    'state' in result &&
    (result as { state?: unknown }).state === 'pending'
  ) {
    const jobId =
      'bullJobId' in result ? (result as { bullJobId?: string | number }).bullJobId : undefined;
    return {
      kind: 'pending',
      ...(jobId === undefined ? {} : { jobId }),
      message: jobId
        ? `Job '${name}' is already pending (${jobId})`
        : `Job '${name}' is pending reconciliation`,
    };
  }

  logInfo(`Manual job enqueued: ${name}`);
  if (result && typeof result === 'object' && ('id' in result || 'bullJobId' in result)) {
    const jobId =
      'id' in result
        ? (result as { id: string | number }).id
        : (result as { bullJobId: string | number }).bullJobId;
    return {
      kind: 'enqueued',
      jobId,
      message: `Job '${name}' enqueued successfully`,
    };
  }

  return {
    kind: 'executed',
    message: `Job '${name}' executed successfully`,
  };
}
