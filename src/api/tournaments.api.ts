import { Elysia, t } from 'elysia';
import { ZodError } from 'zod';

import {
  checkTournamentNameAvailability,
  createTournament,
  getTournamentSetupStatus,
  tournamentCreateInputSchema,
} from '../services/tournament-create.service';
import { requeueTournamentSetup } from '../services/tournament-setup.service';
import { getErrorMessage, getHttpStatusFromError } from '../utils/errors';

function mapErrorToResponse(error: unknown): { status: number; message: string } {
  if (error instanceof ZodError) {
    return {
      status: 400,
      message: error.issues.map((issue) => issue.message).join('; ') || 'Invalid request payload.',
    };
  }
  return { status: getHttpStatusFromError(error), message: getErrorMessage(error) };
}

export const tournamentsAPI = new Elysia({ prefix: '/tournaments' })
  .get('/check-name', async ({ query }) => checkTournamentNameAvailability(query.name), {
    query: t.Object({ name: t.String() }),
  })
  .get(
    '/:tournamentId/setup-status',
    async ({ params, set }) => {
      const status = await getTournamentSetupStatus(params.tournamentId);

      if (!status) {
        set.status = 404;
        return { success: false, error: 'Tournament not found.' };
      }

      return {
        success: true,
        tournamentId: params.tournamentId,
        setupStatus: status.setupStatus,
        setupError: status.setupError,
        setupStartedAt: status.setupStartedAt,
        setupFinishedAt: status.setupFinishedAt,
      };
    },
    {
      params: t.Object({ tournamentId: t.Numeric() }),
    },
  )
  .post(
    '/:tournamentId/setup',
    async ({ params, set }) => {
      try {
        const job = await requeueTournamentSetup(params.tournamentId);
        set.status = 202;
        return {
          success: true,
          tournamentId: params.tournamentId,
          jobId: job.id,
          setupStatus: 'pending',
        };
      } catch (error) {
        const { status, message } = mapErrorToResponse(error);
        set.status = status;
        return { success: false, error: message };
      }
    },
    {
      params: t.Object({ tournamentId: t.Numeric() }),
    },
  )
  .post(
    '/',
    async ({ body, set }) => {
      try {
        const payload = tournamentCreateInputSchema.parse(body);
        const result = await createTournament(payload);
        set.status = result.setupStatus === 'failed' ? 202 : 201;
        return {
          success: true,
          tournament: result.tournament,
          setupStatus: result.setupStatus,
        };
      } catch (error) {
        const { status, message } = mapErrorToResponse(error);
        set.status = status;
        return { success: false, error: message };
      }
    },
    {
      body: t.Object({
        tournamentName: t.String(),
        adminId: t.String(),
        creator: t.String(),
        participantSource: t.Union([t.Literal('official'), t.Literal('custom')]),
        tournamentType: t.Optional(t.String()),
        leagueUrl: t.String(),
        groupFormat: t.Union([t.Literal('none'), t.Literal('points')]),
        startGameweek: t.String(),
        endGameweek: t.String(),
        groupNum: t.Optional(t.String()),
        qualifiersPerGroup: t.Optional(t.String()),
        knockoutFormat: t.Union([t.Literal('none'), t.Literal('single'), t.Literal('double')]),
        selectedParticipantIds: t.Optional(t.Array(t.String())),
      }),
    },
  );
