import { afterAll, beforeAll, describe, test } from '@jest/globals';
import { prisma, startServer, stopServer } from '../src';
import { supabase } from '../src/configs/supabase.config';
import { upsertStaticData } from '../src/services/upsertDataService';
import {
  createEventsTable,
  createPhasesTable,
  createPlayersTable,
  createTeamsTable,
} from './setupDatabase.test';

describe('upsertStaticData', () => {
  beforeAll(async () => {
    try {
      startServer(0);
      await prisma.$executeRaw`DROP TABLE IF EXISTS "players" CASCADE`;
      await prisma.$executeRaw`DROP TABLE IF EXISTS "teams" CASCADE`;
      await prisma.$executeRaw`DROP TABLE IF EXISTS "phases" CASCADE`;
      await prisma.$executeRaw`DROP TABLE IF EXISTS "events" CASCADE`;

      await createEventsTable();
      await createPhasesTable();
      await createTeamsTable();
      await createPlayersTable();
      console.log('Database setup completed');
    } catch (error) {
      console.error('Database setup error:', error);
      throw error;
    }
  }, 30000);

  afterEach(async () => {
    await stopServer();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await supabase.auth.signOut();
    await new Promise<void>((resolve) => setTimeout(() => resolve(), 500));
  });

  test('should upsert events data correctly', async () => {
    await upsertStaticData();

    const prismaEvents = await prisma.event.findMany();
    expect(prismaEvents.length).toBeGreaterThan(0);

    const { data: supabaseEvents, error: eventsError } = await supabase.from('events').select('*');
    if (eventsError) throw eventsError;

    expect(supabaseEvents).toBeDefined();
    expect(supabaseEvents.length).toBe(prismaEvents.length);

    const firstPrismaEvent = prismaEvents[0];
    const firstSupabaseEvent = supabaseEvents[0];

    expect(firstSupabaseEvent.id).toBe(firstPrismaEvent.id);
    expect(firstSupabaseEvent.name).toBe(firstPrismaEvent.name);
    expect(new Date(firstSupabaseEvent.deadline_time)).toEqual(firstPrismaEvent.deadlineTime);
  }, 30000);

  test('should upsert phases data correctly', async () => {
    await upsertStaticData();

    const prismaPhases = await prisma.phase.findMany();
    expect(prismaPhases.length).toBeGreaterThan(0);

    const { data: supabasePhases, error: phasesError } = await supabase.from('phases').select('*');
    if (phasesError) throw phasesError;

    expect(supabasePhases).toBeDefined();
    expect(supabasePhases.length).toBe(prismaPhases.length);

    const firstPrismaPhase = prismaPhases[0];
    const firstSupabasePhase = supabasePhases[0];

    expect(firstSupabasePhase.id).toBe(firstPrismaPhase.id);
    expect(firstSupabasePhase.name).toBe(firstPrismaPhase.name);
    expect(firstSupabasePhase.start_event).toBe(firstPrismaPhase.startEvent);
    expect(firstSupabasePhase.stop_event).toBe(firstPrismaPhase.stopEvent);
  }, 15000);

  test('should upsert teams data correctly', async () => {
    await upsertStaticData();

    const prismaTeams = await prisma.team.findMany();
    expect(prismaTeams.length).toBeGreaterThan(0);

    const { data: supabaseTeams, error: teamsError } = await supabase.from('teams').select('*');
    if (teamsError) throw teamsError;

    expect(supabaseTeams).toBeDefined();
    expect(supabaseTeams.length).toBe(prismaTeams.length);

    const firstPrismaTeam = prismaTeams[0];
    const firstSupabaseTeam = supabaseTeams[0];

    expect(firstSupabaseTeam.id).toBe(firstPrismaTeam.id);
    expect(firstSupabaseTeam.code).toBe(firstPrismaTeam.code);
    expect(firstSupabaseTeam.name).toBe(firstPrismaTeam.name);
    expect(firstSupabaseTeam.strength).toBe(firstPrismaTeam.strength);
    expect(firstSupabaseTeam.pulse_id).toBe(firstPrismaTeam.pulseId);
  }, 15000);

  test('should upsert players data correctly', async () => {
    await upsertStaticData();

    const prismaPlayers = await prisma.player.findMany();
    expect(prismaPlayers.length).toBeGreaterThan(0);

    const { data: supabasePlayers, error: playersError } = await supabase
      .from('players')
      .select('*');
    if (playersError) throw playersError;

    expect(supabasePlayers).toBeDefined();
    expect(supabasePlayers.length).toBe(prismaPlayers.length);

    const firstPrismaPlayer = prismaPlayers[0];
    const firstSupabasePlayer = supabasePlayers[0];

    expect(firstSupabasePlayer.element).toBe(firstPrismaPlayer.element);
    expect(firstSupabasePlayer.element_code).toBe(firstPrismaPlayer.elementCode);
    expect(firstSupabasePlayer.price).toBe(firstPrismaPlayer.price);
    expect(firstSupabasePlayer.start_price).toBe(firstPrismaPlayer.startPrice);
    expect(firstSupabasePlayer.element_type).toBe(firstPrismaPlayer.elementType);
    expect(firstSupabasePlayer.web_name).toBe(firstPrismaPlayer.webName);
    expect(firstSupabasePlayer.team_id).toBe(firstPrismaPlayer.teamId);
    expect(firstSupabasePlayer.first_name).toBe(firstPrismaPlayer.firstName);
    expect(firstSupabasePlayer.second_name).toBe(firstPrismaPlayer.secondName);
  }, 15000);

  test('should handle nullable fields correctly for teams', async () => {
    await upsertStaticData();
    const prismaTeams = await prisma.team.findMany();
    const team = prismaTeams[0];

    expect(typeof team.form === 'string' || team.form === null).toBe(true);
    expect(typeof team.teamDivision === 'string' || team.teamDivision === null).toBe(true);

    expect(typeof team.played === 'number').toBe(true);
    expect(typeof team.position === 'number').toBe(true);
    expect(typeof team.points === 'number').toBe(true);
    expect(typeof team.win === 'number').toBe(true);
    expect(typeof team.draw === 'number').toBe(true);
    expect(typeof team.loss === 'number').toBe(true);
    expect(typeof team.unavailable === 'boolean').toBe(true);
  }, 15000);
});
