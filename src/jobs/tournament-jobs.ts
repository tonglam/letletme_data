import type { Elysia } from 'elysia';

import { registerTournamentBattleRaceResultsJobs } from './tournament-battle-race-results.jobs';
import { registerTournamentEventCupResultsJobs } from './tournament-event-cup-results.jobs';
import { registerTournamentEventPicksJobs } from './tournament-event-picks.jobs';
import { registerTournamentEventResultsJobs } from './tournament-event-results.jobs';
import {
  registerTournamentEventTransfersPostJobs,
  registerTournamentEventTransfersPreJobs,
} from './tournament-event-transfers.jobs';
import { registerTournamentInfoJobs } from './tournament-info.jobs';
import { registerTournamentKnockoutResultsJobs } from './tournament-knockout-results.jobs';
import { registerTournamentPointsRaceResultsJobs } from './tournament-points-race-results.jobs';

export function registerTournamentJobs(app: Elysia) {
  return app
    .use(registerTournamentEventPicksJobs)
    .use(registerTournamentEventResultsJobs)
    .use(registerTournamentEventTransfersPreJobs)
    .use(registerTournamentEventTransfersPostJobs)
    .use(registerTournamentEventCupResultsJobs)
    .use(registerTournamentInfoJobs)
    .use(registerTournamentPointsRaceResultsJobs)
    .use(registerTournamentBattleRaceResultsJobs)
    .use(registerTournamentKnockoutResultsJobs);
}
