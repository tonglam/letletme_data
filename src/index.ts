import { cors } from '@elysiajs/cors';
import { swagger } from '@elysiajs/swagger';
import { eventsApi } from 'api/events.api';
import { phasesApi } from 'api/phases.api';
import { playerStatsApi } from 'api/player-stats.api';
import { playerValuesApi } from 'api/player-values.api';
import { playersApi } from 'api/players.api';
import { teamsApi } from 'api/teams.api';
import { Elysia } from 'elysia';
import { getAppLogger } from 'infrastructure/logger/logger';
import { eventLivesJob } from 'job/event-lives.job';
import { eventsJob } from 'job/events.job';
import { fixturesJob } from 'job/fixtures.job';
import { phasesJob } from 'job/phases.job';
import { playerStatsJob } from 'job/player-stats.job';
import { playerValuesJob } from 'job/player-values.job';
import { playersJob } from 'job/players.job';
import { teamsJob } from 'job/teams.job';
import { getErrorStatus } from 'types/error.type';
import { toAPIError } from 'utils/error.util';

import { dependencies } from '@/dependencies';

const logger = getAppLogger();

const app = new Elysia()
  // --- plugins ---
  .use(cors())
  .use(swagger())
  // --- dependencies ---
  .decorate(dependencies)
  // api
  .use(eventsApi(dependencies))
  .use(phasesApi(dependencies))
  .use(teamsApi(dependencies))
  .use(playersApi(dependencies))
  .use(playerValuesApi(dependencies))
  .use(playerStatsApi(dependencies))
  // --- jobs ---
  .use(eventsJob(dependencies))
  .use(phasesJob(dependencies))
  .use(teamsJob(dependencies))
  .use(playersJob(dependencies))
  .use(playerValuesJob(dependencies))
  .use(playerStatsJob(dependencies))
  .use(fixturesJob(dependencies))
  .use(eventLivesJob(dependencies))

  // --- routes ---
  .get('/', () => 'Welcome to Letletme Data API')
  .get('/health', () => 'Relax, I am healthy!')
  .get('/ping', () => 'Pong!')
  .onError(({ code, error, set }) => {
    logger.error({ err: error, errorCode: code }, 'API Request Error');

    const apiError = toAPIError(error);

    set.status = getErrorStatus(apiError);

    return {
      error: {
        code: apiError.code,
        message: apiError.message,
        details: apiError.details,
      },
    };
  })
  .listen(process.env.PORT || 3000);

logger.info(`🦊 Elysia is running at http://${app.server?.hostname}:${app.server?.port}`);
