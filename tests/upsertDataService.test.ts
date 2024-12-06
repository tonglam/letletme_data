import { afterAll, beforeAll, describe, test } from '@jest/globals';
import { prisma, startServer, stopServer } from '../src';
import { supabase } from '../src/configs/supabase.config';
import { upsertStaticData } from '../src/services/upsertDataService';
import { createEventsTable, createTeamsTable } from './setupDatabase.test';

describe('upsertStaticData', () => {
  beforeAll(async () => {
    try {
      startServer(0);
      await createEventsTable();
      await createTeamsTable();
      console.log('Database setup completed');
    } catch (error) {
      console.error('Database setup error:', error);
      throw error;
    }
  });

  afterEach(async () => {
    await stopServer();
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await supabase.auth.signOut();
    await new Promise<void>((resolve) => setTimeout(() => resolve(), 100));
  });

  test('should upsert bootstrap static data to both Prisma and Supabase', async () => {
    try {
      await upsertStaticData();

      // Test Events
      const prismaEvents = await prisma.event.findMany();
      expect(prismaEvents.length).toBeGreaterThan(0);

      const { data: supabaseEvents, error: eventsError } = await supabase
        .from('events')
        .select('*');
      if (eventsError) throw eventsError;

      expect(supabaseEvents).toBeDefined();
      expect(supabaseEvents.length).toBe(prismaEvents.length);

      const firstPrismaEvent = prismaEvents[0];
      const firstSupabaseEvent = supabaseEvents[0];

      expect(firstSupabaseEvent.id).toBe(firstPrismaEvent.id);
      expect(firstSupabaseEvent.name).toBe(firstPrismaEvent.name);
      expect(new Date(firstSupabaseEvent.deadline_time)).toEqual(firstPrismaEvent.deadlineTime);

      // Test Teams
      const prismaTeams = await prisma.team.findMany();
      expect(prismaTeams.length).toBeGreaterThan(0);

      const { data: supabaseTeams, error: teamsError } = await supabase.from('teams').select('*');
      if (teamsError) throw teamsError;

      expect(supabaseTeams).toBeDefined();
      expect(supabaseTeams.length).toBe(prismaTeams.length);

      const firstPrismaTeam = prismaTeams[0];
      const firstSupabaseTeam = supabaseTeams[0];

      // Test team fields match
      expect(firstSupabaseTeam.id).toBe(firstPrismaTeam.id);
      expect(firstSupabaseTeam.code).toBe(firstPrismaTeam.code);
      expect(firstSupabaseTeam.name).toBe(firstPrismaTeam.name);
      expect(firstSupabaseTeam.strength).toBe(firstPrismaTeam.strength);
      expect(firstSupabaseTeam.pulse_id).toBe(firstPrismaTeam.pulseId);
    } finally {
      // Wait for fetch connections to close
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  });

  test('should handle nullable fields correctly for teams', async () => {
    try {
      await upsertStaticData();
      const prismaTeams = await prisma.team.findMany();
      const team = prismaTeams[0];

      // Test nullable fields
      expect(typeof team.form === 'string' || team.form === null).toBe(true);
      expect(typeof team.teamDivision === 'string' || team.teamDivision === null).toBe(true);

      // Test default values
      expect(typeof team.played === 'number').toBe(true);
      expect(typeof team.position === 'number').toBe(true);
      expect(typeof team.points === 'number').toBe(true);
      expect(typeof team.win === 'number').toBe(true);
      expect(typeof team.draw === 'number').toBe(true);
      expect(typeof team.loss === 'number').toBe(true);
      expect(typeof team.unavailable === 'boolean').toBe(true);
    } finally {
      // Wait for fetch connections to close
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  });
});
