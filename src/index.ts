import { cors } from '@elysiajs/cors';
import { Elysia } from 'elysia';

// Import API route groups
import { entryInfoAPI } from './api/entry-info.api';
import { entrySyncAPI } from './api/entry-sync.api';
import { eventLivesAPI } from './api/event-lives.api';
import { eventsAPI } from './api/events.api';
import { fixturesAPI } from './api/fixtures.api';
import { jobsAPI } from './api/jobs.api';
import { phasesAPI } from './api/phases.api';
import { playerStatsAPI } from './api/player-stats.api';
import { playerValuesAPI } from './api/player-values.api';
import { playersAPI } from './api/players.api';
import { teamsAPI } from './api/teams.api';

// Import job registration functions
import { registerDataJobs } from './jobs/data-jobs';
import { registerEntryJobs } from './jobs/entry-sync.jobs';
import { registerLeagueJobs } from './jobs/league-jobs';
import { registerLiveJobs } from './jobs/live.jobs';
import { registerTournamentJobs } from './jobs/tournament-jobs';

// Import utilities
import { getConfig } from './utils/config';
import { getErrorMessage } from './utils/errors';
import { logError, logInfo } from './utils/logger';

/**
 * Letletme Data API - Elysia Application
 *
 * A unified Elysia application that provides:
 * - HTTP API endpoints for FPL data (events, fixtures, teams, players, player stats, phases)
 * - Scheduled cron jobs for data synchronization
 * - Manual job triggers via HTTP API
 * - Structured logging and error handling
 */

// Validate environment and resolve config
const { port } = getConfig();

const app = new Elysia()
  // ================================
  // Middleware & Configuration
  // ================================

  // CORS support
  .use(cors())

  // Request logging
  .onRequest(({ request }) => {
    logInfo('HTTP Request', {
      method: request.method,
      url: request.url,
      userAgent: request.headers.get('user-agent'),
    });
  })

  // Global error handling
  .onError(({ code, error, set }) => {
    logError('HTTP Error', error, { code });

    const message = getErrorMessage(error);

    switch (code) {
      case 'NOT_FOUND':
        set.status = 404;
        return { success: false, error: 'Endpoint not found' };
      case 'VALIDATION':
        set.status = 400;
        return { success: false, error: 'Validation failed', details: message };
      default:
        set.status = 500;
        return { success: false, error: message };
    }
  })

  // ================================
  // Health Check & Info
  // ================================

  .get('/', () => ({
    success: true,
    message: 'Letletme Data API - Elysia + Cron',
    timestamp: new Date().toISOString(),
  }))

  .get('/health', () => ({
    success: true,
    status: 'healthy',
    timestamp: new Date().toISOString(),
  }))

  // ================================
  // API Route Groups
  // ================================

  .use(eventsAPI)
  .use(eventLivesAPI)
  .use(fixturesAPI)
  .use(teamsAPI)
  .use(playersAPI)
  .use(playerStatsAPI)
  .use(playerValuesAPI)
  .use(phasesAPI)
  .use(entryInfoAPI)
  .use(entrySyncAPI)
  .use(jobsAPI)

  // ================================
  // Cron Job Registration
  // ================================

  .use(registerDataJobs)
  .use(registerLiveJobs)
  .use(registerEntryJobs)
  .use(registerLeagueJobs)
  .use(registerTournamentJobs)

  // ================================
  // Server Startup
  // ================================

  .listen({
    port,
    hostname: '0.0.0.0',
  });

// Log startup after successful listen
logInfo('🚀 Elysia server started', {
  port,
  environment: process.env.NODE_ENV || 'development',
  apis: [
    'events',
    'event-lives',
    'fixtures',
    'teams',
    'players',
    'player-stats',
    'player-values',
    'entry-info',
    'phases',
    'jobs',
  ],
  jobs: [
    'data-sync',
    'player-values-window',
    'live-scores',
    'event-live-summary',
    'event-live-explain',
    'event-overall-result',
    'entry-info',
    'entry-picks',
    'entry-transfers',
    'entry-results',
    'league-event-picks',
    'league-event-results',
    'tournament-event-picks',
    'tournament-event-results',
    'tournament-event-transfers-pre',
    'tournament-event-transfers-post',
    'tournament-event-cup-results',
    'tournament-info',
    'tournament-points-race-results',
    'tournament-battle-race-results',
    'tournament-knockout-results',
  ],
});

export { app };
export type AppInstance = typeof app;
