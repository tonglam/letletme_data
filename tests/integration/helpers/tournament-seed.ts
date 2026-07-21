import { afterAll } from 'bun:test';

import {
  planTournamentStructure,
  type TournamentCreateInput,
  type TournamentParticipant,
  type TournamentStructurePlan,
} from '../../../src/domain/tournament';
import { getDbClient } from '../../../src/db/singleton';
import type { TournamentInfoSummary } from '../../../src/repositories/tournament-infos';
import { tournamentInfoRepository } from '../../../src/repositories/tournament-infos';
import { getCurrentEvent } from '../../../src/services/events.service';
import { ensureEvents } from './reference-data';

export type IntegrationSeed = {
  currentEvent: NonNullable<Awaited<ReturnType<typeof getCurrentEvent>>>;
  tournamentId: number;
};

export type SeedMode = 'any' | 'points_races' | 'battle_races' | 'knockout';

// Synthetic entry IDs live far outside the real FPL entry id space (~12M max),
// so seeded rows can never collide with — or be mistaken for — real data.
const SEED_ENTRY_BASE = 99000001;
const SEED_LEAGUE_ID = 900001;
const SEED_ADMIN_ID = String(SEED_ENTRY_BASE);
const SEED_CREATOR = 'integration-seed';
const SEED_LEAGUE_URL = 'https://fantasy.premierleague.com/leagues/900001/standings/c';

// Tournaments created by this module (never pre-existing ones it reuses),
// so afterAll can remove exactly the rows the seed wrote.
const seededTournamentIds: number[] = [];
// Entry IDs this helper actually inserted — do not wipe the whole synthetic
// range (other integration tests use IDs like 99000201 outside our stubs).
const seededEntryIds = new Set<number>();

function buildStubParticipants(count: number): TournamentParticipant[] {
  return Array.from({ length: count }, (_, index) => {
    const id = SEED_ENTRY_BASE + index;
    return {
      id: String(id),
      team: `Seed Team ${id}`,
      manager: `Seed Manager ${id}`,
      overallRank: index + 1,
      totalPoints: 0,
    };
  });
}

function trackSeededEntries(participants: TournamentParticipant[]): void {
  for (const participant of participants) {
    const id = Number.parseInt(participant.id, 10);
    if (Number.isFinite(id)) {
      seededEntryIds.add(id);
    }
  }
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
    await ensureEvents();
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
  seededTournamentIds.push(created.id);
  trackSeededEntries(buildStubParticipants(4));
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

/**
 * Delete exactly what the seed wrote: tournaments this module created (child
 * rows first — tournament FKs have no ON DELETE cascade) and the stub entry
 * rows it inserted. Tournaments it merely reused are left untouched; other
 * tests' synthetic entry IDs outside this helper's inserts are preserved.
 */
export async function cleanupIntegrationTournamentSeeds(): Promise<void> {
  const tournamentIds = seededTournamentIds.splice(0);
  const entryIds = [...seededEntryIds];
  seededEntryIds.clear();
  const client = await getDbClient();

  await client.begin(async (tx) => {
    for (const tournamentId of tournamentIds) {
      await tx`DELETE FROM tournament_points_group_results WHERE tournament_id = ${tournamentId}`;
      await tx`DELETE FROM tournament_battle_group_results WHERE tournament_id = ${tournamentId}`;
      await tx`DELETE FROM tournament_knockout_results WHERE tournament_id = ${tournamentId}`;
      await tx`DELETE FROM tournament_knockouts WHERE tournament_id = ${tournamentId}`;
      await tx`DELETE FROM tournament_groups WHERE tournament_id = ${tournamentId}`;
      await tx`DELETE FROM tournament_entries WHERE tournament_id = ${tournamentId}`;
      await tx`DELETE FROM tournament_infos WHERE id = ${tournamentId}`;
    }

    if (entryIds.length === 0) {
      return;
    }

    await tx`DELETE FROM entry_event_cup_results WHERE entry_id = ANY(${entryIds})`;
    await tx`DELETE FROM entry_event_results WHERE entry_id = ANY(${entryIds})`;
    await tx`DELETE FROM entry_event_picks WHERE entry_id = ANY(${entryIds})`;
    await tx`DELETE FROM entry_event_transfers WHERE entry_id = ANY(${entryIds})`;
    await tx`DELETE FROM entry_history_infos WHERE entry_id = ANY(${entryIds})`;
    await tx`DELETE FROM entry_league_infos WHERE entry_id = ANY(${entryIds})`;
    await tx`DELETE FROM entry_infos WHERE id = ANY(${entryIds})`;
  });
}

afterAll(async () => {
  await cleanupIntegrationTournamentSeeds();
});
