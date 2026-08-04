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
import { ConflictError, getHttpStatusFromError } from '../utils/errors';
import {
  getFplRequestMetricsSnapshot,
  runWithFplRequestMetrics,
} from '../utils/fpl-request-metrics';
import { getConfig } from '../utils/config';
import { logInfo } from '../utils/logger';
import { invalidateTournamentGraphQLCaches } from '../cache/tournament-graphql-cache';
import { fetchLeagueParticipants } from './tournament-league-members.service';

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

  const exists = await tournamentInfoRepository.checkNameExists(normalizedName);

  return {
    available: !exists,
    message: exists ? 'Tournament name already exists.' : 'Tournament name is available.',
  };
}

export async function getTournamentSetupStatus(tournamentId: number) {
  return tournamentInfoRepository.findSetupStatus(tournamentId);
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
    const startEventId = parseGameweek(payload.startGameweek);
    const endEventId = parseGameweek(payload.endGameweek);
    const eventCount = startEventId && endEventId ? Math.max(0, endEventId - startEventId + 1) : 0;

    const report = (
      outcome: 'queued' | 'enqueue_failed' | 'rejected' | 'failed',
      setupStatus: TournamentSetupStatus | null,
      failureCode: string | null,
    ) => {
      if (reportEmitted) return;
      reportEmitted = true;
      logInfo('Tournament creation report', {
        event: 'tournament_creation',
        schemaVersion: 1,
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
      const source = await fetchLeagueParticipants(payload.leagueUrl);
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
      );
      const plan =
        planned.rosterMode === 'official_sync' &&
        !getConfig().TOURNAMENT_OFFICIAL_SYNC_DEFAULT_ENABLED
          ? { ...planned, rosterMode: 'snapshot' as const }
          : planned;
      participantCount = plan.selectedParticipants.length;
      rosterMode = plan.rosterMode ?? 'snapshot';
      if (await tournamentInfoRepository.checkNameExists(plan.tournamentName)) {
        throw new ConflictError('Tournament name already exists.', 'TOURNAMENT_NAME_EXISTS');
      }
      phaseDurationsMs.planning = Math.round(performance.now() - phaseStartedAtMs);

      failedPhase = 'persistence';
      phaseStartedAtMs = performance.now();
      const tournament = await tournamentInfoRepository.createTournamentWithEntries(plan);
      tournamentId = tournament.id;
      phaseDurationsMs.persistence = Math.round(performance.now() - phaseStartedAtMs);

      failedPhase = 'cache_invalidation';
      phaseStartedAtMs = performance.now();
      await invalidateTournamentGraphQLCaches('create');
      phaseDurationsMs.cache_invalidation = Math.round(performance.now() - phaseStartedAtMs);

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
      try {
        await enqueueTournamentSetup(tournament.id, 'create');
        phaseDurationsMs.enqueue = Math.round(performance.now() - phaseStartedAtMs);
        failedPhase = null;
        report('queued', 'pending', null);
        return resultFor('pending');
      } catch (error) {
        phaseDurationsMs.enqueue = Math.round(performance.now() - phaseStartedAtMs);
        const message =
          error instanceof Error ? error.message : 'Failed to enqueue tournament setup.';
        const failureCode = safeCreationErrorCode(error);
        try {
          await tournamentInfoRepository.markSetupResult(tournament.id, 'failed', message);
        } catch (statusError) {
          report('enqueue_failed', 'failed', failureCode);
          throw statusError;
        }
        report('enqueue_failed', 'failed', failureCode);
        return resultFor('failed');
      }
    } catch (error) {
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
