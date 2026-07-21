import { cors } from '@elysiajs/cors';
import { Elysia } from 'elysia';

// Import API route groups
import { registerMutationAuthGuard } from './api/auth.guard';
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
import { registerMutationRateLimit } from './api/rate-limit';
import { checkReadiness } from './api/health';
import { teamsAPI } from './api/teams.api';
import { tournamentsAPI } from './api/tournaments.api';

// Import job registration functions
import { registerDataJobs } from './jobs/data-jobs';
import { registerEntryJobs } from './jobs/entry-sync.jobs';
import { registerLeagueJobs } from './jobs/league-jobs';
import { registerLaunchJobs } from './jobs/launch.jobs';
import { registerLiveJobs } from './jobs/live.jobs';
import { registerTournamentJobs } from './jobs/tournament-jobs';

// Import utilities
import { getAuthConfig, getConfig } from './utils/config';
import { getErrorMessage, getHttpStatusFromError, getPublicErrorMessage } from './utils/errors';
import { getHttpErrorLogLevel, getHttpRequestLogContext } from './utils/http-logging';
import { logDebug, logError, logInfo, logWarn } from './utils/logger';

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
const { PORT: port } = getConfig();
const { CORS_ORIGINS, ENABLE_AUTH } = getAuthConfig();

const app = new Elysia()
  // ================================
  // Middleware & Configuration
  // ================================

  .use(
    cors({
      origin: CORS_ORIGINS.length > 0 ? CORS_ORIGINS : false,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'x-api-key'],
    }),
  )

  .use(registerMutationRateLimit)
  .use(registerMutationAuthGuard)

  // Request logging
  .onRequest(({ request }) => {
    const requestContext = getHttpRequestLogContext(request);
    if (requestContext) {
      logDebug('HTTP Request', requestContext);
    }
  })

  // Global error handling
  .onError(({ code, error, request, set }) => {
    const message = getErrorMessage(error);
    const requestContext = getHttpRequestLogContext(request) ?? {
      method: request.method,
      pathname: new URL(request.url).pathname,
    };
    const logContext = { code, ...requestContext };

    switch (getHttpErrorLogLevel(code)) {
      case 'debug':
        logDebug('HTTP Not Found', logContext);
        break;
      case 'warn':
        logWarn('HTTP Validation Error', { ...logContext, message });
        break;
      default:
        logError('HTTP Error', error, logContext);
    }

    switch (code) {
      case 'NOT_FOUND':
        set.status = 404;
        return { success: false, error: 'Endpoint not found' };
      case 'VALIDATION':
        set.status = 400;
        return { success: false, error: 'Validation failed', details: message };
      default: {
        const status = getHttpStatusFromError(error);
        set.status = status;
        return { success: false, error: getPublicErrorMessage(error, status) };
      }
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
    status: 'alive',
    timestamp: new Date().toISOString(),
  }))

  .get('/ready', async ({ set }) => {
    const readiness = await checkReadiness();
    if (!readiness.ready) set.status = 503;
    return {
      success: readiness.ready,
      status: readiness.ready ? 'ready' : 'not_ready',
      dependencies: readiness.dependencies,
      timestamp: new Date().toISOString(),
    };
  })

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
  .use(tournamentsAPI)

  // ================================
  // Cron Job Registration
  // ================================

  .use(registerDataJobs)
  .use(registerLaunchJobs)
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

async function shutdown(signal: string) {
  logInfo('API server shutting down', { signal });
  await app.stop();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

// Log startup after successful listen
logInfo('🚀 Elysia server started', {
  port,
  environment: process.env.NODE_ENV || 'development',
  authEnabled: ENABLE_AUTH,
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
    'tournaments',
  ],
  jobs: [
    'data-sync',
    'launch-monitor',
    'player-values-window',
    'live-scores',
    'event-current-refresh',
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
