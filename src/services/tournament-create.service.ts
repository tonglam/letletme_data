import { createHash } from 'node:crypto';

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
  getPreviewCreatedRecord,
  claimPreviewCreation,
  getPreviewCreationClaim,
  markPreviewCreatedResult,
  markPreviewQueuedResult,
  releasePreviewCreationClaim,
  resolveTournamentPreview,
  waitForPreviewCreatedRecord,
  getPreviewQueuedRecord,
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
    let previewCreationBusy = false;

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
      const payloadFingerprint = previewPayloadFingerprint(payload);
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
      previewTokenHash = preview?.tokenHash ?? null;
      if (preview) {
        const created = unwrapPreviewResult(
          await getPreviewCreatedRecord(preview.tokenHash),
          payloadFingerprint,
        );
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
        const claim = await claimPreviewCreation(preview.tokenHash, payloadFingerprint);
        if (claim === 'busy') {
          const concurrent = unwrapPreviewResult(
            await waitForPreviewCreatedRecord(preview.tokenHash),
            payloadFingerprint,
          );
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
          // Continue through planning so a completed PostgreSQL creation can
          // repair a lost Redis result cache without creating a duplicate.
          previewCreationBusy = true;
        } else {
          previewClaimed = true;
          // The result lookup and NX claim are intentionally separate Redis
          // operations. Recheck after claiming so a retry that was suspended
          // between them cannot become a second writer after the first request
          // has already published its result and released the claim.
          const claimedCreated = unwrapPreviewResult(
            await getPreviewCreatedRecord(preview.tokenHash),
            payloadFingerprint,
          );
          if (
            claimedCreated &&
            typeof claimedCreated === 'object' &&
            'tournament' in claimedCreated
          ) {
            previewClaimed = false;
            await releasePreviewCreationClaim(preview.tokenHash).catch(() => undefined);
            report('queued', 'pending', null);
            return claimedCreated as {
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
        }
      }
      const source = preview ?? (await fetchLeagueParticipants(payload.leagueUrl));
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
        // PostgreSQL identity recovery is only safe for a retry that observed
        // this preview token's single-writer claim. A fresh token with the
        // same mutable tournament name must not attach to an older tournament.
        if (preview && previewCreationBusy) {
          const queued = unwrapPreviewResult(
            await getPreviewQueuedRecord(preview.tokenHash),
            payloadFingerprint,
          );
          if (queued && typeof queued === 'object' && 'tournament' in queued) {
            let resultRepaired = false;
            try {
              await markPreviewCreatedResult(preview.tokenHash, queued, payloadFingerprint);
              resultRepaired = true;
            } catch (error) {
              logInfo('Unable to repair tournament preview idempotency result', {
                event: 'tournament_preview_result_repair_failed',
                error: error instanceof Error ? error.name : 'UnknownError',
              });
            }
            // This retry did not acquire the single-writer claim. If Redis
            // still rejects the final-result repair, keep the original claim
            // so a later retry remains on the queued-evidence path instead of
            // starting a second creation attempt.
            if (resultRepaired) {
              previewClaimed = false;
              await releasePreviewCreationClaim(preview.tokenHash).catch(() => undefined);
            }
            const recovered = queued as {
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
            report('queued', recovered.setupStatus, null);
            return recovered;
          }

          // The process may have committed PostgreSQL and died before writing
          // queued/result evidence. A busy claim still carries the operation
          // fingerprint and start time, so recover only a row created by this
          // exact preview operation; an older same-name tournament is never
          // treated as idempotent success.
          const claimRecord = await getPreviewCreationClaim(preview.tokenHash);
          const persisted = await tournamentInfoRepository.findCreatedByIdentity(season, {
            name: plan.tournamentName,
            adminEntryId: Number(payload.adminId),
            leagueId: plan.leagueId,
          });
          const sameOperation =
            claimRecord?.payloadFingerprint === payloadFingerprint &&
            Boolean(persisted?.createdAt) &&
            Date.parse(persisted!.createdAt!) >= Date.parse(claimRecord.startedAt);
          if (sameOperation && persisted) {
            await enqueueTournamentSetup(season, persisted.id, 'create');
            const setupStatus =
              (await tournamentInfoRepository.findSetupStatus(season, persisted.id))?.setupStatus ??
              'pending';
            const recovered = {
              tournament: {
                id: persisted.id,
                name: persisted.name,
                creator: persisted.creator,
                adminEntryId: persisted.adminEntryId,
                leagueId: persisted.leagueId,
                participantCount: persisted.totalTeamNum,
              },
              setupStatus,
            } as const;
            let resultCached = false;
            try {
              await markPreviewCreatedResult(preview.tokenHash, recovered, payloadFingerprint);
              await markPreviewQueuedResult(preview.tokenHash, recovered, payloadFingerprint);
              resultCached = true;
            } catch (error) {
              logInfo('Unable to cache recovered tournament preview result', {
                event: 'tournament_preview_recovery_cache_failed',
                error: error instanceof Error ? error.name : 'UnknownError',
              });
            }
            if (resultCached) {
              await releasePreviewCreationClaim(preview.tokenHash).catch(() => undefined);
            }
            report('queued', setupStatus, null);
            return recovered;
          }
        }
        throw new ConflictError('Tournament name already exists.', 'TOURNAMENT_NAME_EXISTS');
      }
      if (previewCreationBusy) {
        throw new ConflictError(
          'Tournament creation is already in progress. Please retry shortly.',
          'TOURNAMENT_CREATE_IN_PROGRESS',
        );
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
        let createdResultCached = false;
        try {
          await markPreviewCreatedResult(previewTokenHash, result, payloadFingerprint);
          createdResultCached = true;
        } catch (error) {
          logInfo('Unable to persist tournament preview created result', {
            event: 'tournament_preview_created_result_cache_failed',
            tournamentId: tournament.id,
            error: error instanceof Error ? error.name : 'UnknownError',
          });
        }
        try {
          // Publish operation evidence only after the authoritative queue add
          // has succeeded. A concurrent retry must never infer success from a
          // PostgreSQL row whose setup job is still stalled or unpublished.
          await markPreviewQueuedResult(previewTokenHash, result, payloadFingerprint);
        } catch (error) {
          logInfo('Unable to persist tournament preview idempotency result', {
            event: 'tournament_preview_result_cache_failed',
            tournamentId: tournament.id,
            error: error instanceof Error ? error.name : 'UnknownError',
          });
        } finally {
          // A final result is enough for a retry to return idempotently. If
          // only queued evidence was written, retain the claim so recovery can
          // repair the final-result key instead of creating a duplicate.
          if (previewClaimed && createdResultCached) {
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

function previewPayloadFingerprint(payload: TournamentCreateInput): string {
  const canonical = {
    tournamentName: payload.tournamentName,
    adminId: payload.adminId,
    creator: payload.creator,
    participantSource: payload.participantSource,
    tournamentType: payload.tournamentType ?? null,
    leagueUrl: payload.leagueUrl,
    groupFormat: payload.groupFormat,
    startGameweek: payload.startGameweek.toUpperCase(),
    endGameweek: payload.endGameweek.toUpperCase(),
    groupNum: payload.groupNum ?? '',
    qualifiersPerGroup: payload.qualifiersPerGroup ?? '',
    knockoutFormat: payload.knockoutFormat,
    selectedParticipantIds: [...(payload.selectedParticipantIds ?? [])].sort(),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function unwrapPreviewResult(
  record: { payloadFingerprint: string | null; result: unknown } | null,
  fingerprint: string,
): unknown | null {
  if (!record || !record.result || typeof record.result !== 'object') return null;
  if (!('tournament' in record.result)) return null;
  if (record.payloadFingerprint !== fingerprint) {
    throw new ConflictError(
      'This preview token was already used with a different tournament payload.',
      'PREVIEW_PAYLOAD_MISMATCH',
    );
  }
  return record.result;
}
