import { Elysia } from 'elysia';

import {
  enqueueEventsSyncJob,
  enqueueFixturesSyncJob,
  enqueuePhasesSyncJob,
  enqueuePlayersSyncJob,
  enqueuePlayerStatsSyncJob,
  enqueuePlayerValuesSyncJob,
  enqueueTeamsSyncJob,
} from '../jobs/data-sync-enqueue';
import {
  enqueueEntryInfoSyncJob,
  enqueueEntryPicksSyncJob,
  enqueueEntryResultsSyncJob,
  enqueueEntryTransfersSyncJob,
} from '../jobs/entry-sync-enqueue';
import { runLeagueEventPicksSync } from '../jobs/league-event-picks.jobs';
import { runLeagueEventResultsSync } from '../jobs/league-event-results.jobs';
import { runLaunchHappening, runLaunchWarning } from '../jobs/launch.jobs';
import {
  enqueueEventLiveExplain,
  enqueueEventLivesCacheUpdate,
  enqueueEventLivesDbSync,
  enqueueEventLiveSummary,
  enqueueEventOverallResult,
} from '../jobs/live-data.jobs';
import { runTournamentBattleRaceResultsSync } from '../jobs/tournament-battle-race-results.jobs';
import { runTournamentEventCupResultsSync } from '../jobs/tournament-event-cup-results.jobs';
import { runTournamentEventPicksSync } from '../jobs/tournament-event-picks.jobs';
import { runTournamentEventResultsSync } from '../jobs/tournament-event-results.jobs';
import {
  runTournamentEventTransfersPostSync,
  runTournamentEventTransfersPreSync,
} from '../jobs/tournament-event-transfers.jobs';
import { runTournamentInfoSync } from '../jobs/tournament-info.jobs';
import { runLiveScores, runPostMatchConsolidation } from '../jobs/live.jobs';
import { runTournamentKnockoutResultsSync } from '../jobs/tournament-knockout-results.jobs';
import { runTournamentPointsRaceResultsSync } from '../jobs/tournament-points-race-results.jobs';
import { runManualEventCurrentRefresh } from '../jobs/event-current-refresh.job';
import { refreshTournamentMaterializedViews } from '../services/tournament-materialized-views.service';
import { syncTournamentSelectionStats } from '../services/tournament-selection-stats.service';
import { getCurrentEvent } from '../services/events.service';
import { getErrorMessage } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

/**
 * Jobs Management API Routes
 *
 * Handles job-related HTTP endpoints:
 * - GET /jobs - List all available jobs
 * - POST /jobs/:name/trigger - Manually trigger a specific job
 */

