import { cors } from '@elysiajs/cors';
import { Elysia } from 'elysia';

// Import API route groups
import { bugReportsAPI, bugReportsStatusAPI } from './api/bug-reports.api';
import { registerMutationAuthGuard } from './api/auth.guard';
import { entryInfoAPI } from './api/entry-info.api';
import { contentAPI } from './content/api/content.api';
import { entrySyncAPI } from './api/entry-sync.api';
import { eventLivesAPI } from './api/event-lives.api';
import { eventsAPI } from './api/events.api';
import { fixturesAPI } from './api/fixtures.api';
import { jobsAPI } from './api/jobs.api';
import { managerLiveAPI } from './api/manager-live.api';
import { priceChangePredictionsAPI } from './api/price-change-predictions.api';
import { liveStatusAPI } from './api/live-status.api';
import { phasesAPI } from './api/phases.api';
import { playerStatsAPI } from './api/player-stats.api';
import { playerValuesAPI } from './api/player-values.api';
import { playersAPI } from './api/players.api';
import { registerMutationRateLimit } from './api/rate-limit';
import { checkReadiness } from './api/health';
import { clientSignalsAPI } from './api/client-signals.api';
import { teamsAPI } from './api/teams.api';
import { tournamentsAPI } from './api/tournaments.api';
import { understatAPI } from './api/understat.api';
import { trendsAPI } from './api/trends.api';
import { dataGovernanceAPI } from './api/data-governance.api';
import { databaseSingleton } from './db/singleton';
import { redisSingleton } from './cache/singleton';
import { queueRedisSingleton } from './queues/redis';
import { closeAllProducerQueues } from './queues/close-all';

// Import job registration functions
import { registerDataJobs } from './jobs/data-jobs';
import { registerEntryJobs } from './jobs/entry-sync.jobs';
import { registerLeagueJobs } from './jobs/league-jobs';
import { registerLaunchJobs } from './jobs/launch.jobs';
import { registerLiveJobs } from './jobs/live.jobs';
import { registerTournamentJobs } from './jobs/tournament-jobs';

// Import utilities
import { assertContentRuntimeFlags, getContentRuntimeFlags } from './content/config';
import { getAuthConfig, getConfig } from './utils/config';
import {
  getErrorMessage,
  getHttpStatusFromError,
  getOrCreateRequestId,
  getPublicErrorCode,
  getPublicErrorMessage,
} from './utils/errors';
import { getHttpErrorLogLevel, getHttpRequestLogContext } from './utils/http-logging';
import { logDebug, logError, logInfo, logWarn } from './utils/logger';
import { schedulerRegistry } from './scheduler/job-registry';
import { isStandaloneSchedulerEnabled } from './utils/scheduler-mode';
import { createShutdownController, installShutdownSignals } from './utils/shutdown-controller';

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
const config = getConfig();
assertContentRuntimeFlags(getContentRuntimeFlags());
if (config.NODE_ENV === 'production') {
  await databaseSingleton.connect();
}
const { PORT: port } = config;
const { CORS_ORIGINS, ENABLE_AUTH } = getAuthConfig();
const requestIds = new WeakMap<Request, string>();

const app = new Elysia()
  // ================================
  // Middleware & Configuration
  // ================================

  .use(
    cors({
      origin: CORS_ORIGINS.length > 0 ? CORS_ORIGINS : false,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: [
        'Content-Type',
        'x-api-key',
        'idempotency-key',
        'x-idempotency-key',
        'x-actor-id',
      ],
    }),
  )

  .use(registerMutationRateLimit)
  .use(registerMutationAuthGuard)

  // Request logging
  .onRequest(({ request, set }) => {
    const requestId = getOrCreateRequestId(request);
    requestIds.set(request, requestId);
    set.headers['x-request-id'] = requestId;
    const requestContext = getHttpRequestLogContext(request);
    if (requestContext) {
      logDebug('HTTP Request', requestContext);
    }
  })

  // Global error handling
  .onError(({ code, error, request, set }) => {
    const requestId = requestIds.get(request) ?? getOrCreateRequestId(request);
    requestIds.set(request, requestId);
    set.headers['x-request-id'] = requestId;
    const message = getErrorMessage(error);
    const requestContext = getHttpRequestLogContext(request) ?? {
      method: request.method,
      pathname: new URL(request.url).pathname,
    };
    const logContext = { ...requestContext, requestId, code };

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
        const publicCode = getPublicErrorCode(error, status);
        return {
          success: false,
          error: getPublicErrorMessage(error, status),
          ...(publicCode ? { code: publicCode } : {}),
          ...(status >= 500 && process.env.NODE_ENV === 'production' ? { requestId } : {}),
        };
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
  .use(managerLiveAPI)
  .use(priceChangePredictionsAPI)
  .use(liveStatusAPI)
  .use(jobsAPI)
  .use(tournamentsAPI)
  .use(bugReportsAPI)
  .use(bugReportsStatusAPI)
  .use(understatAPI)
  .use(trendsAPI)
  .use(contentAPI)
  .use(dataGovernanceAPI)
  .use(clientSignalsAPI)

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

const shutdownController = createShutdownController({
  stopIntake: () => app.stop().then(() => undefined),
  closeResources: () =>
    Promise.all([
      closeAllProducerQueues(),
      databaseSingleton.disconnect(),
      redisSingleton.disconnect(),
      queueRedisSingleton.disconnect(),
    ]).then(() => undefined),
});

installShutdownSignals(shutdownController);
process.on('uncaughtException', (error) =>
  shutdownController.fatal(error, 'API uncaught exception'),
);
process.on('unhandledRejection', (error) =>
  shutdownController.fatal(error, 'API unhandled rejection'),
);

// Log startup after successful listen
logInfo('🚀 Elysia server started', {
  port,
  environment: process.env.NODE_ENV || 'development',
  authEnabled: ENABLE_AUTH,
  schedulerMode: isStandaloneSchedulerEnabled() ? 'standalone' : 'compatibility',
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
    'manager-live',
    'price-change-predictions',
    'jobs',
    'tournaments',
    'understat',
  ],
  jobs: schedulerRegistry.map((definition) => definition.name),
});

export { app };
export type AppInstance = typeof app;
