import {
  normalizeTournamentName,
  parseGameweek,
  planTournamentStructure,
  selectParticipants,
  tournamentCreateInputSchema,
  uniqueParticipantIds,
  validateTournamentCreateInput,
  type TournamentCreateInput,
  type TournamentSetupStatus,
} from '../domain/tournament';
import { enqueueTournamentSetup } from '../jobs/tournament-setup.jobs';
import { tournamentInfoRepository } from '../repositories/tournament-infos';
import { seasonRepository } from '../repositories/seasons';
import { ConflictError, getHttpStatusFromError, ValidationError } from '../utils/errors';
import {
  getFplRequestMetricsSnapshot,
  runWithFplRequestMetrics,
} from '../utils/fpl-request-metrics';
import { getConfig } from '../utils/config';
import { logInfo } from '../utils/logger';
import { fetchLeagueParticipants } from './tournament-league-members.service';
import {
  getPreviewCreatedResult,
  claimPreviewCreation,
  markPreviewCreatedResult,
  releasePreviewCreationClaim,
  resolveTournamentPreview,
  waitForPreviewCreatedResult,
} from './tournament-preview.service';

export { tournamentCreateInputSchema, validateTournamentCreateInput };
export type { TournamentCreateInput, TournamentSetupStatus };

export async function checkTournamentNameAvailability(name: string) {
  const normalizedName = normalizeTournamentName(name);
  if (normalizedName.length < 3) {
    return {
      available: false,
      message: 'Tournament name must be at least 3 characters.',
    };
  }

  const season = await seasonRepository.findCurrent();
  const exists = await tournamentInfoRepository.checkNameExists(season, normalizedName);

  return {
    available: !exists,
    message: exists ? 'Tournament name already exists.' : 'Tournament name is available.',
  };
}

export async function getTournamentSetupStatus(tournamentId: number) {
  const season = await seasonRepository.findCurrent();
  return tournamentInfoRepository.findSetupStatus(season, tournamentId);
}