export const jobsAPI = new Elysia({ prefix: '/jobs' })
  .get('/', () => {
    const jobs = [
      {
        name: 'events-sync',
        description: 'Sync events from FPL API',
        schedule: 'Daily at 6:35 AM',
      },
      {
        name: 'event-current-refresh',
        description:
          'Recompute Redis event:current from Event hash; enqueue events-sync if gameweek id changes',
        schedule: 'Every minute (cron); POST here for immediate run (ignores season window)',
      },
      {
        name: 'fixtures-sync',
        description: 'Sync fixtures from FPL API',
        schedule: 'Daily at 6:40 AM',
      },
      {
        name: 'teams-sync',
        description: 'Sync teams from FPL API',
        schedule: 'Daily at 6:37 AM',
      },
      {
        name: 'players-sync',
        description: 'Sync players from FPL API',
        schedule: 'Daily at 6:43 AM',
      },
      {
        name: 'player-stats-sync',
        description: 'Sync player stats from FPL API',
        schedule: 'Daily at 9:40 AM',
      },
      {
        name: 'phases-sync',
        description: 'Sync phases from FPL API',
        schedule: 'Daily at 6:45 AM',
      },
      {
        name: 'player-values-sync',
        description: 'Sync player values from FPL API',
        schedule: '09:25-09:35 AM window (stops after success)',
      },
      {
        name: 'entry-info-daily',
        description: 'Sync known entry profile data',
        schedule: 'Daily at 10:30 AM',
      },
      {
        name: 'entry-event-picks-daily',
        description: 'Sync entry picks for current event',
        schedule: 'Daily at 10:35 AM (selection window)',
      },
      {
        name: 'entry-event-transfers-daily',
        description: 'Sync entry transfers for current event',
        schedule: 'Daily at 10:40 AM (after-matchday window)',
      },
      {
        name: 'entry-event-results-daily',
        description: 'Sync entry results for current event',
        schedule: 'Daily at 10:45 AM',
      },
      {
        name: 'league-event-picks-sync',
        description: 'Sync league entry picks (per-tournament jobs)',
        schedule: 'Every 5 minutes (selection window)',
      },
      {
        name: 'league-event-results-sync',
        description: 'Sync league results (per-tournament jobs)',
        schedule: 'Every 10 minutes (post-matchday)',
      },
      {
        name: 'tournament-event-picks-sync',
        description: 'Sync tournament entry picks (background job)',
        schedule: 'Every 5 minutes during select time',
      },
      {
        name: 'tournament-event-results-sync',
        description: 'Sync tournament results (triggers cascade)',
        schedule: 'Every 10 minutes post-matchday',
      },
      {
        name: 'tournament-event-transfers-pre-sync',
        description: 'Track tournament transfers pre-deadline (background job)',
        schedule: 'Every 5 minutes during select time',
      },
      {
        name: 'tournament-event-transfers-post-sync',
        description: 'Finalize tournament transfers (cascade)',
        schedule: 'Cascade after event-results',
      },
      {
        name: 'tournament-event-cup-results-sync',
        description: 'Calculate tournament cup results (cascade)',
        schedule: 'Cascade after event-results',
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
        name: 'tournament-points-race-results-sync',
        description: 'Calculate points race standings (cascade)',
        schedule: 'Cascade after event-results',
      },
      {
        name: 'tournament-battle-race-results-sync',
        description: 'Calculate battle race standings (cascade)',
        schedule: 'Cascade after event-results',
      },
      {
        name: 'tournament-knockout-results-sync',
        description: 'Calculate knockout bracket results (cascade)',
        schedule: 'Cascade after event-results',
      },
      {
        name: 'tournament-materialized-views-refresh',
        description: 'Refresh tournament materialized views for GraphQL APIs',
        schedule: 'Cascade 30s after event-results cascade jobs',
      },
      {
        name: 'event-lives-cache-update',
        description: 'Cache-only update for event lives (fast, real-time)',
        schedule: 'Every 1 minute during match hours',
      },
      {
        name: 'event-lives-db-sync',
        description: 'Full DB sync for event lives (triggers cascade)',
        schedule: 'Every 10 minutes during match hours',
      },
      {
        name: 'event-live-summary-sync',
        description: 'Aggregate season totals (cascaded from DB sync)',
        schedule: 'Cascade after DB sync',
      },
      {
        name: 'event-live-explain-sync',
        description: 'Sync event live explain data (cascaded from DB sync)',
        schedule: 'Cascade after DB sync',
      },
      {
        name: 'event-overall-result-sync',
        description: 'Sync event overall results (cascaded from DB sync)',
        schedule: 'Cascade after DB sync',
      },
      { name: 'live-scores', description: 'Update live scores', schedule: 'Every 15 minutes' },
      {
        name: 'post-match-consolidation',
        description: 'Catch FPL overnight data finalization (bonus, corrected scores)',
        schedule: '06:00, 08:00, 10:00 on match days',
      },
      {
        name: 'launch-warning',
        description: 'Pre-season monitor message when FPL events are absent',
        schedule: 'Manual only (launch cron not registered)',
      },
      {
        name: 'launch-happening',
        description: 'Season-start monitor message when new deadline appears',
        schedule: 'Manual only (launch cron not registered)',
      },
    ];

    return { success: true, jobs, count: jobs.length };
  })

  .post('/:name/trigger', async ({ params, set }) => {
    const { name } = params;

    const jobMap: Record<string, () => Promise<unknown>> = {
      'event-current-refresh': () => runManualEventCurrentRefresh(),
      'events-sync': () => enqueueEventsSyncJob('manual'),
      'fixtures-sync': () => enqueueFixturesSyncJob('manual'),
      'teams-sync': () => enqueueTeamsSyncJob('manual'),
      'players-sync': () => enqueuePlayersSyncJob('manual'),
      'player-stats-sync': () => enqueuePlayerStatsSyncJob('manual'),
      'phases-sync': () => enqueuePhasesSyncJob('manual'),
      'player-values-sync': () => enqueuePlayerValuesSyncJob('manual'),
      'entry-info-daily': () => enqueueEntryInfoSyncJob('manual'),
      'entry-event-picks-daily': async () => {
        const currentEvent = await getCurrentEvent();
        if (!currentEvent) {
          throw new Error('No current event found');
        }
        return enqueueEntryPicksSyncJob('manual', { eventId: currentEvent.id });
      },
      'entry-event-transfers-daily': async () => {
        const currentEvent = await getCurrentEvent();
        if (!currentEvent) {
          throw new Error('No current event found');
        }
        return enqueueEntryTransfersSyncJob('manual', { eventId: currentEvent.id });
      },
      'entry-event-results-daily': () => enqueueEntryResultsSyncJob('manual'),
      'league-event-picks-sync': async () => {
        await runLeagueEventPicksSync();
      },
      'league-event-results-sync': async () => {
        await runLeagueEventResultsSync({
          source: 'manual',
          skipMatchWindowCheck: true,
        });
      },
      'tournament-event-picks-sync': async () => {
        await runTournamentEventPicksSync();
      },
      'tournament-event-results-sync': async () => {
        await runTournamentEventResultsSync();
      },
      'tournament-event-transfers-pre-sync': async () => {
        await runTournamentEventTransfersPreSync();
      },
      'tournament-event-transfers-post-sync': async () => {
        await runTournamentEventTransfersPostSync();
      },
      'tournament-event-cup-results-sync': async () => {
        await runTournamentEventCupResultsSync();
      },
      'tournament-selection-stats-sync': async () => {
        const currentEvent = await getCurrentEvent();
        if (!currentEvent) {
          throw new Error('No current event found');
        }
        await syncTournamentSelectionStats(currentEvent.id);
      },
      'tournament-info-sync': async () => {
        await runTournamentInfoSync();
      },
      'tournament-points-race-results-sync': async () => {
        await runTournamentPointsRaceResultsSync();
      },
      'tournament-battle-race-results-sync': async () => {
        await runTournamentBattleRaceResultsSync();
      },
      'tournament-knockout-results-sync': async () => {
        await runTournamentKnockoutResultsSync();
      },
      'tournament-materialized-views-refresh': async () => {
        await refreshTournamentMaterializedViews();
      },
      'event-lives-cache-update': async () => {
        const currentEvent = await getCurrentEvent();
        if (!currentEvent) {
          throw new Error('No current event found');
        }
        await enqueueEventLivesCacheUpdate(currentEvent.id, 'manual');
      },
      'event-lives-db-sync': async () => {
        const currentEvent = await getCurrentEvent();
        if (!currentEvent) {
          throw new Error('No current event found');
        }
        await enqueueEventLivesDbSync(currentEvent.id, 'manual');
      },
      'event-live-summary-sync': async () => {
        const currentEvent = await getCurrentEvent();
        if (!currentEvent) {
          throw new Error('No current event found');
        }
        await enqueueEventLiveSummary(currentEvent.id, 'manual');
      },
      'event-live-explain-sync': async () => {
        const currentEvent = await getCurrentEvent();
        if (!currentEvent) {
          throw new Error('No current event found');
        }
        await enqueueEventLiveExplain(currentEvent.id, 'manual');
      },
      'event-overall-result-sync': async () => {
        const currentEvent = await getCurrentEvent();
        if (!currentEvent) {
          throw new Error('No current event found');
        }
        await enqueueEventOverallResult(currentEvent.id, 'manual');
      },
      'live-scores': runLiveScores,
      'post-match-consolidation': runPostMatchConsolidation,
      'launch-warning': runLaunchWarning,
      'launch-happening': runLaunchHappening,
    };

    const job = jobMap[name];
    if (!job) {
      set.status = 404;
      return { success: false, error: `Job '${name}' not found` };
    }

    try {
      logInfo(`Manual job trigger: ${name}`);
      const result = await job();

      if (name === 'event-current-refresh' && result && typeof result === 'object') {
        const typed = result as { refreshed: boolean; eventsSyncJobId?: string };
        logInfo(`Manual job finished: ${name}`, {
          refreshed: typed.refreshed,
          eventsSyncJobId: typed.eventsSyncJobId,
        });
        return {
          success: true,
          message: typed.refreshed
            ? 'event:current updated; events-sync job enqueued'
            : 'event:current unchanged (derived gameweek id already in Redis)',
          refreshed: typed.refreshed,
          ...(typed.eventsSyncJobId !== undefined
            ? { eventsSyncJobId: typed.eventsSyncJobId }
            : {}),
        };
      }

      logInfo(`Manual job enqueued: ${name}`);
      if (result && typeof result === 'object' && 'id' in result) {
        return {
          success: true,
          message: `Job '${name}' enqueued successfully`,
          jobId: result.id,
        };
      }

      return { success: true, message: `Job '${name}' executed successfully` };
    } catch (error) {
      logError(`Manual job failed: ${name}`, error);
      set.status = 500;
      return { success: false, error: getErrorMessage(error) };
    }
  });
