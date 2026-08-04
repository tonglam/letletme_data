import { Elysia, t } from 'elysia';
import { ZodError } from 'zod';

import {
  checkTournamentNameAvailability,
  createTournament,
  getTournamentSetupStatus,
} from '../services/tournament-create.service';
import { validateTournamentCreateInput } from '../domain/tournament';
import { tournamentManagementService } from '../services/tournament-management.service';
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
    query: t.Object({ name: t.String({ minLength: 1 }) }),
  })
  .get(
    '/:tournamentId/setup-status',
    async ({ params, set }) => {
      const status = await getTournamentSetupStatus(params.tournamentId);

      if (!status) {
        set.status = 404;
        return { success: false, error: 'Tournament not found.' };
      }

      // setupError is internal diagnostics (stack fragments, infra details) — logged
      // server-side, never exposed on the public status payload.
      return {
        success: true,
        tournamentId: params.tournamentId,
        setupStatus: status.setupStatus,
        setupPhase: status.setupPhase,
        setupCompletedUnits: status.setupCompletedUnits,
        setupTotalUnits: status.setupTotalUnits,
        setupProgressUpdatedAt: status.setupProgressUpdatedAt,
        standingsReadyAt: status.standingsReadyAt,
        setupHasWarnings: status.setupWarningCount > 0,
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
    async ({ params, body, set }) => {
      try {
        const job = await tournamentManagementService.retrySetup(params.tournamentId, body);
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
      body: t.Object({ adminEntryId: t.Numeric() }),
    },
  )
  .post(
    '/:tournamentId/roster-sync',
    async ({ params, body, set }) => {
      try {
        const result = await tournamentManagementService.retryRoster(params.tournamentId, body);
        set.status = result.changed ? 202 : 200;
        return { success: true, ...result };
      } catch (error) {
        const { status, message } = mapErrorToResponse(error);
        set.status = status;
        return { success: false, error: message };
      }
    },
    {
      params: t.Object({ tournamentId: t.Numeric() }),
      body: t.Object({ adminEntryId: t.Numeric() }),
    },
  )
  .patch(
    '/:tournamentId/roster-mode',
    async ({ params, body, set }) => {
      try {
        const tournament = await tournamentManagementService.setRosterMode(
          params.tournamentId,
          body,
        );
        set.status = 202;
        return { success: true, tournament };
      } catch (error) {
        const { status, message } = mapErrorToResponse(error);
        set.status = status;
        return { success: false, error: message };
      }
    },
    {
      params: t.Object({ tournamentId: t.Numeric() }),
      body: t.Object({
        adminEntryId: t.Numeric(),
        rosterMode: t.Literal('official_sync'),
      }),
    },
  )
  .patch(
    '/:tournamentId/state',
    async ({ params, body, set }) => {
      try {
        const tournament = await tournamentManagementService.setTournamentState(
          params.tournamentId,
          body,
        );
        if (body.state === 'active' && tournament.state !== 'active') set.status = 202;
        return { success: true, tournament };
      } catch (error) {
        const { status, message } = mapErrorToResponse(error);
        set.status = status;
        return { success: false, error: message };
      }
    },
    {
      params: t.Object({ tournamentId: t.Numeric() }),
      body: t.Object({
        adminEntryId: t.Numeric(),
        state: t.Union([t.Literal('active'), t.Literal('inactive')]),
      }),
    },
  )
  .post(
    '/',
    async ({ body, set }) => {
      try {
        const payload = validateTournamentCreateInput(body);
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
        tournamentName: t.String({ minLength: 3, maxLength: 80 }),
        adminId: t.String(),
        creator: t.String({ minLength: 1, maxLength: 80 }),
        participantSource: t.Union([t.Literal('official'), t.Literal('custom')]),
        tournamentType: t.Optional(t.String()),
        leagueUrl: t.String({ minLength: 1, maxLength: 512 }),
        groupFormat: t.Union([t.Literal('none'), t.Literal('points')]),
        startGameweek: t.String(),
        endGameweek: t.String(),
        groupNum: t.Optional(t.String()),
        qualifiersPerGroup: t.Optional(t.String()),
        knockoutFormat: t.Union([t.Literal('none'), t.Literal('single'), t.Literal('double')]),
        selectedParticipantIds: t.Optional(t.Array(t.String(), { maxItems: 5000 })),
      }),
    },
  )
  .patch(
    '/:tournamentId',
    async ({ params, body, set }) => {
      try {
        const tournament = await tournamentManagementService.updateTournament(
          params.tournamentId,
          body,
        );
        return { success: true, tournament };
      } catch (error) {
        const { status, message } = mapErrorToResponse(error);
        set.status = status;
        return { success: false, error: message };
      }
    },
    {
      params: t.Object({ tournamentId: t.Numeric() }),
      body: t.Object({
        name: t.String({ minLength: 3, maxLength: 80 }),
        adminEntryId: t.Numeric(),
      }),
    },
  )
  .delete(
    '/:tournamentId',
    async ({ params, body, set }) => {
      try {
        const tournament = await tournamentManagementService.deleteTournament(
          params.tournamentId,
          body,
        );
        return {
          success: true,
          tournamentId: tournament.id,
          deletedName: tournament.name,
        };
      } catch (error) {
        const { status, message } = mapErrorToResponse(error);
        set.status = status;
        return { success: false, error: message };
      }
    },
    {
      params: t.Object({ tournamentId: t.Numeric() }),
      body: t.Object({ adminEntryId: t.Numeric() }),
    },
  );