export async function createTournament(payload: TournamentCreateInput): Promise<{
  tournament: {
    id: number;
    name: string;
    creator: string;
    adminEntryId: number;
    leagueId: number;
    participantCount: number;
  };
  setupStatus: TournamentSetupStatus;
}> {
  return runWithFplRequestMetrics(async () => {
    const startedAtMs = performance.now();
    const phaseDurationsMs = {
      authoritative_roster: 0,
      planning: 0,
      persistence: 0,
      cache_invalidation: 0,
      enqueue: 0,
    };
    let failedPhase: keyof typeof phaseDurationsMs | null = 'authoritative_roster';
    let phaseStartedAtMs = performance.now();
    let tournamentId: number | null = null;
    let participantCount: number | null = null;
    let rosterMode: 'snapshot' | 'official_sync' | null = null;
    let leagueType: 'classic' | 'h2h' | null = null;
    let reportEmitted = false;
    let eventCount = 0;
    let previewTokenHash: string | null = null;
    let previewClaimed = false;

    const report = (
      outcome: 'queued' | 'enqueue_failed' | 'rejected' | 'failed',
      setupStatus: TournamentSetupStatus | null,
      failureCode: string | null,
    ) => {
      if (reportEmitted) return;
      reportEmitted = true;
      logInfo('Tournament creation report', {
        event: 'tournament_creation',
        outcome,
        tournamentId,
        participantCount,
        eventCount,
        rosterMode,
        leagueType,
        setupStatus,
        failedPhase,
        failureCode,
        phaseDurationsMs,
        totalDurationMs: Math.round(performance.now() - startedAtMs),
        fpl: getFplRequestMetricsSnapshot(),
      });
    };

    try {
      // The API also validates this boundary, but this service has direct
      // callers. Reject malformed requests before database or upstream work.
      try {
        payload = validateTournamentCreateInput(payload);
      } catch (error) {
        throw new ValidationError(
          'Invalid tournament creation request.',
          'TOURNAMENT_CREATE_INVALID',
          error,
        );
      }
      const startEventId = parseGameweek(payload.startGameweek);
      const endEventId = parseGameweek(payload.endGameweek);
      eventCount = startEventId && endEventId ? Math.max(0, endEventId - startEventId + 1) : 0;
      const season = await seasonRepository.findCurrent();
      const preview = payload.previewToken
        ? await resolveTournamentPreview(payload.previewToken, {
            ownerEntryId: payload.adminId,
            leagueUrl: payload.leagueUrl,
          })
        : null;
      if (preview) {
        const created = await getPreviewCreatedResult(preview.tokenHash);
        if (created && typeof created === 'object' && 'tournament' in created) {
          report('queued', 'pending', null);
          return created as {
            tournament: {
              id: number;
              name: string;
              creator: string;
              adminEntryId: number;
              leagueId: number;
              participantCount: number;
            };
            setupStatus: TournamentSetupStatus;
          };
        }
        const claim = await claimPreviewCreation(preview.tokenHash);
        if (claim === 'busy') {
          const concurrent = await waitForPreviewCreatedResult(preview.tokenHash);
          if (concurrent && typeof concurrent === 'object' && 'tournament' in concurrent) {
            report('queued', 'pending', null);
            return concurrent as {
              tournament: {
                id: number;
                name: string;
                creator: string;
                adminEntryId: number;
                leagueId: number;
                participantCount: number;
              };
              setupStatus: TournamentSetupStatus;
            };
          }
          throw new ConflictError(
            'Tournament creation is already in progress. Please retry shortly.',
            'TOURNAMENT_CREATE_IN_PROGRESS',
          );
        }
        previewClaimed = true;
      }
      const source = preview ?? (await fetchLeagueParticipants(payload.leagueUrl));
      previewTokenHash = preview?.tokenHash ?? null;
      phaseDurationsMs.authoritative_roster = Math.round(performance.now() - phaseStartedAtMs);
      leagueType = source.leagueType;

      failedPhase = 'planning';
      phaseStartedAtMs = performance.now();
      const selectedParticipantIds = uniqueParticipantIds(payload.selectedParticipantIds);
      const selectedParticipants = selectParticipants(
        payload.participantSource,
        source.participants,
        selectedParticipantIds,
      );
      const planned = planTournamentStructure(
        payload,
        selectedParticipants,
        source.leagueId,
        source.leagueType,
        source.leagueName,
        {
          startEventId: source.startEventId,
          knockoutRounds: source.knockoutRounds,
        },
      );
      const plan =
        planned.rosterMode === 'official_sync' &&
        planned.leagueType !== 'h2h' &&
        !getConfig().TOURNAMENT_OFFICIAL_SYNC_DEFAULT_ENABLED
          ? { ...planned, rosterMode: 'snapshot' as const }
          : planned;
      participantCount = plan.selectedParticipants.length;
      rosterMode = plan.rosterMode ?? 'snapshot';
      if (await tournamentInfoRepository.checkNameExists(season, plan.tournamentName)) {
        throw new ConflictError('Tournament name already exists.', 'TOURNAMENT_NAME_EXISTS');
      }
      phaseDurationsMs.planning = Math.round(performance.now() - phaseStartedAtMs);

      failedPhase = 'persistence';
      phaseStartedAtMs = performance.now();
      const tournament = await tournamentInfoRepository.createTournamentWithEntries(season, plan);
      tournamentId = tournament.id;
      phaseDurationsMs.persistence = Math.round(performance.now() - phaseStartedAtMs);

      const resultFor = (setupStatus: TournamentSetupStatus) => ({
        tournament: {
          id: tournament.id,
          name: tournament.name,
          creator: tournament.creator,
          adminEntryId: tournament.adminEntryId,
          leagueId: tournament.leagueId,
          participantCount: tournament.totalTeamNum,
        },
        setupStatus,
      });

      failedPhase = 'enqueue';
      phaseStartedAtMs = performance.now();
      let result: ReturnType<typeof resultFor>;
      try {
        await enqueueTournamentSetup(season, tournament.id, 'create');
        phaseDurationsMs.enqueue = Math.round(performance.now() - phaseStartedAtMs);
        failedPhase = null;
        report('queued', 'pending', null);
        result = resultFor('pending');
      } catch (error) {
        phaseDurationsMs.enqueue = Math.round(performance.now() - phaseStartedAtMs);
        const message =
          error instanceof Error ? error.message : 'Failed to enqueue tournament setup.';
        const failureCode = safeCreationErrorCode(error);
        try {
          await tournamentInfoRepository.markSetupResult(season, tournament.id, 'failed', message);
        } catch (statusError) {
          report('enqueue_failed', 'failed', failureCode);
          throw statusError;
        }
        report('enqueue_failed', 'failed', failureCode);
        result = resultFor('failed');
      }
      // Redis preview bookkeeping is recoverable metadata. It must never turn
      // a successfully enqueued authoritative creation into a failed response.
      if (previewTokenHash) {
        try {
          await markPreviewCreatedResult(previewTokenHash, result);
        } catch (error) {
          logInfo('Unable to persist tournament preview idempotency result', {
            event: 'tournament_preview_result_cache_failed',
            tournamentId: tournament.id,
            error: error instanceof Error ? error.name : 'UnknownError',
          });
        } finally {
          if (previewClaimed) {
            try {
              await releasePreviewCreationClaim(previewTokenHash);
            } catch (error) {
              logInfo('Unable to release tournament preview creation claim', {
                event: 'tournament_preview_claim_release_failed',
                tournamentId: tournament.id,
                error: error instanceof Error ? error.name : 'UnknownError',
              });
            }
          }
        }
      }
      return result;
    } catch (error) {
      if (previewClaimed && previewTokenHash) {
        await releasePreviewCreationClaim(previewTokenHash).catch(() => undefined);
      }
      if (failedPhase && phaseDurationsMs[failedPhase] === 0) {
        phaseDurationsMs[failedPhase] = Math.round(performance.now() - phaseStartedAtMs);
      }
      const status = getHttpStatusFromError(error);
      report(
        status >= 400 && status < 500 ? 'rejected' : 'failed',
        null,
        safeCreationErrorCode(error),
      );
      throw error;
    }
  });
}

function safeCreationErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return error instanceof Error ? error.name : 'UNKNOWN_ERROR';
}
