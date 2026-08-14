import type { Elysia } from 'elysia';

import { registerTournamentEventResultsJobs } from './tournament-event-results.jobs';
import { registerTournamentInfoJobs } from './tournament-info.jobs';

export function registerTournamentJobs(app: Elysia) {
  return app.use(registerTournamentEventResultsJobs).use(registerTournamentInfoJobs);
}
