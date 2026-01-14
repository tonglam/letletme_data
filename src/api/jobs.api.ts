import { Elysia } from 'elysia';

import { getErrorMessage } from '../utils/errors';
import { logError, logInfo } from '../utils/logger';
import {
  enqueueEventsSyncJob,
  enqueueFixturesSyncJob,
  enqueuePlayerValuesSyncJob,
  enqueuePlayerStatsSyncJob,
  enqueuePhasesSyncJob,
  enqueuePlayersSyncJob,
  enqueueTeamsSyncJob,
} from '../jobs/data-sync.queue';
import {
  enqueueEntryInfoSyncJob,
  enqueueEntryPicksSyncJob,
  enqueueEntryResultsSyncJob,
  enqueueEntryTransfersSyncJob,
} from '../jobs/entry-sync.queue';
import { runLeagueEventPicksSync } from '../jobs/league-event-picks.jobs';
import { runLeagueEventResultsSync } from '../jobs/league-event-results.jobs';
import { runEventStandingsSync } from '../jobs/event-standings.jobs';
import { runTournamentEventPicksSync } from '../jobs/tournament-event-picks.jobs';
import { runTournamentEventResultsSync } from '../jobs/tournament-event-results.jobs';
import {
  runTournamentEventTransfersPostSync,
  runTournamentEventTransfersPreSync,
} from '../jobs/tournament-event-transfers.jobs';
import { runTournamentEventCupResultsSync } from '../jobs/tournament-event-cup-results.jobs';
import { runTournamentInfoSync } from '../jobs/tournament-info.jobs';
import { runTournamentPointsRaceResultsSync } from '../jobs/tournament-points-race-results.jobs';
import { runTournamentBattleRaceResultsSync } from '../jobs/tournament-battle-race-results.jobs';
import { runTournamentKnockoutResultsSync } from '../jobs/tournament-knockout-results.jobs';
import { syncEventLiveExplain } from '../services/event-live-explains.service';
import { syncEventLiveSummary } from '../services/event-live-summaries.service';
import { syncEventOverallResult } from '../services/event-overall-results.service';

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
        schedule: 'Daily at 9:30 AM',
      },
      {
        name: 'entry-info-sync',
        description: 'Sync entry info from FPL API',
        schedule: 'Daily at 10:30 AM',
      },
      {
        name: 'entry-picks-sync',
        description: 'Sync entry picks for current event',
        schedule: 'Daily at 10:35 AM',
      },
      {
        name: 'entry-transfers-sync',
        description: 'Sync entry transfers for current event',
        schedule: 'Daily at 10:40 AM',
      },
      {
        name: 'entry-results-sync',
        description: 'Sync entry results for current event',
        schedule: 'Daily at 10:45 AM',
      },
      {
        name: 'league-event-picks-sync',
        description: 'Sync league entry picks during selection window',
        schedule: 'Every 5 minutes (selection window)',
      },
      {
        name: 'league-event-results-sync',
        description: 'Sync league results after matchday',
        schedule: '08:00/10:00/12:00 (post-matchday)',
      },
      {
        name: 'tournament-event-picks-sync',
        description: 'Sync tournament entry picks during selection window',
        schedule: 'Every 5 minutes 00:00-04:59 & 18:00-23:59',
      },
      {
        name: 'tournament-event-results-sync',
        description: 'Sync tournament entry results after matchday',
        schedule: '06:10/08:10/10:10 (post-matchday)',
      },
      {
        name: 'tournament-event-transfers-pre-sync',
        description: 'Insert tournament entry transfers during selection window',
        schedule: 'Every 5 minutes 00:00-04:59 & 18:00-23:59',
      },
      {
        name: 'tournament-event-transfers-post-sync',
        description: 'Update tournament entry transfers after matchday',
        schedule: '06:45/08:45/10:45 (post-matchday)',
      },
      {
        name: 'tournament-event-cup-results-sync',
        description: 'Sync tournament entry cup results after matchday',
        schedule: '06:55/08:55/10:55 (post-matchday)',
      },
      {
        name: 'tournament-info-sync',
        description: 'Refresh tournament info names daily',
        schedule: 'Daily 10:45',
      },
      {
        name: 'tournament-points-race-results-sync',
        description: 'Sync points race group standings after matchday',
        schedule: '06:20/08:20/10:20 (post-matchday)',
      },
      {
        name: 'tournament-battle-race-results-sync',
        description: 'Sync battle race group standings after matchday',
        schedule: '06:30/08:30/10:30 (post-matchday)',
      },
      {
        name: 'tournament-knockout-results-sync',
        description: 'Sync knockout matchups after matchday',
        schedule: '06:40/08:40/10:40 (post-matchday)',
      },
      {
        name: 'event-live-summary-sync',
        description: 'Sync event live summary snapshot',
        schedule: 'Matchday 06:05/08:05/10:05',
      },
      {
        name: 'event-live-explain-sync',
        description: 'Sync event live explain snapshot',
        schedule: 'Matchday 06:08/08:08/10:08',
      },
      {
        name: 'event-overall-result-sync',
        description: 'Sync event overall result snapshot',
        schedule: 'Matchday 06:02/08:02/10:02',
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
      'entry-info-sync': () => enqueueEntryInfoSyncJob('manual'),
      'entry-picks-sync': () => enqueueEntryPicksSyncJob('manual'),
      'entry-transfers-sync': () => enqueueEntryTransfersSyncJob('manual'),
      'entry-results-sync': () => enqueueEntryResultsSyncJob('manual'),
      'league-event-picks-sync': runLeagueEventPicksSync,
      'league-event-results-sync': runLeagueEventResultsSync,
      'tournament-event-picks-sync': runTournamentEventPicksSync,
      'tournament-event-results-sync': runTournamentEventResultsSync,
      'tournament-event-transfers-pre-sync': runTournamentEventTransfersPreSync,
      'tournament-event-transfers-post-sync': runTournamentEventTransfersPostSync,
      'tournament-event-cup-results-sync': runTournamentEventCupResultsSync,
      'tournament-info-sync': runTournamentInfoSync,
      'tournament-points-race-results-sync': runTournamentPointsRaceResultsSync,
      'tournament-battle-race-results-sync': runTournamentBattleRaceResultsSync,
      'tournament-knockout-results-sync': runTournamentKnockoutResultsSync,
      'event-live-summary-sync': () => syncEventLiveSummary(),
      'event-live-explain-sync': () => syncEventLiveExplain(),
      'event-overall-result-sync': () => syncEventOverallResult(),
      'event-standings-sync': runEventStandingsSync,
      'live-scores': runLiveScores,
    };

    const job = jobMap[name];
    if (!job) {
      set.status = 404;
      return { success: false, error: `Job '${name}' not found` };
    }

    try {
      logInfo(`Manual job trigger: ${name}`);
      await job();
      logInfo(`Manual job completed: ${name}`);
      return { success: true, message: `Job '${name}' executed successfully` };
    } catch (error) {
      logError(`Manual job failed: ${name}`, error);
      set.status = 500;
      return { success: false, error: getErrorMessage(error) };
    }
  });
