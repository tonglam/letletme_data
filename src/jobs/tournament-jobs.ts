import type { Elysia } from 'elysia';

import { registerTournamentEventPicksJobs } from './tournament-event-picks.jobs';
import { registerTournamentEventResultsJobs } from './tournament-event-results.jobs';
import { registerTournamentEventTransfersPreJobs } from './tournament-event-transfers.jobs';
import { registerTournamentInfoJobs } from './tournament-info.jobs';

export function registerTournamentJobs(app: Elysia) {
  return app
    .use(registerTournamentEventPicksJobs)
    .use(registerTournamentEventResultsJobs)
    .use(registerTournamentEventTransfersPreJobs)
    .use(registerTournamentInfoJobs);
}
