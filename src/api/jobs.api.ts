import { Elysia } from 'elysia';

import {
  enqueueEventsSyncJob,
  enqueueFixturesSyncJob,
  enqueuePhasesSyncJob,
  enqueuePlayersSyncJob,
  enqueuePlayerStatsSyncJob,
  enqueuePlayerValuesSyncJob,
  enqueueTeamsSyncJob,
} from '../jobs/data-sync.queue';
import { runLeagueEventPicksSync } from '../jobs/league-event-picks.jobs';
import { runLeagueEventResultsSync } from '../jobs/league-event-results.jobs';
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
import { runTournamentKnockoutResultsSync } from '../jobs/tournament-knockout-results.jobs';
import { runTournamentPointsRaceResultsSync } from '../jobs/tournament-points-race-results.jobs';
import { getCurrentEvent } from '../services/events.service';
import { getErrorMessage } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';

// Job business logic functions (will be moved to jobs/ later)
import { getCurrentGameweek, isFPLSeason, isMatchHours, isWeekend } from '../utils/conditions';

async function runLiveScores() {
  const now = new Date();
  const shouldRun = isWeekend(now) && isFPLSeason(now) && isMatchHours(now);

  if (!shouldRun) {
    logInfo('Skipping live scores - conditions not met', {
      isWeekend: isWeekend(now),
      isFPLSeason: isFPLSeason(now),
      isMatchHours: isMatchHours(now),
    });
    return;
  }

  logInfo('Live scores sync started', { gameweek: getCurrentGameweek(now) });
  // TODO: Implement live scores logic
  logInfo('Live scores sync completed (placeholder)');
}

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
        name: 'fixtures-sync',
        description: 'Sync fixtures from FPL API',
        schedule: 'Daily at 6:37 AM',
      },
      {
        name: 'teams-sync',
        description: 'Sync teams from FPL API',
        schedule: 'Daily at 6:40 AM',
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
      {
        name: 'event-standings-sync',
        description: 'Sync Premier League standings after matchday',
        schedule: 'Daily 12:00 (post-matchday)',
      },
      { name: 'live-scores', description: 'Update live scores', schedule: 'Every 15 minutes' },
    ];

    return { success: true, jobs, count: jobs.length };
  })

  .post('/:name/trigger', async ({ params, set }) => {
    const { name } = params;

    const jobMap: Record<string, () => Promise<unknown>> = {
      'events-sync': () => enqueueEventsSyncJob('manual'),
      'fixtures-sync': () => enqueueFixturesSyncJob('manual'),
      'teams-sync': () => enqueueTeamsSyncJob('manual'),
      'players-sync': () => enqueuePlayersSyncJob('manual'),
      'player-stats-sync': () => enqueuePlayerStatsSyncJob('manual'),
      'phases-sync': () => enqueuePhasesSyncJob('manual'),
      'player-values-sync': () => enqueuePlayerValuesSyncJob('manual'),
      'league-event-picks-sync': async () => {
        await runLeagueEventPicksSync();
      },
      'league-event-results-sync': async () => {
        await runLeagueEventResultsSync();
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
    };

    const job = jobMap[name];
    if (!job) {
      set.status = 404;
      return { success: false, error: `Job '${name}' not found` };
    }

    try {
      logInfo(`Manual job trigger: ${name}`);
      const result = await job();
      logInfo(`Manual job enqueued: ${name}`);

      // If result is a BullMQ job, return job info
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
