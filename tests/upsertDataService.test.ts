import { afterAll, beforeAll, describe, test } from '@jest/globals';
import { Server } from 'http';
import { prisma } from '../src';
import { supabase } from '../src/configs/supabase.config';
import { upsertStaticData } from '../src/services/upsertDataService';
import { createEventsTable } from './setupDatabase.test';

describe('upsertStaticData', () => {
  let server: Server;

  beforeAll(async () => {
    try {
      await createEventsTable();
      console.log('Database setup completed');
    } catch (error) {
      console.error('Database setup error:', error);
      throw error;
    }
  });

  beforeEach(() => {
    jest.setTimeout(5000000);
  });

  afterEach(async () => {
    if (server) {
      await server.close();
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  test('should upsert bootstrap static data to both Prisma and Supabase', async () => {
    try {
      await upsertStaticData();

      const prismaEvents = await prisma.event.findMany();
      expect(prismaEvents.length).toBeGreaterThan(0);

      const { data: supabaseEvents, error } = await supabase.from('events').select('*');
      if (error) throw error;

      expect(supabaseEvents).toBeDefined();
      expect(supabaseEvents.length).toBe(prismaEvents.length);

      const firstPrismaEvent = prismaEvents[0];
      const firstSupabaseEvent = supabaseEvents[0];

      expect(firstSupabaseEvent.id).toBe(firstPrismaEvent.id);
      expect(firstSupabaseEvent.name).toBe(firstPrismaEvent.name);
      expect(new Date(firstSupabaseEvent.deadline_time)).toEqual(firstPrismaEvent.deadlineTime);
    } catch (error) {
      console.error('Error during upsert:', error);
      throw error;
    }
  });

  test('should handle nullable fields correctly', async () => {
    await upsertStaticData();
    const prismaEvents = await prisma.event.findMany();
    const event = prismaEvents[0];

    // These should not throw type errors
    expect(event.mostSelected).toBeDefined();
    expect(typeof event.mostSelected === 'number' || event.mostSelected === null).toBe(true);
    expect(typeof event.topElement === 'number' || event.topElement === null).toBe(true);
    expect(event.chipPlays === null || Array.isArray(event.chipPlays)).toBe(true);
  });
});
