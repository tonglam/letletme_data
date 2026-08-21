import { Elysia, t } from 'elysia';
import {
  checkTournamentNameAvailability,
  createTournament,
  getTournamentSetupStatus,
} from '../services/tournament-create.service';
import { validateTournamentCreateInput } from '../domain/tournament';
import { tournamentManagementService } from '../services/tournament-management.service';
import { createTournamentPreview } from '../services/tournament-preview.service';
import { mapTournamentErrorToResponse } from './tournament-errors';
import { getOrCreateRequestId } from '../utils/errors';
import { logError } from '../utils/logger';

function mapErrorToResponse(
  error: unknown,
  request: Request,
  set: { headers: Record<string, string | number>; status?: unknown },
): {
  status: number;
  body: { success: false; error: string; code?: string; requestId?: string };
} {
  const { status, message, code } = mapTournamentErrorToResponse(error);
  const requestId = getOrCreateRequestId(request);
  logError('Tournament request failed', error, { requestId });
  set.headers['x-request-id'] = requestId;
  return {
    status,
    body: {
      success: false,
      error: message,
      ...(code ? { code } : {}),
      ...(status >= 500 && process.env.NODE_ENV === 'production' ? { requestId } : {}),
    },
  };
}

const positiveInteger = t.Number({ minimum: 1, multipleOf: 1 });

export const tournamentsAPI = new Elysia({ prefix: '/tournaments' })
  .post(
    '/preview',
    async ({ body, request, set }) => {
      try {
        const preview = await createTournamentPreview(body);
        set.status = 200;
        return {
          success: true,
          previewToken: preview.previewToken,
          expiresAt: preview.expiresAt,
          sourceCheckedAt: preview.sourceCheckedAt,
          league: {
            id: preview.leagueId,
            type: preview.leagueType,
            name: preview.leagueName,
            startEventId: preview.startEventId,
            knockoutRounds: preview.knockoutRounds,
          },
          participants: preview.participants,
        };
      } catch (error) {
        const mapped = mapErrorToResponse(error, request, set);
        set.status = mapped.status;
        return mapped.body;
      }
    },
    {
      body: t.Object({
        leagueUrl: t.String({ minLength: 1, maxLength: 512 }),
        ownerEntryId: t.Union([positiveInteger, t.String({ minLength: 1 })]),
      }),
    },
  )
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
        setupProgressMode: status.setupProgressIndeterminate ? 'INDETERMINATE' : 'DETERMINATE',
        // Keep the short name for clients that consumed the first additive
        // status payload before the GraphQL field naming was finalized.
        progressMode: status.setupProgressIndeterminate ? 'INDETERMINATE' : 'DETERMINATE',
        setupAttempt: status.setupAttempt ?? 0,
        setupMaxAttempts: status.setupMaxAttempts ?? 3,
        nextRetryAt: status.setupNextRetryAt,
        standingsReadyAt: status.standingsReadyAt,
        setupHasWarnings: status.setupWarningCount > 0,
        warningSummaries: status.warningSummaries ?? [],
        profilesReadyAt: status.profilesReadyAt,
        insightsReadyAt: status.insightsReadyAt,
        setupStartedAt: status.setupStartedAt,
        setupFinishedAt: status.setupFinishedAt,
      };
    },
    {
      params: t.Object({ tournamentId: positiveInteger }),
    },
  )
  .post(
    '/:tournamentId/setup',
    async ({ params, body, request, set }) => {
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
        const mapped = mapErrorToResponse(error, request, set);
        set.status = mapped.status;
        return mapped.body;
      }
    },
    {
      params: t.Object({ tournamentId: positiveInteger }),
      body: t.Object({
        adminEntryId: positiveInteger,
        platformAdmin: t.Optional(t.Boolean()),
      }),
    },
  )
  .post(
    '/:tournamentId/roster-sync',
    async ({ params, body, request, set }) => {
      try {
        const result = await tournamentManagementService.retryRoster(params.tournamentId, body);
        set.status = result.queued || result.changed ? 202 : 200;
        return { success: true, ...result };
      } catch (error) {
        const mapped = mapErrorToResponse(error, request, set);
        set.status = mapped.status;
        return mapped.body;
      }
    },
    {
      params: t.Object({ tournamentId: positiveInteger }),
      body: t.Object({
        adminEntryId: positiveInteger,
        platformAdmin: t.Optional(t.Boolean()),
      }),
    },
  )
  .patch(
    '/:tournamentId/roster-mode',
    async ({ params, body, request, set }) => {
      try {
        const tournament = await tournamentManagementService.setRosterMode(
          params.tournamentId,
          body,
        );
        set.status = 202;
        return { success: true, tournament };
      } catch (error) {
        const mapped = mapErrorToResponse(error, request, set);
        set.status = mapped.status;
        return mapped.body;
      }
    },
    {
      params: t.Object({ tournamentId: positiveInteger }),
      body: t.Object({
        adminEntryId: positiveInteger,
        platformAdmin: t.Optional(t.Boolean()),
        rosterMode: t.Literal('official_sync'),
      }),
    },
  )
  .patch(
    '/:tournamentId/state',
    async ({ params, body, request, set }) => {
      try {
        const tournament = await tournamentManagementService.setTournamentState(
          params.tournamentId,
          body,
        );
        if (body.state === 'active' && tournament.state !== 'active') set.status = 202;
        return { success: true, tournament };
      } catch (error) {
        const mapped = mapErrorToResponse(error, request, set);
        set.status = mapped.status;
        return mapped.body;
      }
    },
    {
      params: t.Object({ tournamentId: positiveInteger }),
      body: t.Object({
        adminEntryId: positiveInteger,
        platformAdmin: t.Optional(t.Boolean()),
        state: t.Union([t.Literal('active'), t.Literal('inactive')]),
      }),
    },
  )
  .post(
    '/',
    async ({ body, request, set }) => {
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
        const mapped = mapErrorToResponse(error, request, set);
        set.status = mapped.status;
        return mapped.body;
      }
    },
    {
      body: t.Object({
        tournamentName: t.String({ minLength: 3, maxLength: 80 }),
        adminId: t.String(),
        creator: t.String({ minLength: 1, maxLength: 80 }),
        platformAdmin: t.Optional(t.Boolean()),
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
        previewToken: t.Optional(t.String({ minLength: 32, maxLength: 128 })),
      }),
    },
  )
  .patch(
    '/:tournamentId',
    async ({ params, body, request, set }) => {
      try {
        const tournament = await tournamentManagementService.updateTournament(
          params.tournamentId,
          body,
        );
        return { success: true, tournament };
      } catch (error) {
        const mapped = mapErrorToResponse(error, request, set);
        set.status = mapped.status;
        return mapped.body;
      }
    },
    {
      params: t.Object({ tournamentId: positiveInteger }),
      body: t.Object({
        name: t.String({ minLength: 3, maxLength: 80 }),
        adminEntryId: positiveInteger,
        platformAdmin: t.Optional(t.Boolean()),
      }),
    },
  )
  .delete(
    '/:tournamentId',
    async ({ params, body, request, set }) => {
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
        const mapped = mapErrorToResponse(error, request, set);
        set.status = mapped.status;
        return mapped.body;
      }
    },
    {
      params: t.Object({ tournamentId: positiveInteger }),
      body: t.Object({
        adminEntryId: positiveInteger,
        platformAdmin: t.Optional(t.Boolean()),
      }),
    },
  );
