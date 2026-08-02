import {
  normalizeTournamentName,
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
import { ConflictError } from '../utils/errors';
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
  const { leagueId, leagueType, participants } = await fetchLeagueParticipants(payload.leagueUrl);
  const selectedParticipantIds = uniqueParticipantIds(payload.selectedParticipantIds);
  const selectedParticipants = selectParticipants(
    payload.participantSource,
    participants,
    selectedParticipantIds,
  );

  const plan = planTournamentStructure(payload, selectedParticipants, leagueId, leagueType);

  if (await tournamentInfoRepository.checkNameExists(plan.tournamentName)) {
    throw new ConflictError('Tournament name already exists.', 'TOURNAMENT_NAME_EXISTS');
  }

  const tournament = await tournamentInfoRepository.createTournamentWithEntries(plan);

  try {
    await enqueueTournamentSetup(tournament.id, 'create');
    return {
      tournament: {
        id: tournament.id,
        name: tournament.name,
        creator: tournament.creator,
        adminEntryId: tournament.adminEntryId,
        leagueId: tournament.leagueId,
        participantCount: tournament.totalTeamNum,
      },
      setupStatus: 'pending',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to enqueue tournament setup.';
    await tournamentInfoRepository.markSetupResult(tournament.id, 'failed', message);

    return {
      tournament: {
        id: tournament.id,
        name: tournament.name,
        creator: tournament.creator,
        adminEntryId: tournament.adminEntryId,
        leagueId: tournament.leagueId,
        participantCount: tournament.totalTeamNum,
      },
      setupStatus: 'failed',
    };
  }
}
