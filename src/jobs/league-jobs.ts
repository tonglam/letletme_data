import type { Elysia } from 'elysia';

import { registerLeagueEventResultsJobs } from './league-event-results.jobs';

export function registerLeagueJobs(app: Elysia) {
  return app.use(registerLeagueEventResultsJobs);
}
