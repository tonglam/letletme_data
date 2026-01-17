import type { Elysia } from 'elysia';

import { registerLeagueEventPicksJobs } from './league-event-picks.jobs';
import { registerLeagueEventResultsJobs } from './league-event-results.jobs';

export function registerLeagueJobs(app: Elysia) {
  return app.use(registerLeagueEventPicksJobs).use(registerLeagueEventResultsJobs);
}
