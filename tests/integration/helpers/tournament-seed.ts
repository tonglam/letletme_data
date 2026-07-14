import {
  planTournamentStructure,
  type TournamentCreateInput,
  type TournamentParticipant,
  type TournamentStructurePlan,
} from '../../../src/domain/tournament';
import type { TournamentInfoSummary } from '../../../src/repositories/tournament-infos';
import { tournamentInfoRepository } from '../../../src/repositories/tournament-infos';
import { getCurrentEvent } from '../../../src/services/events.service';

export type IntegrationSeed = {
  currentEvent: NonNullable<Awaited<ReturnType<typeof getCurrentEvent>>>;
  tournamentId: number;
};

export type SeedMode = 'any' | 'points_races' | 'battle_races' | 'knockout';

const SEED_LEAGUE_ID = 900001;
const SEED_ADMIN_ID = '900001';
const SEED_CREATOR = 'integration-seed';
const SEED_LEAGUE_URL = 'https://fantasy.premierleague.com/leagues/900001/standings/c';

function buildStubParticipants(count: number): TournamentParticipant[] {
  return Array.from({ length: count }, (_, index) => {
    const id = SEED_LEAGUE_ID + index;
    return {
      id: String(id),
      team: `Seed Team ${id}`,
      manager: `Seed Manager ${id}`,
      overallRank: index + 1,
      totalPoints: 0,
    };
  });
}

function findMatchingTournament(
  tournaments: TournamentInfoSummary[],
  mode: SeedMode,
): TournamentInfoSummary | null {
  switch (mode) {
    case 'any':
      return tournaments[0] ?? null;
    case 'points_races':
      return tournaments.find((t) => t.groupMode === 'points_races') ?? null;
    case 'battle_races':
      return tournaments.find((t) => t.groupMode === 'battle_races') ?? null;
    case 'knockout':
      return tournaments.find((t) => t.knockoutMode !== 'no_knockout') ?? null;
  }
}

function buildBaseCreateInput(
  mode: SeedMode,
  endGameweek: string,
  knockoutFormat: TournamentCreateInput['knockoutFormat'],
  groupFormat: TournamentCreateInput['groupFormat'],
): TournamentCreateInput {
  return {
    tournamentName: `Integration Seed ${mode} ${Date.now()}`,
    adminId: SEED_ADMIN_ID,
    creator: SEED_CREATOR,
    participantSource: 'custom',
    leagueUrl: SEED_LEAGUE_URL,
    groupFormat,
    startGameweek: 'GW1',
    endGameweek,
    groupNum: '1',
    qualifiersPerGroup: '4',
    knockoutFormat,
    selectedParticipantIds: buildStubParticipants(4).map((p) => p.id),
  };
}

function buildTournamentPlan(mode: SeedMode, currentEventId: number): TournamentStructurePlan {
  const participants = buildStubParticipants(4);
  const endGw = Math.min(Math.max(currentEventId, 1), 38);

  if (mode === 'knockout') {
    // Group stage ends just before the current event so knockout window covers it.
    const groupEndGw = Math.max(currentEventId - 1, 1);
    const input = buildBaseCreateInput(mode, `GW${groupEndGw}`, 'single', 'none');
    const plan = planTournamentStructure(input, participants, SEED_LEAGUE_ID, 'classic');

    // Ensure the knockout window includes the current event (especially when GW is 1).
    if (
      plan.knockoutStartedEventId === null ||
      plan.knockoutEndedEventId === null ||
      plan.knockoutStartedEventId > currentEventId ||
      plan.knockoutEndedEventId < currentEventId
    ) {
      const rounds = plan.knockoutRounds ?? plan.knockoutEventNum ?? 1;
      plan.knockoutStartedEventId = currentEventId;
      plan.knockoutEndedEventId = Math.min(currentEventId + Math.max(rounds - 1, 0), 38);
    }

    return plan;
  }

  // points_races / battle_races / any — plan as points group format first
  const input = buildBaseCreateInput(mode, `GW${endGw}`, 'none', 'points');
  const plan = planTournamentStructure(input, participants, SEED_LEAGUE_ID, 'classic');

  if (mode === 'battle_races') {
    // Create input cannot express battle_races; mutate after planning.
    plan.groupMode = 'battle_races';
  }

  return plan;
}

/**
 * Resolve current event + an active tournament for integration tests.
 * Returns null only when getCurrentEvent() fails/returns null (infra missing).
 * Seeds a minimal tournament via createTournamentWithEntries when needed.
 */
export async function ensureIntegrationTournamentSeed(
  mode: SeedMode = 'any',
): Promise<IntegrationSeed | null> {
  let currentEvent: Awaited<ReturnType<typeof getCurrentEvent>>;
  try {
    currentEvent = await getCurrentEvent();
  } catch {
    return null;
  }

  if (!currentEvent) {
    return null;
  }

  const tournaments = await tournamentInfoRepository.findActive();
  const existing = findMatchingTournament(tournaments, mode);
  if (existing) {
    return { currentEvent, tournamentId: existing.id };
  }

  const plan = buildTournamentPlan(mode, currentEvent.id);
  const created = await tournamentInfoRepository.createTournamentWithEntries(plan);
  return { currentEvent, tournamentId: created.id };
}

export async function resolveIntegrationSeedAvailability(mode: SeedMode = 'any'): Promise<{
  canRun: boolean;
  seed: IntegrationSeed | null;
}> {
  try {
    const seed = await ensureIntegrationTournamentSeed(mode);
    return { canRun: seed !== null, seed };
  } catch {
    return { canRun: false, seed: null };
  }
}
