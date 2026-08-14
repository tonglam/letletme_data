import {
  enqueueCoreSnapshotJob,
  enqueuePlayerPricesSyncJob,
  enqueuePlayerStatsSyncJob,
  enqueuePlayerValuesSyncJob,
} from '../jobs/data-sync-enqueue';
import { enqueueEntryInfoSyncJob, enqueueEntryResultsSyncJob } from '../jobs/entry-sync-enqueue';
import { runManualEventCurrentRefresh } from '../jobs/event-current-refresh.job';
import { runLeagueEventResultsSync } from '../jobs/league-event-results.jobs';
import { runLaunchMonitor } from '../jobs/launch.jobs';
import { enqueueLiveSnapshot } from '../jobs/live-data.jobs';
import { runPostMatchConsolidation } from '../jobs/live.jobs';
import { runTournamentEventResultsSync } from '../jobs/tournament-event-results.jobs';
import { runTournamentInfoSync } from '../jobs/tournament-info.jobs';
import { getCurrentEvent } from './events.service';
import { eventRepository } from '../repositories/events';
import { seasonRepository } from '../repositories/seasons';
import { refreshTournamentMaterializedViews } from './tournament-materialized-views.service';
import { repairPlayerSeasonSummaries } from './player-season-summaries.service';
import { syncTournamentSelectionStats } from './tournament-selection-stats.service';
import { logInfo } from '../utils/logger';
import { ValidationError } from '../utils/errors';

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
      kind: 'executed';
      message: string;
    };

const TRIGGERABLE_JOBS: TriggerableJobInfo[] = [
  {
    name: 'core-snapshot-sync',
    description: 'Atomically sync events, teams, players, phases, and fixtures',
    schedule: 'Daily at 06:35 UTC+8 (year-round discovery)',
  },
  {
    name: 'event-current-refresh',
    description: 'Refresh the coherent core publication when the current event changes',
    schedule: 'Every minute (cron); POST here for immediate run (ignores season window)',
  },
  {
    name: 'player-prices',
    description: 'Replay persisted price changes into current player prices',
    schedule: 'Daily at 09:40 UTC+8 plus immediate player-values cascade',
  },
  {
    name: 'player-stats-sync',
    description: 'Sync player stats from FPL API',
    schedule: 'Daily at 09:40 UTC+8 (current event or preseason next event)',
  },
  {
    name: 'player-season-summary-repair',
    description: 'Repair stale physical player season summary read models',
    schedule: 'Hourly at minute 17 and after every durable live write',
  },
  {
    name: 'player-values-sync',
    description: 'Sync player values from FPL API',
    schedule: 'Preseason 09:25; in-season 09:25-09:35 until changes are stored',
  },
  {
    name: 'entry-info-daily',
    description: 'Sync known entry profile data',
    schedule: 'Daily at 10:30 AM',
  },
  {
    name: 'entry-event-results-daily',
    description: 'Sync entry results for current event',
    schedule: 'Daily at 10:45 AM',
  },
  {
    name: 'league-event-results-sync',
    description: 'Sync league results (per-tournament jobs)',
    schedule: 'Every 10 minutes in the 24-hour post-match result window',
  },
  {
    name: 'tournament-event-results-sync',
    description: 'Sync tournament results (triggers cascade)',
    schedule: 'Every 10 minutes in the 24-hour post-match result window',
  },
  {
    name: 'tournament-selection-stats-sync',
    description: 'Build tournament selection stats read model',
    schedule: 'Cascade after tournament transfers post',
  },
  {
    name: 'tournament-info-sync',
    description: 'Refresh tournament info names daily',
    schedule: 'Daily 10:45',
  },
  {
    name: 'tournament-materialized-views-refresh',
    description: 'Refresh tournament materialized views for GraphQL APIs',
    schedule: 'Cascade after the three structure jobs complete their barrier',
  },
  {
    name: 'live-snapshot',
    description: 'Fetch and atomically publish one coherent live football snapshot',
    schedule: 'Every 1 minute during match hours; persists full live rows every 10 minutes',
  },
  {
    name: 'post-match-consolidation',
    description: 'Catch FPL overnight data finalization (bonus, corrected scores)',
    schedule: '06:00, 08:00, 10:00 UTC+8 inside the 24-hour post-match window',
  },
  {
    name: 'launch-monitor',
    description: 'Detect pre-season and season-start transitions with one bootstrap request',
    schedule: 'Every five minutes year-round (deduplicated by transition)',
  },
];

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

function buildJobMap(input?: unknown): Record<string, () => Promise<unknown>> {
  return {
    'event-current-refresh': () => runManualEventCurrentRefresh(),
    'core-snapshot-sync': async () => {
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
    'player-season-summary-repair': repairPlayerSeasonSummaries,
    'player-values-sync': async () => {
      const season = await seasonRepository.findCurrent();
      return enqueuePlayerValuesSyncJob(season, 'manual');
    },
    'entry-info-daily': async () => {
      const season = await seasonRepository.findCurrent();
      const targetEventId = (await eventRepository.findLatestFinalized(season))?.id ?? 0;
      return enqueueEntryInfoSyncJob(season, 'manual', { eventId: targetEventId });
    },
    'entry-event-results-daily': async () => {
      const season = await seasonRepository.findCurrent();
      const currentEvent = await getCurrentEvent(season);
      if (!currentEvent) {
        throw new Error('No current event found');
      }
      return enqueueEntryResultsSyncJob(season, 'manual', { eventId: currentEvent.id });
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
    'post-match-consolidation': runPostMatchConsolidation,
    'launch-monitor': () => runLaunchMonitor({ source: 'manual' }),
  };
}

export function listTriggerableJobs(): TriggerableJobInfo[] {
  return TRIGGERABLE_JOBS;
}

export async function triggerJob(name: string, input?: unknown): Promise<JobTriggerResult> {
  // Validate request-owned input before resolving mutable platform state. A
  // malformed manual request must fail as a 4xx even when the database is
  // unavailable.
  if (name === 'player-prices') {
    requirePlayerPricesChangeDate(input);
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

  logInfo(`Manual job enqueued: ${name}`);
  if (result && typeof result === 'object' && 'id' in result) {
    const jobId = (result as { id: string | number }).id;
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
